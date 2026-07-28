import {
  SNMP_AGENT_PORT,
  SNMP_LIMITS,
  type NetworkManagementServiceConfig,
  type NmsTargetConfig,
  type SnmpTrapType,
} from "@sim/contracts";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { HostTransportStack } from "../transport/host-transport";
import type { IpAddress } from "../util/ip-address";
import { NS_PER_S } from "../engine/constants";
import { compareOids, isValidOid, type SnmpVarBind } from "./snmp-mib";
import type { SnmpMessage } from "./snmp-messages";

/** One received trap. Runtime only: never serialized into a LabDocument. */
export interface NmsTrapEntry {
  readonly sequence: number;
  readonly receivedAtNs: number;
  readonly sourceAddress: IpAddress;
  readonly sourceDeviceId: string | undefined;
  readonly sourceName: string | undefined;
  readonly trapType: SnmpTrapType;
  readonly sysUpTime: number;
  readonly varBinds: SnmpVarBind[];
}

export type SnmpOperation = "get" | "getnext" | "walk";

export interface SnmpPollResult {
  readonly requestId: number;
  readonly operation: SnmpOperation;
  readonly targetAddress: IpAddress;
  readonly rootOid: string;
  readonly status: "completed" | "timeout" | "invalid-community" | "invalid-oid";
  readonly varBinds: SnmpVarBind[];
  readonly completedAtNs: number;
}

export interface NmsRuntimeSnapshot {
  readonly targets: NmsTargetConfig[];
  readonly traps: NmsTrapEntry[];
  readonly results: SnmpPollResult[];
}

interface NmsHost {
  readonly deviceId: string;
  readonly engine: () => SimulationEngine;
  readonly transport: HostTransportStack;
}

interface PendingRequest {
  readonly requestId: number;
  readonly operation: SnmpOperation;
  readonly targetAddress: IpAddress;
  readonly rootOid: string;
  readonly port: number;
  readonly communityFingerprint: string | undefined;
  readonly collected: SnmpVarBind[];
  cursor: string;
  steps: number;
  settled: boolean;
}

const SNMP_REQUEST_TIMEOUT_NS = 3 * NS_PER_S;

/**
 * The Server "Network Management" service: an SNMP manager plus a trap
 * receiver.
 *
 * A WALK is a bounded sequence of GETNEXT requests over the simulated UDP
 * stack, exactly as a real manager would do it — never a privileged read of
 * another device's internal state.
 */
export class NetworkManagementService {
  private config: NetworkManagementServiceConfig | undefined;
  private readonly traps: NmsTrapEntry[] = [];
  private readonly results: SnmpPollResult[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  private clientPort: number | undefined;
  private trapSequence = 0;
  private requestId = 0;
  private runtimeGeneration = 0;

  constructor(private readonly host: NmsHost) {}

  configure(config: NetworkManagementServiceConfig): void {
    this.config = config;
  }

  get targets(): readonly NmsTargetConfig[] {
    return this.config?.targets ?? [];
  }

  targetByName(name: string): NmsTargetConfig | undefined {
    return this.targets.find((target) => target.name === name || target.id === name);
  }

  runtimeSnapshot(): NmsRuntimeSnapshot {
    return {
      targets: this.targets.map((target) => ({ ...target })),
      traps: this.traps.map((entry) => ({ ...entry, varBinds: entry.varBinds.map((bind) => ({ ...bind })) })),
      results: this.results.map((result) => ({ ...result, varBinds: result.varBinds.map((bind) => ({ ...bind })) })),
    };
  }

  clearTraps(): void {
    this.traps.length = 0;
    this.trapSequence = 0;
  }

  clearResults(): void {
    this.results.length = 0;
  }

  /** Drop transient state after the host address changed or the lab restarted. */
  resetRuntime(): void {
    this.runtimeGeneration++;
    this.pending.clear();
    this.clientPort = undefined;
    this.clearTraps();
    this.clearResults();
  }

  /** Bind the trap receiver. Called when the service starts listening. */
  listen(port: number): void {
    this.host.transport.udp.bind(port, (received) => this.onTrap(received.sourceAddress, received.payload), "snmp-trap");
  }

  unlisten(port: number): void {
    this.host.transport.udp.unbind(port);
  }

  /**
   * Start a GET, GETNEXT or WALK against a target. The result arrives through
   * `runtimeSnapshot()` once the deterministic event queue has drained.
   */
  poll(target: NmsTargetConfig, operation: SnmpOperation, oid: string): number {
    const requestId = ++this.requestId;
    if (!isValidOid(oid)) {
      this.finish({
        requestId,
        operation,
        targetAddress: target.address,
        rootOid: oid,
        status: "invalid-oid",
        varBinds: [],
        completedAtNs: this.host.engine().now(),
      });
      return requestId;
    }
    const request: PendingRequest = {
      requestId,
      operation,
      targetAddress: target.address,
      rootOid: oid,
      port: target.port ?? SNMP_AGENT_PORT,
      communityFingerprint: target.communityFingerprint,
      collected: [],
      cursor: oid,
      steps: 0,
      settled: false,
    };
    this.pending.set(requestId, request);
    this.send(request, operation === "get" ? "GET" : "GETNEXT", oid);
    return requestId;
  }

  private send(request: PendingRequest, pdu: "GET" | "GETNEXT", oid: string): void {
    const generation = this.runtimeGeneration;
    const port = this.ensureClientSocket();
    this.host.transport.udp.send({
      destinationAddress: request.targetAddress,
      destinationPort: request.port,
      sourcePort: port,
      payload: {
        kind: "snmp",
        pdu,
        version: "2c",
        requestId: request.requestId,
        communityFingerprint: request.communityFingerprint,
        varBinds: [{ oid, type: "OctetString", value: "" }],
      },
    });
    this.host.engine().scheduleIn(SNMP_REQUEST_TIMEOUT_NS, () => {
      if (generation !== this.runtimeGeneration || request.settled) return;
      request.settled = true;
      this.pending.delete(request.requestId);
      this.finish({
        requestId: request.requestId,
        operation: request.operation,
        targetAddress: request.targetAddress,
        rootOid: request.rootOid,
        status: "timeout",
        varBinds: request.collected,
        completedAtNs: this.host.engine().now(),
      });
    });
  }

  private ensureClientSocket(): number {
    if (this.clientPort !== undefined) return this.clientPort;
    this.clientPort = this.host.transport.udp.bind(0, (received) => {
      if (received.payload.kind !== "snmp") return;
      this.onResponse(received.payload);
    }, "snmp-manager");
    return this.clientPort;
  }

  private onResponse(message: SnmpMessage): void {
    const request = this.pending.get(message.requestId);
    if (!request || request.settled) return;
    if (message.pdu === "ERROR") {
      request.settled = true;
      this.pending.delete(request.requestId);
      this.finish({
        requestId: request.requestId,
        operation: request.operation,
        targetAddress: request.targetAddress,
        rootOid: request.rootOid,
        status: message.errorStatus === "authorizationError" ? "invalid-community" : "timeout",
        varBinds: [],
        completedAtNs: this.host.engine().now(),
      });
      return;
    }
    if (message.pdu !== "RESPONSE") return;
    const received = message.varBinds.filter((bind) => bind.value !== "endOfMibView");
    request.collected.push(...received);
    const last = received.at(-1);
    const walkContinues = request.operation === "walk"
      && last !== undefined
      && request.steps < SNMP_LIMITS.maximumWalkLength
      && oidUnderRoot(last.oid, request.rootOid)
      && compareOids(last.oid, request.cursor) > 0;
    if (walkContinues) {
      request.cursor = last.oid;
      request.steps++;
      this.send(request, "GETNEXT", last.oid);
      return;
    }
    request.settled = true;
    this.pending.delete(request.requestId);
    // A WALK stops at the first OID outside its root subtree.
    const varBinds = request.operation === "walk"
      ? request.collected.filter((bind) => oidUnderRoot(bind.oid, request.rootOid))
      : request.collected;
    this.finish({
      requestId: request.requestId,
      operation: request.operation,
      targetAddress: request.targetAddress,
      rootOid: request.rootOid,
      status: "completed",
      varBinds,
      completedAtNs: this.host.engine().now(),
    });
  }

  private onTrap(sourceAddress: IpAddress, payload: unknown): void {
    if (typeof payload !== "object" || payload === null) return;
    const message = payload as SnmpMessage;
    if (message.kind !== "snmp" || message.pdu !== "TRAP" || !message.trapType) return;
    if (this.config?.restrictTrapsToTargets
      && !this.targets.some((target) => target.enabled && target.address === sourceAddress)) {
      return;
    }
    this.traps.push({
      sequence: ++this.trapSequence,
      receivedAtNs: this.host.engine().now(),
      sourceAddress,
      sourceDeviceId: message.sourceDeviceId,
      sourceName: message.sourceName,
      trapType: message.trapType,
      sysUpTime: message.sysUpTime ?? 0,
      varBinds: message.varBinds.map((bind) => ({ ...bind })),
    });
    if (this.traps.length > SNMP_LIMITS.maximumStoredTraps) {
      this.traps.splice(0, this.traps.length - SNMP_LIMITS.maximumStoredTraps);
    }
    const engine = this.host.engine();
    engine.trace({
      time: engine.now(),
      type: "snmp-trap-received",
      device: this.host.deviceId,
      detail: { trapType: message.trapType, source: message.sourceName ?? sourceAddress },
    });
  }

  private finish(result: SnmpPollResult): void {
    this.results.push(result);
    if (this.results.length > SNMP_LIMITS.maximumPollingTargets * 4) {
      this.results.splice(0, this.results.length - SNMP_LIMITS.maximumPollingTargets * 4);
    }
    const engine = this.host.engine();
    engine.trace({
      time: engine.now(),
      type: "snmp-poll-complete",
      device: this.host.deviceId,
      detail: {
        operation: result.operation,
        target: result.targetAddress,
        status: result.status,
        values: result.varBinds.length,
      },
    });
  }
}

function oidUnderRoot(oid: string, root: string): boolean {
  return oid === root || oid.startsWith(`${root}.`);
}
