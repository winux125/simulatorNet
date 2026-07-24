import { IpProtocol } from "@sim/contracts";
import type { Ipv4Packet } from "../packets/ipv4";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";

export const ACL_RESOURCE_LIMITS = {
  maximumAclsPerDevice: 64,
  maximumRulesPerAcl: 256,
  maximumRulesPerLab: 2_048,
} as const;

export type AclAction = "permit" | "deny";
export type AclDirection = "in" | "out";

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
  readonly protocol: "ip" | IpProtocol;
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
    if (!existing && this.acls.size >= ACL_RESOURCE_LIMITS.maximumAclsPerDevice) {
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

  bind(binding: AclBinding): void {
    if (!this.acls.has(binding.aclId)) {
      throw new PacketPolicyError("ACL_NOT_FOUND", `ACL '${binding.aclId}' is not defined.`);
    }
    if (binding.interfaceName.trim().length === 0) {
      throw new PacketPolicyError("ACL_INVALID_CONFIGURATION", "ACL interface name is required.");
    }
    this.bindings.set(bindingKey(binding.interfaceName, binding.direction), { ...binding });
  }

  unbind(interfaceName: string, direction: AclDirection): void {
    this.bindings.delete(bindingKey(interfaceName, direction));
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

  bindingConfigurations(): AclBinding[] {
    return [...this.bindings.values()]
      .sort((a, b) =>
        a.interfaceName.localeCompare(b.interfaceName)
        || a.direction.localeCompare(b.direction)
        || a.aclId.localeCompare(b.aclId))
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

function bindingKey(interfaceName: string, direction: AclDirection): string {
  return `${interfaceName}\u0000${direction}`;
}

function counterKey(aclId: string, sequence: number | undefined, action: AclAction): string {
  return `${aclId}\u0000${sequence ?? "implicit"}\u0000${action}`;
}
