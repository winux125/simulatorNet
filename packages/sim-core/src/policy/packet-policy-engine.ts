import { IpProtocol } from "@sim/contracts";
import type { Ipv4Packet } from "../packets/ipv4";
import { Ipv6NextHeader, type Ipv6Packet } from "../packets/ipv6";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { ipv6InPrefix, normalizeIpv6, type Ipv6 } from "../util/ipv6";

export const ACL_RESOURCE_LIMITS = {
  maximumAclsPerDevice: 64,
  maximumRulesPerAcl: 256,
  maximumRulesPerLab: 2_048,
} as const;

export type AclAction = "permit" | "deny";
export type AclDirection = "in" | "out";

/**
 * Protocols an ACL, NAT rule or firewall policy can match. Deliberately not the
 * whole `IpProtocol` set: OSPF control traffic is terminated by the local
 * process before the policy pipeline and is never a policy subject.
 */
export type PolicyProtocol = "ip" | typeof IpProtocol.ICMP | typeof IpProtocol.TCP | typeof IpProtocol.UDP;
export type Ipv6PolicyProtocol =
  | "ipv6"
  | typeof Ipv6NextHeader.ICMPv6
  | typeof Ipv6NextHeader.TCP
  | typeof Ipv6NextHeader.UDP;

/** Narrow an IPv4 protocol number to the policy set; anything else is "ip". */
export function policyProtocolOf(protocol: IpProtocol): PolicyProtocol {
  return protocol === IpProtocol.ICMP || protocol === IpProtocol.TCP || protocol === IpProtocol.UDP
    ? protocol
    : "ip";
}

export type Ipv4AddressMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "host"; readonly address: Ipv4 }
  | {
      readonly kind: "network";
      readonly address: Ipv4;
      /** Cisco-style wildcard bits: zero bits must match, one bits are ignored. */
      readonly wildcard: Ipv4;
    };

export type PortMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "eq"; readonly port: number }
  | { readonly kind: "range"; readonly start: number; readonly end: number };

export interface StandardAclRule {
  readonly sequence: number;
  readonly action: AclAction;
  readonly source: Ipv4AddressMatcher;
}

export interface ExtendedAclRule {
  readonly sequence: number;
  readonly action: AclAction;
  /** `ip` matches every IPv4 protocol supported by the simulator. */
  readonly protocol: PolicyProtocol;
  readonly source: Ipv4AddressMatcher;
  readonly destination: Ipv4AddressMatcher;
  readonly sourcePort?: PortMatcher;
  readonly destinationPort?: PortMatcher;
}

export type Ipv4Acl =
  | {
      readonly id: string;
      readonly type: "standard";
      readonly rules: readonly StandardAclRule[];
    }
  | {
      readonly id: string;
      readonly type: "extended";
      readonly rules: readonly ExtendedAclRule[];
    };

export type Ipv6AddressMatcher =
  | { readonly kind: "any" }
  | { readonly kind: "host"; readonly address: Ipv6 }
  | { readonly kind: "prefix"; readonly address: Ipv6; readonly prefixLength: number };

export interface Ipv6AclRule {
  readonly sequence: number;
  readonly action: AclAction;
  readonly protocol: Ipv6PolicyProtocol;
  readonly source: Ipv6AddressMatcher;
  readonly destination: Ipv6AddressMatcher;
  readonly sourcePort?: PortMatcher;
  readonly destinationPort?: PortMatcher;
}

export interface Ipv6Acl {
  readonly id: string;
  readonly type: "ipv6";
  readonly rules: readonly Ipv6AclRule[];
}

export interface AclBinding {
  readonly interfaceName: string;
  readonly direction: AclDirection;
  readonly aclId: string;
}

export interface AclDecision {
  readonly aclId: string;
  readonly interfaceName: string;
  readonly direction: AclDirection;
  readonly action: AclAction;
  readonly sequence: number | undefined;
  readonly implicit: boolean;
}

export interface AclCounter {
  readonly aclId: string;
  readonly sequence: number | undefined;
  readonly action: AclAction;
  readonly matches: number;
}

export type PacketPolicyErrorCode =
  | "ACL_LIMIT_EXCEEDED"
  | "ACL_RULE_LIMIT_EXCEEDED"
  | "ACL_LAB_RULE_LIMIT_EXCEEDED"
  | "ACL_NOT_FOUND"
  | "ACL_INVALID_CONFIGURATION";

export class PacketPolicyError extends Error {
  override readonly name = "PacketPolicyError";

  constructor(
    readonly code: PacketPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Shared, deterministic resource accounting for all policy engines in one lab.
 * It deliberately contains no device references so a headless verifier can use
 * the exact same limit enforcement as a browser simulation.
 */
export class AclRuleBudget {
  private allocatedRules = 0;

  constructor(readonly maximumRules = ACL_RESOURCE_LIMITS.maximumRulesPerLab) {
    if (!Number.isInteger(maximumRules) || maximumRules < 0) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL rule budget must be a non-negative integer.");
    }
  }

  get usedRules(): number {
    return this.allocatedRules;
  }

  reserve(count: number): void {
    if (count <= 0) return;
    if (this.allocatedRules + count > this.maximumRules) {
      throw new PacketPolicyError(
        "ACL_LAB_RULE_LIMIT_EXCEEDED",
        `Lab ACL rule limit exceeded (${this.maximumRules}).`,
      );
    }
    this.allocatedRules += count;
  }

  release(count: number): void {
    if (count <= 0) return;
    this.allocatedRules = Math.max(0, this.allocatedRules - count);
  }
}

/**
 * Pure ordered IPv4 packet policy. It owns persistent ACL definitions and
 * bindings plus transient counters. It does not know about routing, NAT,
 * devices, clocks, tracing, the DOM, or Node APIs.
 */
export class PacketPolicyEngine {
  private readonly acls = new Map<string, Ipv4Acl>();
  private readonly bindings = new Map<string, AclBinding>();
  private readonly ipv6Acls = new Map<string, Ipv6Acl>();
  private readonly ipv6Bindings = new Map<string, AclBinding>();
  private readonly counters = new Map<string, number>();
  private budget: AclRuleBudget;

  constructor(budget = new AclRuleBudget()) {
    this.budget = budget;
  }

  useRuleBudget(budget: AclRuleBudget): void {
    if (budget === this.budget) return;
    const rules = this.ruleCount();
    budget.reserve(rules);
    this.budget.release(rules);
    this.budget = budget;
  }

  defineAcl(acl: Ipv4Acl): void {
    validateAcl(acl);
    const existing = this.acls.get(acl.id);
    if (!existing && this.acls.size + this.ipv6Acls.size >= ACL_RESOURCE_LIMITS.maximumAclsPerDevice) {
      throw new PacketPolicyError(
        "ACL_LIMIT_EXCEEDED",
        `Device ACL limit exceeded (${ACL_RESOURCE_LIMITS.maximumAclsPerDevice}).`,
      );
    }

    const priorRules = existing?.rules.length ?? 0;
    const nextRules = acl.rules.length;
    this.budget.reserve(nextRules - priorRules);
    this.acls.set(acl.id, cloneAndOrderAcl(acl));
    this.budget.release(priorRules - nextRules);
    this.clearAclCounters(acl.id);
  }

  defineIpv6Acl(acl: Ipv6Acl): void {
    validateIpv6Acl(acl);
    const existing = this.ipv6Acls.get(acl.id);
    if (!existing && this.acls.size + this.ipv6Acls.size >= ACL_RESOURCE_LIMITS.maximumAclsPerDevice) {
      throw new PacketPolicyError(
        "ACL_LIMIT_EXCEEDED",
        `Device ACL limit exceeded (${ACL_RESOURCE_LIMITS.maximumAclsPerDevice}).`,
      );
    }
    const priorRules = existing?.rules.length ?? 0;
    const nextRules = acl.rules.length;
    this.budget.reserve(nextRules - priorRules);
    this.ipv6Acls.set(acl.id, cloneAndOrderIpv6Acl(acl));
    this.budget.release(priorRules - nextRules);
    this.clearAclCounters(acl.id);
  }

  removeAcl(aclId: string): void {
    const acl = this.acls.get(aclId);
    if (!acl) return;
    this.acls.delete(aclId);
    this.budget.release(acl.rules.length);
    this.clearAclCounters(aclId);
    for (const [key, binding] of this.bindings) {
      if (binding.aclId === aclId) this.bindings.delete(key);
    }
  }

  removeIpv6Acl(aclId: string): void {
    const acl = this.ipv6Acls.get(aclId);
    if (!acl) return;
    this.ipv6Acls.delete(aclId);
    this.budget.release(acl.rules.length);
    this.clearAclCounters(aclId);
    for (const [key, binding] of this.ipv6Bindings) {
      if (binding.aclId === aclId) this.ipv6Bindings.delete(key);
    }
  }

  bind(binding: AclBinding): void {
    if (!this.acls.has(binding.aclId)) {
      throw new PacketPolicyError("ACL_NOT_FOUND", `ACL '${binding.aclId}' is not defined.`);
    }
    if (binding.interfaceName.trim().length === 0) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL interface name is required.");
    }
    this.bindings.set(bindingKey(binding.interfaceName, binding.direction), { ...binding });
  }

  bindIpv6(binding: AclBinding): void {
    if (!this.ipv6Acls.has(binding.aclId)) {
      throw new PacketPolicyError("ACL_NOT_FOUND", `IPv6 ACL '${binding.aclId}' is not defined.`);
    }
    if (binding.interfaceName.trim().length === 0) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL interface name is required.");
    }
    this.ipv6Bindings.set(bindingKey(binding.interfaceName, binding.direction), { ...binding });
  }

  unbind(interfaceName: string, direction: AclDirection): void {
    this.bindings.delete(bindingKey(interfaceName, direction));
  }

  unbindIpv6(interfaceName: string, direction: AclDirection): void {
    this.ipv6Bindings.delete(bindingKey(interfaceName, direction));
  }

  /**
   * Returns undefined when no ACL is bound. A bound ACL always produces either
   * the first matching rule or an explicit implicit-deny decision.
   */
  evaluate(
    interfaceName: string,
    direction: AclDirection,
    packet: Ipv4Packet,
  ): AclDecision | undefined {
    const binding = this.bindings.get(bindingKey(interfaceName, direction));
    if (!binding) return undefined;
    const acl = this.acls.get(binding.aclId);
    if (!acl) {
      throw new PacketPolicyError("ACL_NOT_FOUND", `ACL '${binding.aclId}' is not defined.`);
    }

    return this.evaluateDefinition(acl, interfaceName, direction, packet);
  }

  evaluateIpv6(
    interfaceName: string,
    direction: AclDirection,
    packet: Ipv6Packet,
  ): AclDecision | undefined {
    const binding = this.ipv6Bindings.get(bindingKey(interfaceName, direction));
    if (!binding) return undefined;
    const acl = this.ipv6Acls.get(binding.aclId);
    if (!acl) {
      throw new PacketPolicyError("ACL_NOT_FOUND", `IPv6 ACL '${binding.aclId}' is not defined.`);
    }
    const match = acl.rules.find((rule) => matchesIpv6Rule(rule, packet));
    if (match) {
      this.incrementCounter(acl.id, match.sequence, match.action);
      return {
        aclId: acl.id,
        interfaceName,
        direction,
        action: match.action,
        sequence: match.sequence,
        implicit: false,
      };
    }
    this.incrementCounter(acl.id, undefined, "deny");
    return {
      aclId: acl.id,
      interfaceName,
      direction,
      action: "deny",
      sequence: undefined,
      implicit: true,
    };
  }

  /** Evaluate a named ACL as a selector (for example, a NAT source rule). */
  aclPermits(aclId: string, packet: Ipv4Packet): boolean {
    const acl = this.acls.get(aclId);
    if (!acl) throw new PacketPolicyError("ACL_NOT_FOUND", `ACL '${aclId}' is not defined.`);
    return this.evaluateDefinition(acl, "policy-selector", "in", packet).action === "permit";
  }

  private evaluateDefinition(
    acl: Ipv4Acl,
    interfaceName: string,
    direction: AclDirection,
    packet: Ipv4Packet,
  ): AclDecision {
    const match = acl.rules.find((rule) => matchesRule(acl.type, rule, packet));
    if (match) {
      this.incrementCounter(acl.id, match.sequence, match.action);
      return {
        aclId: acl.id,
        interfaceName,
        direction,
        action: match.action,
        sequence: match.sequence,
        implicit: false,
      };
    }

    this.incrementCounter(acl.id, undefined, "deny");
    return {
      aclId: acl.id,
      interfaceName,
      direction,
      action: "deny",
      sequence: undefined,
      implicit: true,
    };
  }

  aclConfigurations(): Ipv4Acl[] {
    return [...this.acls.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneAcl);
  }

  ipv6AclConfigurations(): Ipv6Acl[] {
    return [...this.ipv6Acls.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneIpv6Acl);
  }

  bindingConfigurations(): AclBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) =>
        a.interfaceName.localeCompare(b.interfaceName)
        || a.direction.localeCompare(b.direction)
        || a.aclId.localeCompare(b.aclId))
      .map((binding) => ({ ...binding }));
  }

  ipv6BindingConfigurations(): AclBinding[] {
    return [...this.ipv6Bindings.values()]
      .sort((left, right) =>
        left.interfaceName.localeCompare(right.interfaceName)
        || left.direction.localeCompare(right.direction)
        || left.aclId.localeCompare(right.aclId))
      .map((binding) => ({ ...binding }));
  }

  counterSummaries(): AclCounter[] {
    const rows: AclCounter[] = [];
    for (const [key, matches] of this.counters) {
      const [aclId, rawSequence, action] = key.split("\u0000");
      rows.push({
        aclId: aclId!,
        sequence: rawSequence === "implicit" ? undefined : Number(rawSequence),
        action: action as AclAction,
        matches,
      });
    }
    return rows.sort((a, b) =>
      a.aclId.localeCompare(b.aclId)
      || (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER));
  }

  resetCounters(): void {
    this.counters.clear();
  }

  private ruleCount(): number {
    let total = 0;
    for (const acl of this.acls.values()) total += acl.rules.length;
    for (const acl of this.ipv6Acls.values()) total += acl.rules.length;
    return total;
  }

  private incrementCounter(aclId: string, sequence: number | undefined, action: AclAction): void {
    const key = counterKey(aclId, sequence, action);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  private clearAclCounters(aclId: string): void {
    for (const key of this.counters.keys()) {
      if (key.startsWith(`${aclId}\u0000`)) this.counters.delete(key);
    }
  }
}

function validateAcl(acl: Ipv4Acl): void {
  if (acl.id.trim().length === 0) {
    throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL ID is required.");
  }
  if (acl.rules.length > ACL_RESOURCE_LIMITS.maximumRulesPerAcl) {
    throw new PacketPolicyError(
      "ACL_RULE_LIMIT_EXCEEDED",
      `ACL '${acl.id}' exceeds the ${ACL_RESOURCE_LIMITS.maximumRulesPerAcl}-rule limit.`,
    );
  }

  const sequences = new Set<number>();
  for (const rule of acl.rules) {
    if (!Number.isSafeInteger(rule.sequence) || rule.sequence < 0) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL rule sequence must be a non-negative integer.");
    }
    if (sequences.has(rule.sequence)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        `ACL '${acl.id}' has duplicate sequence ${rule.sequence}.`,
      );
    }
    sequences.add(rule.sequence);
    validateAddressMatcher(rule.source);
    if (acl.type === "extended") {
      const extended = rule as ExtendedAclRule;
      validateAddressMatcher(extended.destination);
      if (extended.protocol !== "ip"
        && extended.protocol !== IpProtocol.ICMP
        && extended.protocol !== IpProtocol.TCP
        && extended.protocol !== IpProtocol.UDP) {
        throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", `Unsupported IP protocol '${extended.protocol}'.`);
      }
      if (extended.sourcePort) validatePortMatcher(extended.sourcePort);
      if (extended.destinationPort) validatePortMatcher(extended.destinationPort);
      if (extended.protocol !== IpProtocol.TCP && extended.protocol !== IpProtocol.UDP
        && (extended.sourcePort || extended.destinationPort)) {
        throw new PacketPolicyError(
          "ACL_INVALID_CONFIGURATION",
          "Port matchers are valid only for TCP or UDP ACL rules.",
        );
      }
    }
  }
}

function validateIpv6Acl(acl: Ipv6Acl): void {
  if (acl.id.trim().length === 0) {
    throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "IPv6 ACL ID is required.");
  }
  if (acl.rules.length > ACL_RESOURCE_LIMITS.maximumRulesPerAcl) {
    throw new PacketPolicyError(
      "ACL_RULE_LIMIT_EXCEEDED",
      `IPv6 ACL '${acl.id}' exceeds the ${ACL_RESOURCE_LIMITS.maximumRulesPerAcl}-rule limit.`,
    );
  }
  const sequences = new Set<number>();
  for (const rule of acl.rules) {
    if (!Number.isSafeInteger(rule.sequence) || rule.sequence < 0 || sequences.has(rule.sequence)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        `IPv6 ACL '${acl.id}' has an invalid or duplicate sequence ${rule.sequence}.`,
      );
    }
    sequences.add(rule.sequence);
    validateIpv6AddressMatcher(rule.source);
    validateIpv6AddressMatcher(rule.destination);
    if (rule.protocol !== "ipv6"
      && rule.protocol !== Ipv6NextHeader.ICMPv6
      && rule.protocol !== Ipv6NextHeader.TCP
      && rule.protocol !== Ipv6NextHeader.UDP) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", `Unsupported IPv6 next-header '${rule.protocol}'.`);
    }
    if (rule.sourcePort) validatePortMatcher(rule.sourcePort);
    if (rule.destinationPort) validatePortMatcher(rule.destinationPort);
    if (rule.protocol !== Ipv6NextHeader.TCP && rule.protocol !== Ipv6NextHeader.UDP
      && (rule.sourcePort || rule.destinationPort)) {
      throw new PacketPolicyError(
        "ACL_INVALID_CONFIGURATION",
        "Port matchers are valid only for TCP or UDP IPv6 ACL rules.",
      );
    }
  }
}

function validateIpv6AddressMatcher(matcher: Ipv6AddressMatcher): void {
  if (matcher.kind === "any") return;
  try {
    normalizeIpv6(matcher.address);
    if (matcher.kind === "prefix"
      && (!Number.isInteger(matcher.prefixLength) || matcher.prefixLength < 0 || matcher.prefixLength > 128)) {
      throw new Error(`Invalid IPv6 prefix length: ${matcher.prefixLength}`);
    }
  } catch (error) {
    throw new PacketPolicyError(
      "ACL_INVALID_CONFIGURATION",
      error instanceof Error ? error.message : "Invalid IPv6 ACL address.",
    );
  }
}

function validateAddressMatcher(matcher: Ipv4AddressMatcher): void {
  if (matcher.kind === "any") return;
  try {
    ipToInt(matcher.address);
    if (matcher.kind === "network") ipToInt(matcher.wildcard);
  } catch (error) {
    throw new PacketPolicyError(
      "ACL_INVALID_CONFIGURATION",
      error instanceof Error ? error.message : "Invalid IPv4 ACL address.",
    );
  }
}

function validatePortMatcher(matcher: PortMatcher): void {
  if (matcher.kind === "any") return;
  if (matcher.kind === "eq") {
    validatePort(matcher.port);
    return;
  }
  validatePort(matcher.start);
  validatePort(matcher.end);
  if (matcher.start > matcher.end) {
    throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL port range start must not exceed its end.");
  }
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", `Invalid transport port '${port}'.`);
  }
}

function matchesRule(
  aclType: Ipv4Acl["type"],
  rule: StandardAclRule | ExtendedAclRule,
  packet: Ipv4Packet,
): boolean {
  if (!matchesAddress(rule.source, packet.src)) return false;
  if (aclType === "standard") return true;
  const extended = rule as ExtendedAclRule;
  if (extended.protocol !== "ip" && extended.protocol !== packet.protocol) return false;
  if (!matchesAddress(extended.destination, packet.dst)) return false;
  if (!extended.sourcePort && !extended.destinationPort) return true;
  if (packet.payload.kind !== "tcp" && packet.payload.kind !== "udp") return false;
  return matchesPort(extended.sourcePort, packet.payload.srcPort)
    && matchesPort(extended.destinationPort, packet.payload.dstPort);
}

function matchesAddress(matcher: Ipv4AddressMatcher, address: Ipv4): boolean {
  if (matcher.kind === "any") return true;
  if (matcher.kind === "host") return ipToInt(address) === ipToInt(matcher.address);
  const wildcard = ipToInt(matcher.wildcard);
  const mustMatch = (~wildcard) >>> 0;
  return ((ipToInt(address) & mustMatch) >>> 0) === ((ipToInt(matcher.address) & mustMatch) >>> 0);
}

function matchesIpv6Rule(rule: Ipv6AclRule, packet: Ipv6Packet): boolean {
  if (rule.protocol !== "ipv6" && rule.protocol !== packet.nextHeader) return false;
  if (!matchesIpv6Address(rule.source, packet.src) || !matchesIpv6Address(rule.destination, packet.dst)) return false;
  if (!rule.sourcePort && !rule.destinationPort) return true;
  if (packet.payload.kind !== "tcp" && packet.payload.kind !== "udp") return false;
  return matchesPort(rule.sourcePort, packet.payload.srcPort)
    && matchesPort(rule.destinationPort, packet.payload.dstPort);
}

function matchesIpv6Address(matcher: Ipv6AddressMatcher, address: Ipv6): boolean {
  if (matcher.kind === "any") return true;
  if (matcher.kind === "host") return normalizeIpv6(address) === normalizeIpv6(matcher.address);
  return ipv6InPrefix(address, matcher.address, matcher.prefixLength);
}

function matchesPort(matcher: PortMatcher | undefined, port: number): boolean {
  if (!matcher || matcher.kind === "any") return true;
  if (matcher.kind === "eq") return port === matcher.port;
  return port >= matcher.start && port <= matcher.end;
}

function cloneAndOrderAcl(acl: Ipv4Acl): Ipv4Acl {
  const orderedRules = [...acl.rules].sort((a, b) => a.sequence - b.sequence);
  return acl.type === "standard"
    ? {
        id: acl.id,
        type: "standard",
        rules: (orderedRules as StandardAclRule[]).map(cloneStandardRule),
      }
    : {
        id: acl.id,
        type: "extended",
        rules: (orderedRules as ExtendedAclRule[]).map(cloneExtendedRule),
      };
}

function cloneAcl(acl: Ipv4Acl): Ipv4Acl {
  return acl.type === "standard"
    ? { id: acl.id, type: "standard", rules: acl.rules.map(cloneStandardRule) }
    : { id: acl.id, type: "extended", rules: acl.rules.map(cloneExtendedRule) };
}

function cloneStandardRule(rule: StandardAclRule): StandardAclRule {
  return { ...rule, source: { ...rule.source } };
}

function cloneExtendedRule(rule: ExtendedAclRule): ExtendedAclRule {
  return {
    ...rule,
    source: { ...rule.source },
    destination: { ...rule.destination },
    sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
    destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
  };
}

function cloneAndOrderIpv6Acl(acl: Ipv6Acl): Ipv6Acl {
  return {
    id: acl.id,
    type: "ipv6",
    rules: [...acl.rules].sort((left, right) => left.sequence - right.sequence).map(cloneIpv6Rule),
  };
}

function cloneIpv6Acl(acl: Ipv6Acl): Ipv6Acl {
  return { id: acl.id, type: "ipv6", rules: acl.rules.map(cloneIpv6Rule) };
}

function cloneIpv6Rule(rule: Ipv6AclRule): Ipv6AclRule {
  return {
    ...rule,
    source: { ...rule.source },
    destination: { ...rule.destination },
    sourcePort: rule.sourcePort ? { ...rule.sourcePort } : undefined,
    destinationPort: rule.destinationPort ? { ...rule.destinationPort } : undefined,
  };
}

function bindingKey(interfaceName: string, direction: AclDirection): string {
  return `${interfaceName}\u0000${direction}`;
}

function counterKey(aclId: string, sequence: number | undefined, action: AclAction): string {
  return `${aclId}\u0000${sequence ?? "implicit"}\u0000${action}`;
}
