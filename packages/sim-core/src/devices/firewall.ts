import { IpProtocol } from "@sim/contracts";
import type { Ipv4Packet } from "../packets/ipv4";
import type {
  Ipv4AddressMatcher,
  PolicyProtocol,
  PortMatcher,
} from "../policy/packet-policy-engine";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import type { L3Interface } from "./router";
import { Router } from "./router";

export const FIREWALL_RESOURCE_LIMITS = Object.freeze({
  maximumZones: 32,
  maximumPolicyRules: 256,
  maximumConnections: 1_024,
  tcpTimeoutNs: 300_000_000_000,
  udpTimeoutNs: 60_000_000_000,
  icmpTimeoutNs: 30_000_000_000,
  closingTimeoutNs: 5_000_000_000,
});

export type FirewallAction = "permit" | "deny";
export type FirewallConnectionState = "NEW" | "ESTABLISHED" | "RELATED" | "CLOSING" | "EXPIRED";

export interface FirewallPolicyRule {
  readonly id: string;
  readonly sequence: number;
  readonly sourceZone: string | "*";
  readonly destinationZone: string | "*";
  readonly action: FirewallAction;
  readonly protocol: PolicyProtocol;
  readonly source?: Ipv4AddressMatcher;
  readonly destination?: Ipv4AddressMatcher;
  readonly sourcePort?: PortMatcher;
  readonly destinationPort?: PortMatcher;
  readonly states?: readonly FirewallConnectionState[];
}

export interface FirewallConnection {
  readonly id: string;
  readonly protocol: IpProtocol;
  readonly sourceZone: string;
  readonly destinationZone: string;
  readonly sourceAddress: Ipv4;
  readonly destinationAddress: Ipv4;
  readonly sourceToken: number | undefined;
  readonly destinationToken: number | undefined;
  readonly state: FirewallConnectionState;
  readonly createdAtNs: number;
  readonly lastSeenAtNs: number;
  readonly expiresAtNs: number;
}

interface MutableFirewallConnection extends Omit<FirewallConnection, "state" | "lastSeenAtNs" | "expiresAtNs"> {
  state: FirewallConnectionState;
  lastSeenAtNs: number;
  expiresAtNs: number;
}

export type FirewallErrorCode =
  | "FIREWALL_INVALID_CONFIGURATION"
  | "FIREWALL_ZONE_LIMIT"
  | "FIREWALL_RULE_LIMIT"
  | "FIREWALL_CONNECTION_LIMIT";

export class FirewallError extends Error {
  override readonly name = "FirewallError";

  constructor(
    readonly code: FirewallErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * SimulatorNet stateful routed firewall. It intentionally does not claim
 * compatibility with a vendor appliance CLI.
 */
export class Firewall extends Router {
  override readonly deviceType = "firewall" as const;
  private readonly zones = new Map<string, string>();
  private readonly policies = new Map<string, FirewallPolicyRule>();
  private readonly connections = new Map<string, MutableFirewallConnection>();
  private readonly tupleIndex = new Map<string, string>();
  private readonly policyCounters = new Map<string, number>();
  private connectionSerial = 0;
  private defaultAction: FirewallAction = "deny";

  setZone(interfaceName: string, zone: string): void {
    if (!this.l3Interfaces.some((iface) => iface.name === interfaceName)) {
      throw new FirewallError(
        "FIREWALL_INVALID_CONFIGURATION",
        `Firewall ${this.id} has no L3 interface ${interfaceName}.`,
      );
    }
    const normalized = zone.trim().toLowerCase();
    if (!normalized) {
      throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", "Firewall zone name is required.");
    }
    const distinct = new Set(this.zones.values());
    if (!this.zones.has(interfaceName) && !distinct.has(normalized)
      && distinct.size >= FIREWALL_RESOURCE_LIMITS.maximumZones) {
      throw new FirewallError(
        "FIREWALL_ZONE_LIMIT",
        `Firewall zone limit exceeded (${FIREWALL_RESOURCE_LIMITS.maximumZones}).`,
      );
    }
    this.zones.set(interfaceName, normalized);
  }

  removeZone(interfaceName: string): void {
    this.zones.delete(interfaceName);
  }

  zoneConfigurations(): Array<{ interfaceName: string; zone: string }> {
    return [...this.zones.entries()]
      .map(([interfaceName, zone]) => ({ interfaceName, zone }))
      .sort((a, b) => a.interfaceName.localeCompare(b.interfaceName));
  }

  setDefaultPolicy(action: FirewallAction): void {
    this.defaultAction = action;
  }

  get defaultPolicy(): FirewallAction {
    return this.defaultAction;
  }

  definePolicy(rule: FirewallPolicyRule): void {
    validatePolicy(rule);
    if (!this.policies.has(rule.id) && this.policies.size >= FIREWALL_RESOURCE_LIMITS.maximumPolicyRules) {
      throw new FirewallError(
        "FIREWALL_RULE_LIMIT",
        `Firewall policy limit exceeded (${FIREWALL_RESOURCE_LIMITS.maximumPolicyRules}).`,
      );
    }
    for (const existing of this.policies.values()) {
      if (existing.id !== rule.id && existing.sequence === rule.sequence) {
        throw new FirewallError(
          "FIREWALL_INVALID_CONFIGURATION",
          `Duplicate firewall policy sequence ${rule.sequence}.`,
        );
      }
    }
    this.policies.set(rule.id, clonePolicy(rule));
    this.policyCounters.delete(rule.id);
  }

  removePolicy(ruleId: string): void {
    this.policies.delete(ruleId);
    this.policyCounters.delete(ruleId);
  }

  policyConfigurations(): FirewallPolicyRule[] {
    return this.orderedPolicies().map(clonePolicy);
  }

  policyCounterSummaries(): Array<{ ruleId: string; matches: number }> {
    return [...this.policyCounters.entries()]
      .map(([ruleId, matches]) => ({ ruleId, matches }))
      .sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  }

  connectionTable(): FirewallConnection[] {
    this.expireConnections(this.engine.now());
    return [...this.connections.values()]
      .map((connection) => ({ ...connection }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  markConnectionRelated(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.state === "EXPIRED") {
      throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", `Active connection '${connectionId}' was not found.`);
    }
    connection.state = "RELATED";
    this.refreshConnection(connection, this.engine.now());
  }

  resetSecurityRuntime(): void {
    this.connections.clear();
    this.tupleIndex.clear();
    this.policyCounters.clear();
    this.connectionSerial = 0;
    this.resetAclCounters();
    this.resetNatRuntime();
  }

  protected override permitForward(
    packet: Ipv4Packet,
    ingress: L3Interface,
    egress: L3Interface,
  ): boolean {
    const nowNs = this.engine.now();
    this.expireConnections(nowNs);
    const sourceZone = this.zones.get(ingress.name);
    const destinationZone = this.zones.get(egress.name);
    if (!sourceZone || !destinationZone) {
      this.traceFirewall("firewall-denied", packet, {
        sourceZone: sourceZone ?? "unassigned",
        destinationZone: destinationZone ?? "unassigned",
        reason: "zone-unassigned",
      });
      return false;
    }

    const tuple = connectionTuple(packet);
    const connectionId = this.tupleIndex.get(tuple.key);
    const existing = connectionId ? this.connections.get(connectionId) : undefined;
    if (existing && existing.state !== "EXPIRED") {
      if (tuple.key === reverseTuple(existing)) existing.state = "ESTABLISHED";
      if (packet.payload.kind === "tcp" && packet.payload.fin) existing.state = "CLOSING";
      this.refreshConnection(existing, nowNs);
      this.traceFirewall("firewall-permitted", packet, {
        sourceZone,
        destinationZone,
        state: existing.state,
        connectionId: existing.id,
        reason: "stateful-return",
      });
      return true;
    }

    const policy = this.orderedPolicies().find((rule) =>
      matchesPolicy(rule, packet, sourceZone, destinationZone, "NEW"));
    const action = policy?.action ?? this.defaultAction;
    if (policy) this.policyCounters.set(policy.id, (this.policyCounters.get(policy.id) ?? 0) + 1);
    if (action === "deny") {
      this.traceFirewall("firewall-denied", packet, {
        sourceZone,
        destinationZone,
        state: "NEW",
        ruleId: policy?.id ?? null,
        reason: policy ? "policy" : "default-policy",
      });
      return false;
    }

    const connection = this.createConnection(packet, sourceZone, destinationZone, nowNs);
    this.traceFirewall("firewall-permitted", packet, {
      sourceZone,
      destinationZone,
      state: connection.state,
      connectionId: connection.id,
      ruleId: policy?.id ?? null,
      reason: policy ? "policy" : "default-policy",
    });
    return true;
  }

  private orderedPolicies(): FirewallPolicyRule[] {
    return [...this.policies.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }

  private createConnection(
    packet: Ipv4Packet,
    sourceZone: string,
    destinationZone: string,
    nowNs: number,
  ): MutableFirewallConnection {
    this.removeOldestExpiredConnections();
    const active = [...this.connections.values()].filter((connection) => connection.state !== "EXPIRED").length;
    if (active >= FIREWALL_RESOURCE_LIMITS.maximumConnections) {
      throw new FirewallError(
        "FIREWALL_CONNECTION_LIMIT",
        `Firewall connection limit exceeded (${FIREWALL_RESOURCE_LIMITS.maximumConnections}).`,
      );
    }
    const tuple = connectionTuple(packet);
    const connection: MutableFirewallConnection = {
      id: `fw-${++this.connectionSerial}`,
      protocol: packet.protocol,
      sourceZone,
      destinationZone,
      sourceAddress: packet.src,
      destinationAddress: packet.dst,
      sourceToken: tuple.sourceToken,
      destinationToken: tuple.destinationToken,
      state: "NEW",
      createdAtNs: nowNs,
      lastSeenAtNs: nowNs,
      expiresAtNs: nowNs + this.timeoutFor(packet.protocol, "NEW"),
    };
    this.connections.set(connection.id, connection);
    this.tupleIndex.set(tuple.key, connection.id);
    this.tupleIndex.set(reverseTuple(connection), connection.id);
    return connection;
  }

  private refreshConnection(connection: MutableFirewallConnection, nowNs: number): void {
    connection.lastSeenAtNs = nowNs;
    connection.expiresAtNs = nowNs + this.timeoutFor(connection.protocol, connection.state);
  }

  private expireConnections(nowNs: number): void {
    for (const connection of this.connections.values()) {
      if (connection.state === "EXPIRED" || connection.expiresAtNs > nowNs) continue;
      this.tupleIndex.delete(forwardTuple(connection));
      this.tupleIndex.delete(reverseTuple(connection));
      connection.state = "EXPIRED";
      connection.lastSeenAtNs = nowNs;
      connection.expiresAtNs = nowNs;
      this.traceFirewall("firewall-connection-expired", undefined, {
        connectionId: connection.id,
      });
    }
  }

  private removeOldestExpiredConnections(): void {
    if (this.connections.size < FIREWALL_RESOURCE_LIMITS.maximumConnections) return;
    const expired = [...this.connections.values()]
      .filter((connection) => connection.state === "EXPIRED")
      .sort((a, b) => a.createdAtNs - b.createdAtNs || a.id.localeCompare(b.id));
    for (const connection of expired) {
      this.connections.delete(connection.id);
      if (this.connections.size < FIREWALL_RESOURCE_LIMITS.maximumConnections) break;
    }
  }

  private timeoutFor(protocol: IpProtocol, state: FirewallConnectionState): number {
    if (state === "CLOSING") return FIREWALL_RESOURCE_LIMITS.closingTimeoutNs;
    if (protocol === IpProtocol.TCP) return FIREWALL_RESOURCE_LIMITS.tcpTimeoutNs;
    if (protocol === IpProtocol.UDP) return FIREWALL_RESOURCE_LIMITS.udpTimeoutNs;
    return FIREWALL_RESOURCE_LIMITS.icmpTimeoutNs;
  }

  private traceFirewall(
    type: string,
    packet: Ipv4Packet | undefined,
    detail: Record<string, unknown>,
  ): void {
    this.engine.trace({
      time: this.engine.now(),
      type,
      device: this.id,
      detail: packet
        ? {
            ...detail,
            source: packet.src,
            destination: packet.dst,
            protocol: packet.protocol,
          }
        : detail,
    });
  }
}

function matchesPolicy(
  rule: FirewallPolicyRule,
  packet: Ipv4Packet,
  sourceZone: string,
  destinationZone: string,
  state: FirewallConnectionState,
): boolean {
  if (rule.sourceZone !== "*" && rule.sourceZone.toLowerCase() !== sourceZone) return false;
  if (rule.destinationZone !== "*" && rule.destinationZone.toLowerCase() !== destinationZone) return false;
  if (rule.protocol !== "ip" && rule.protocol !== packet.protocol) return false;
  if (rule.states && !rule.states.includes(state)) return false;
  if (rule.source && !matchesAddress(rule.source, packet.src)) return false;
  if (rule.destination && !matchesAddress(rule.destination, packet.dst)) return false;
  if (!rule.sourcePort && !rule.destinationPort) return true;
  if (packet.payload.kind !== "tcp" && packet.payload.kind !== "udp") return false;
  return matchesPort(rule.sourcePort, packet.payload.srcPort)
    && matchesPort(rule.destinationPort, packet.payload.dstPort);
}

function matchesAddress(matcher: Ipv4AddressMatcher, address: Ipv4): boolean {
  if (matcher.kind === "any") return true;
  if (matcher.kind === "host") return ipToInt(matcher.address) === ipToInt(address);
  const mask = (~ipToInt(matcher.wildcard)) >>> 0;
  return ((ipToInt(address) & mask) >>> 0) === ((ipToInt(matcher.address) & mask) >>> 0);
}

function matchesPort(matcher: PortMatcher | undefined, port: number): boolean {
  if (!matcher || matcher.kind === "any") return true;
  if (matcher.kind === "eq") return port === matcher.port;
  return port >= matcher.start && port <= matcher.end;
}

function connectionTuple(packet: Ipv4Packet): {
  key: string;
  sourceToken: number | undefined;
  destinationToken: number | undefined;
} {
  const sourceToken = transportToken(packet, "source");
  const destinationToken = transportToken(packet, "destination");
  return {
    key: tupleKey(packet.protocol, packet.src, sourceToken, packet.dst, destinationToken),
    sourceToken,
    destinationToken,
  };
}

function transportToken(packet: Ipv4Packet, side: "source" | "destination"): number | undefined {
  if (packet.payload.kind === "tcp" || packet.payload.kind === "udp") {
    return side === "source" ? packet.payload.srcPort : packet.payload.dstPort;
  }
  if (packet.payload.kind === "icmp") return packet.payload.identifier;
  return undefined;
}

function forwardTuple(connection: FirewallConnection): string {
  return tupleKey(
    connection.protocol,
    connection.sourceAddress,
    connection.sourceToken,
    connection.destinationAddress,
    connection.destinationToken,
  );
}

function reverseTuple(connection: FirewallConnection): string {
  return tupleKey(
    connection.protocol,
    connection.destinationAddress,
    connection.destinationToken,
    connection.sourceAddress,
    connection.sourceToken,
  );
}

function tupleKey(
  protocol: IpProtocol,
  source: Ipv4,
  sourceToken: number | undefined,
  destination: Ipv4,
  destinationToken: number | undefined,
): string {
  return [protocol, source, sourceToken ?? -1, destination, destinationToken ?? -1].join("\u0000");
}

function validatePolicy(rule: FirewallPolicyRule): void {
  if (!rule.id.trim()) throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", "Firewall policy ID is required.");
  if (!Number.isSafeInteger(rule.sequence) || rule.sequence < 0) {
    throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", "Firewall policy sequence must be non-negative.");
  }
  if (!rule.sourceZone.trim() || !rule.destinationZone.trim()) {
    throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", "Firewall policy zones are required.");
  }
  if (rule.protocol !== "ip"
    && rule.protocol !== IpProtocol.ICMP
    && rule.protocol !== IpProtocol.TCP
    && rule.protocol !== IpProtocol.UDP) {
    throw new FirewallError("FIREWALL_INVALID_CONFIGURATION", "Unsupported firewall protocol.");
  }
  if (rule.protocol !== IpProtocol.TCP && rule.protocol !== IpProtocol.UDP
    && (rule.sourcePort || rule.destinationPort)) {
    throw new FirewallError(
      "FIREWALL_INVALID_CONFIGURATION",
      "Firewall port matchers require TCP or UDP.",
    );
  }
}

function clonePolicy(rule: FirewallPolicyRule): FirewallPolicyRule {
  return {
    ...rule,
    source: rule.source ? { ...rule.source } : undefined,
    destination: rule.destination ? { ...rule.destination } : undefined,
    sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
    destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
    states: rule.states ? [...rule.states] : undefined,
  };
}
