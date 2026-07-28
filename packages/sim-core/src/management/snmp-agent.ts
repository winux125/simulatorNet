import {
  DEFAULT_SNMP_AGENT_CONFIGURATION,
  SNMP_AGENT_PORT,
  SNMP_LIMITS,
  SNMP_TRAP_PORT,
  type SnmpAgentConfiguration,
  type SnmpTrapType,
} from "@sim/contracts";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { HostTransportStack } from "../transport/host-transport";
import type { IpAddress } from "../util/ip-address";
import {
  compareOids,
  isValidOid,
  mibVarBinds,
  oidStartsWith,
  SNMP_OID,
  toTimeTicks,
  type SnmpMibSource,
  type SnmpVarBind,
} from "./snmp-mib";
import type { SnmpMessage } from "./snmp-messages";

interface SnmpAgentHost {
  readonly deviceId: string;
  readonly engine: () => SimulationEngine;
  readonly transport: () => HostTransportStack;
  readonly mib: () => SnmpMibSource;
}

/**
 * The SNMPv2c agent of one managed device.
 *
 * It answers GET/GETNEXT over the shared UDP stack and emits traps to
 * configured destinations. Everything it reports comes from the built-in MIB,
 * which reads only state the engine models. A community string never appears
 * here in the clear: requests carry an opaque fingerprint that is compared
 * against the configured one.
 */
export class SnmpAgent {
  private config: SnmpAgentConfiguration = { ...DEFAULT_SNMP_AGENT_CONFIGURATION };
  private listening = false;
  private trapsThisOperation = 0;
  private started = false;

  constructor(private readonly host: SnmpAgentHost) {}

  snapshot(): SnmpAgentConfiguration {
    return {
      enabled: this.config.enabled,
      communities: this.config.communities.map((entry) => ({ ...entry })),
      location: this.config.location,
      contact: this.config.contact,
      trapsEnabled: this.config.trapsEnabled,
      trapDestinations: this.config.trapDestinations.map((entry) => ({ ...entry })),
      enabledTrapTypes: [...this.config.enabledTrapTypes],
    };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get location(): string | undefined {
    return this.config.location;
  }

  get contact(): string | undefined {
    return this.config.contact;
  }

  configure(config: SnmpAgentConfiguration | undefined): void {
    this.config = normalizeSnmpAgentConfiguration(config ?? DEFAULT_SNMP_AGENT_CONFIGURATION);
    this.rearm();
  }

  setLocation(location: string | undefined): void {
    this.config = { ...this.config, location };
  }

  setContact(contact: string | undefined): void {
    this.config = { ...this.config, contact };
  }

  /** `snmp-server community <input> ro`; only the fingerprint is stored. */
  addCommunity(entry: SnmpAgentConfiguration["communities"][number]): void {
    const others = this.config.communities.filter((candidate) => candidate.id !== entry.id);
    if (others.length >= SNMP_LIMITS.maximumCommunitiesPerAgent) {
      throw new Error(`SNMP community limit exceeded (${SNMP_LIMITS.maximumCommunitiesPerAgent})`);
    }
    this.config = { ...this.config, enabled: true, communities: sortById([...others, entry]) };
    this.rearm();
  }

  removeCommunity(id: string): boolean {
    const remaining = this.config.communities.filter((entry) => entry.id !== id);
    if (remaining.length === this.config.communities.length) return false;
    this.config = { ...this.config, communities: remaining };
    this.rearm();
    return true;
  }

  addTrapDestination(entry: SnmpAgentConfiguration["trapDestinations"][number]): void {
    const others = this.config.trapDestinations.filter((candidate) => candidate.id !== entry.id);
    if (others.length >= SNMP_LIMITS.maximumTrapDestinationsPerAgent) {
      throw new Error(`SNMP trap destination limit exceeded (${SNMP_LIMITS.maximumTrapDestinationsPerAgent})`);
    }
    this.config = { ...this.config, trapDestinations: sortById([...others, entry]) };
  }

  removeTrapDestination(id: string): boolean {
    const remaining = this.config.trapDestinations.filter((entry) => entry.id !== id);
    if (remaining.length === this.config.trapDestinations.length) return false;
    this.config = { ...this.config, trapDestinations: remaining };
    return true;
  }

  setTrapsEnabled(enabled: boolean, types: readonly SnmpTrapType[] = []): void {
    this.config = { ...this.config, trapsEnabled: enabled, enabledTrapTypes: [...types] };
  }

  /** Fresh trap budget for one bounded operation, like the protocol budgets. */
  resetOperationBudget(): void {
    this.trapsThisOperation = 0;
  }

  /** Bind or unbind the agent socket after a configuration change. */
  private rearm(): void {
    const transport = this.host.transport();
    const shouldListen = this.config.enabled && this.config.communities.length > 0;
    if (this.listening && !shouldListen) {
      transport.udp.unbind(SNMP_AGENT_PORT);
      this.listening = false;
      return;
    }
    if (!this.listening && shouldListen) {
      try {
        transport.udp.bind(
          SNMP_AGENT_PORT,
          (received) => this.onRequest(received.sourceAddress, received.sourcePort, received.payload),
          "snmp",
        );
        this.listening = true;
      } catch {
        // The port is already bound (a rebuild raced a reconfigure): the
        // existing listener already serves this agent.
        this.listening = true;
      }
    }
  }

  /** `coldStart` once the lab starts running; sent at most once per build. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.emitTrap("coldStart", []);
  }

  private onRequest(sourceAddress: IpAddress, sourcePort: number, payload: unknown): void {
    if (!isSnmpMessage(payload)) return;
    if (payload.pdu !== "GET" && payload.pdu !== "GETNEXT") return;
    const community = this.matchCommunity(payload.communityFingerprint, sourceAddress);
    if (!community) {
      this.trace("snmp-authentication-failure", { sourceAddress, pdu: payload.pdu });
      this.emitTrap("authenticationFailure", [
        { oid: SNMP_OID.sysName, type: "OctetString", value: this.host.mib().hostname() },
      ]);
      this.reply(sourceAddress, sourcePort, {
        kind: "snmp",
        pdu: "ERROR",
        version: "2c",
        requestId: payload.requestId,
        errorStatus: "authorizationError",
        varBinds: [],
      });
      return;
    }
    const requested = payload.varBinds.slice(0, SNMP_LIMITS.maximumOidsPerRequest);
    const tree = mibVarBinds(this.host.mib());
    const varBinds: SnmpVarBind[] = [];
    let errorStatus: SnmpMessage["errorStatus"];
    for (const request of requested) {
      if (!isValidOid(request.oid)) {
        errorStatus = "genErr";
        break;
      }
      const resolved = payload.pdu === "GET"
        ? tree.find((entry) => entry.oid === request.oid)
        : tree.find((entry) => compareOids(entry.oid, request.oid) > 0);
      if (!resolved) {
        varBinds.push({ oid: request.oid, type: "OctetString", value: "endOfMibView" });
        continue;
      }
      varBinds.push(resolved);
    }
    this.trace("snmp-response", { sourceAddress, pdu: payload.pdu, count: varBinds.length });
    this.reply(sourceAddress, sourcePort, {
      kind: "snmp",
      pdu: errorStatus ? "ERROR" : "RESPONSE",
      version: "2c",
      requestId: payload.requestId,
      errorStatus,
      varBinds: errorStatus ? [] : varBinds,
    });
  }

  /**
   * Emit a trap to every enabled destination.
   *
   * Traps are bounded per operation so a flapping link cannot flood the lab,
   * and they never carry a community, password, shared key or command secret.
   */
  emitTrap(type: SnmpTrapType, varBinds: readonly SnmpVarBind[]): void {
    if (!this.config.enabled || !this.config.trapsEnabled) return;
    if (this.config.enabledTrapTypes.length > 0 && !this.config.enabledTrapTypes.includes(type)) return;
    if (this.trapsThisOperation >= SNMP_LIMITS.maximumTrapsPerOperation) return;
    const destinations = this.config.trapDestinations.filter((entry) => entry.enabled);
    if (destinations.length === 0) return;
    this.trapsThisOperation++;
    const mib = this.host.mib();
    for (const destination of destinations) {
      this.host.transport().udp.send({
        destinationAddress: destination.address,
        destinationPort: destination.port ?? SNMP_TRAP_PORT,
        payload: {
          kind: "snmp",
          pdu: "TRAP",
          version: "2c",
          requestId: 0,
          trapType: type,
          sysUpTime: toTimeTicks(mib.upTimeNs()),
          sourceDeviceId: this.host.deviceId,
          sourceName: mib.hostname(),
          communityFingerprint: destination.communityFingerprint,
          varBinds: [...varBinds],
        },
      });
    }
    this.trace("snmp-trap-sent", { trapType: type, destinations: destinations.length });
  }

  private matchCommunity(fingerprint: string | undefined, sourceAddress: IpAddress) {
    if (!fingerprint) return undefined;
    return this.config.communities.find((entry) =>
      entry.enabled
      && entry.fingerprint === fingerprint
      && (entry.managerAddress === undefined || entry.managerAddress === sourceAddress));
  }

  private reply(destinationAddress: IpAddress, destinationPort: number, payload: SnmpMessage): void {
    this.host.transport().udp.send({
      destinationAddress,
      destinationPort,
      sourcePort: SNMP_AGENT_PORT,
      payload,
    });
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.host.engine();
    engine.trace({ time: engine.now(), type, device: this.host.deviceId, detail });
  }
}

/**
 * Emit `linkUp`/`linkDown` for one interface. Bounded by the agent's own
 * per-operation trap budget, so a flapping port cannot flood a lab.
 */
export function emitLinkTrap(agent: SnmpAgent, interfaceName: string, operationalUp: boolean): void {
  if (!agent.enabled) return;
  agent.emitTrap(operationalUp ? "linkUp" : "linkDown", [
    { oid: SNMP_OID.ifDescr, type: "OctetString", value: interfaceName },
    { oid: SNMP_OID.ifOperStatus, type: "Integer", value: operationalUp ? 1 : 2 },
  ]);
}

function sortById<T extends { id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

export function normalizeSnmpAgentConfiguration(config: SnmpAgentConfiguration): SnmpAgentConfiguration {
  return {
    enabled: config.enabled,
    communities: sortById(config.communities).map((entry) => ({ ...entry })),
    location: config.location,
    contact: config.contact,
    trapsEnabled: config.trapsEnabled,
    trapDestinations: sortById(config.trapDestinations).map((entry) => ({ ...entry })),
    enabledTrapTypes: [...config.enabledTrapTypes].sort((a, b) => a.localeCompare(b)),
  };
}

/** True when SNMP was never configured, so it serializes as absent. */
export function isDefaultSnmpAgentConfiguration(config: SnmpAgentConfiguration | undefined): boolean {
  if (!config) return true;
  return !config.enabled
    && !config.trapsEnabled
    && config.communities.length === 0
    && config.trapDestinations.length === 0
    && config.enabledTrapTypes.length === 0
    && config.location === undefined
    && config.contact === undefined;
}

function isSnmpMessage(payload: unknown): payload is SnmpMessage {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "snmp"
    && typeof (payload as { pdu?: unknown }).pdu === "string"
    && Array.isArray((payload as { varBinds?: unknown }).varBinds);
}

export { isSnmpMessage, oidStartsWith };
