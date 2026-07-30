import { IpProtocol } from "@sim/contracts";
import type { Ipv4Packet } from "../packets/ipv4";
import { Ipv6NextHeader, type Ipv6Packet } from "../packets/ipv6";
import type {
  Ipv4AddressMatcher,
  Ipv6AddressMatcher,
  PortMatcher,
} from "../policy/packet-policy-engine";
import { ipToInt } from "../util/ipv4";
import { ipv6InPrefix, normalizeIpv6 } from "../util/ipv6";
import { QOS_RESOURCE_LIMITS, QosOperationBudget } from "./limits";
import {
  MAXIMUM_COS,
  precedenceOfDscp,
  requireCos,
  requireDscp,
  requireIpPrecedence,
} from "./markings";
import {
  QOS_CLASS_DEFAULT,
  type QosClassCounter,
  type QosClassMap,
  type QosClassificationResult,
  type QosDirection,
  type QosMarkingAction,
  type QosMatchRule,
  type QosPolicyClass,
  type QosPolicyMap,
  type QosProblem,
  type QosServicePolicyBinding,
} from "./policy";

export type QosPolicyErrorCode =
  | "QOS_CLASS_MAP_LIMIT"
  | "QOS_POLICY_MAP_LIMIT"
  | "QOS_CLASS_LIMIT"
  | "QOS_MATCH_LIMIT"
  | "QOS_BINDING_LIMIT"
  | "QOS_CLASS_MAP_NOT_FOUND"
  | "QOS_POLICY_MAP_NOT_FOUND"
  | "QOS_INVALID_CONFIGURATION";

export class QosPolicyError extends Error {
  override readonly name = "QosPolicyError";

  constructor(
    readonly code: QosPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Everything a match rule may need that is not inside the packet itself. */
export interface QosEvaluationContext {
  readonly nowNs: number;
  /** 802.1p priority carried by the frame, when it is tagged. */
  readonly cos?: number;
  /** Traffic Generator flow id; internal test metadata, never a wire field. */
  readonly flowId?: string;
  aclPermits?(aclId: string, packet: Ipv4Packet): boolean;
  ipv6AclPermits?(aclId: string, packet: Ipv6Packet): boolean;
}

/** A packet plus the L2 context the classifier and marker need. */
export interface QosPacketSubject {
  readonly packet: Ipv4Packet | Ipv6Packet;
  readonly wireSizeBytes: number;
  readonly cos?: number;
}

export interface QosMarkingOutcome {
  readonly packet: Ipv4Packet | Ipv6Packet;
  readonly cos: number | undefined;
  readonly changed: boolean;
  readonly dscpBefore: number;
  readonly dscpAfter: number;
  readonly cosBefore: number | undefined;
  readonly cosAfter: number | undefined;
}

interface CounterRow {
  matchedPackets: number;
  matchedBytes: number;
  markedPackets: number;
  droppedPackets: number;
  lastMatchAtNs: number | undefined;
}

/**
 * The one reusable QoS engine.
 *
 * Router, L3 Switch, Firewall and Wireless Router all classify and mark through
 * this class — there is deliberately no second classifier anywhere. It owns
 * persistent class maps, policy maps and service-policy bindings plus transient
 * counters, and it knows nothing about devices, clocks, queues, the DOM or Node.
 */
export class QosPolicyEngine {
  private readonly classMaps = new Map<string, QosClassMap>();
  private readonly policyMaps = new Map<string, QosPolicyMap>();
  private readonly bindings = new Map<string, QosServicePolicyBinding>();
  private readonly counters = new Map<string, CounterRow>();
  private budget: QosOperationBudget;

  constructor(budget = new QosOperationBudget()) {
    this.budget = budget;
  }

  useOperationBudget(budget: QosOperationBudget): void {
    this.budget = budget;
  }

  // --- class maps ---------------------------------------------------------

  defineClassMap(map: QosClassMap): void {
    validateClassMap(map);
    if (!this.classMaps.has(map.id)
      && this.classMaps.size >= QOS_RESOURCE_LIMITS.maximumClassMapsPerDevice) {
      throw new QosPolicyError(
        "QOS_CLASS_MAP_LIMIT",
        `Class-map limit exceeded (${QOS_RESOURCE_LIMITS.maximumClassMapsPerDevice}).`,
      );
    }
    this.classMaps.set(map.id, cloneClassMap(map));
  }

  removeClassMap(id: string): void {
    this.classMaps.delete(id);
  }

  classMapConfigurations(): QosClassMap[] {
    return [...this.classMaps.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneClassMap);
  }

  // --- policy maps --------------------------------------------------------

  definePolicyMap(map: QosPolicyMap): void {
    validatePolicyMap(map);
    if (!this.policyMaps.has(map.id)
      && this.policyMaps.size >= QOS_RESOURCE_LIMITS.maximumPolicyMapsPerDevice) {
      throw new QosPolicyError(
        "QOS_POLICY_MAP_LIMIT",
        `Policy-map limit exceeded (${QOS_RESOURCE_LIMITS.maximumPolicyMapsPerDevice}).`,
      );
    }
    this.policyMaps.set(map.id, clonePolicyMap(map));
  }

  removePolicyMap(id: string): void {
    this.policyMaps.delete(id);
    for (const [key, binding] of this.bindings) {
      if (binding.policyMapId === id) this.bindings.delete(key);
    }
  }

  policyMapConfigurations(): QosPolicyMap[] {
    return [...this.policyMaps.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(clonePolicyMap);
  }

  policyMap(id: string): QosPolicyMap | undefined {
    const map = this.policyMaps.get(id);
    return map ? clonePolicyMap(map) : undefined;
  }

  // --- service policies ---------------------------------------------------

  attach(binding: QosServicePolicyBinding): void {
    if (!this.policyMaps.has(binding.policyMapId)) {
      throw new QosPolicyError(
        "QOS_POLICY_MAP_NOT_FOUND",
        `Policy-map '${binding.policyMapId}' is not defined.`,
      );
    }
    if (binding.interfaceName.trim().length === 0) {
      throw new QosPolicyError("QOS_INVALID_CONFIGURATION", "Service-policy interface name is required.");
    }
    const key = bindingKey(binding.interfaceName, binding.direction);
    if (!this.bindings.has(key)
      && this.bindings.size >= QOS_RESOURCE_LIMITS.maximumServicePolicyBindingsPerDevice) {
      throw new QosPolicyError(
        "QOS_BINDING_LIMIT",
        `Service-policy binding limit exceeded (${QOS_RESOURCE_LIMITS.maximumServicePolicyBindingsPerDevice}).`,
      );
    }
    this.bindings.set(key, { ...binding });
  }

  detach(interfaceName: string, direction: QosDirection): void {
    this.bindings.delete(bindingKey(interfaceName, direction));
  }

  bindingConfigurations(): QosServicePolicyBinding[] {
    return [...this.bindings.values()]
      .sort((left, right) =>
        left.interfaceName.localeCompare(right.interfaceName)
        || left.direction.localeCompare(right.direction))
      .map((binding) => ({ ...binding }));
  }

  policyFor(interfaceName: string, direction: QosDirection): QosPolicyMap | undefined {
    const binding = this.bindings.get(bindingKey(interfaceName, direction));
    if (!binding) return undefined;
    return this.policyMaps.get(binding.policyMapId);
  }

  hasPolicies(): boolean {
    return this.bindings.size > 0;
  }

  // --- classification -----------------------------------------------------

  /**
   * Which policy class this packet belongs to on that interface and direction,
   * or `undefined` when no service policy is attached. A bound policy always
   * yields a class: `class-default` when nothing else matched.
   */
  classify(
    interfaceName: string,
    direction: QosDirection,
    subject: QosPacketSubject,
    context: QosEvaluationContext,
  ): QosClassificationResult | undefined {
    const policy = this.policyFor(interfaceName, direction);
    if (!policy) return undefined;
    this.budget.consumeEvaluation();
    const cos = subject.cos ?? context.cos;
    let matchIndex: number | undefined;
    let selected: QosPolicyClass | undefined;
    for (let index = 0; index < policy.classes.length; index++) {
      const policyClass = policy.classes[index]!;
      if (policyClass.className === QOS_CLASS_DEFAULT) continue;
      const classMap = this.classMaps.get(policyClass.className);
      if (!classMap) continue; // reported through `problems()`, never a silent match
      if (!this.matchesClassMap(classMap, subject.packet, cos, context)) continue;
      matchIndex = index;
      selected = policyClass;
      break;
    }
    const policyClass = selected
      ?? policy.classes.find((entry) => entry.className === QOS_CLASS_DEFAULT)
      ?? { className: QOS_CLASS_DEFAULT };
    const result: QosClassificationResult = {
      policyMapId: policy.id,
      interfaceName,
      direction,
      className: policyClass.className,
      matched: selected !== undefined,
      matchIndex,
      policyClass,
    };
    this.recordMatch(result, subject.wireSizeBytes, context.nowNs);
    return result;
  }

  private matchesClassMap(
    classMap: QosClassMap,
    packet: Ipv4Packet | Ipv6Packet,
    cos: number | undefined,
    context: QosEvaluationContext,
  ): boolean {
    if (classMap.matches.length === 0) return false;
    if (classMap.matchType === "match-all") {
      return classMap.matches.every((rule) => this.matchesRule(rule, packet, cos, context));
    }
    return classMap.matches.some((rule) => this.matchesRule(rule, packet, cos, context));
  }

  private matchesRule(
    rule: QosMatchRule,
    packet: Ipv4Packet | Ipv6Packet,
    cos: number | undefined,
    context: QosEvaluationContext,
  ): boolean {
    this.budget.consumeEvaluation();
    switch (rule.kind) {
      case "any":
        return true;
      case "access-group":
        return packet.kind === "ipv4" && (context.aclPermits?.(rule.aclId, packet) ?? false);
      case "ipv6-access-group":
        return packet.kind === "ipv6" && (context.ipv6AclPermits?.(rule.aclId, packet) ?? false);
      case "protocol":
        return matchesProtocol(rule.protocol, packet);
      case "source-port":
        return matchesPort(rule.port, transportPort(packet, "source"));
      case "destination-port":
        return matchesPort(rule.port, transportPort(packet, "destination"));
      case "dscp":
        return rule.values.includes(dscpOf(packet));
      case "precedence":
        return rule.values.includes(precedenceOfDscp(dscpOf(packet)));
      case "cos":
        return cos !== undefined && rule.values.includes(cos);
      case "source-prefix":
        return matchesAddress(rule, packet, "source");
      case "destination-prefix":
        return matchesAddress(rule, packet, "destination");
      case "traffic-flow":
        return context.flowId === rule.flowId;
    }
  }

  // --- marking ------------------------------------------------------------

  /**
   * Apply a class's marking action. The packet is replaced by an updated copy;
   * fields are never mutated in place, so a trace can show before/after values.
   */
  applyMarking(
    subject: QosPacketSubject,
    marking: QosMarkingAction | undefined,
    contextCos?: number,
  ): QosMarkingOutcome {
    const cosBefore = subject.cos ?? contextCos;
    const dscpBefore = dscpOf(subject.packet);
    if (!marking || (marking.dscp === undefined && marking.precedence === undefined && marking.cos === undefined)) {
      return {
        packet: subject.packet,
        cos: cosBefore,
        changed: false,
        dscpBefore,
        dscpAfter: dscpBefore,
        cosBefore,
        cosAfter: cosBefore,
      };
    }
    let dscpAfter = dscpBefore;
    if (marking.dscp !== undefined) dscpAfter = requireDscp(marking.dscp);
    else if (marking.precedence !== undefined) {
      dscpAfter = ((requireIpPrecedence(marking.precedence) << 3) | (dscpBefore & 0b111)) & 0b111111;
    }
    const cosAfter = marking.cos === undefined ? cosBefore : requireCos(marking.cos);
    const packet = dscpAfter === dscpBefore ? subject.packet : withDscp(subject.packet, dscpAfter);
    return {
      packet,
      cos: cosAfter,
      changed: dscpAfter !== dscpBefore || cosAfter !== cosBefore,
      dscpBefore,
      dscpAfter,
      cosBefore,
      cosAfter,
    };
  }

  // --- counters -----------------------------------------------------------

  private recordMatch(result: QosClassificationResult, bytes: number, nowNs: number): void {
    const row = this.counterRow(result);
    row.matchedPackets++;
    row.matchedBytes += bytes;
    row.lastMatchAtNs = nowNs;
  }

  recordMarked(result: QosClassificationResult): void {
    this.counterRow(result).markedPackets++;
  }

  recordDropped(result: QosClassificationResult): void {
    this.counterRow(result).droppedPackets++;
  }

  counterSummaries(): QosClassCounter[] {
    return [...this.counters.entries()]
      .map(([key, row]) => {
        const [policyMapId, direction, interfaceName, className] = key.split(" ");
        return {
          policyMapId: policyMapId!,
          direction: direction as QosDirection,
          interfaceName: interfaceName!,
          className: className!,
          matchedPackets: row.matchedPackets,
          matchedBytes: row.matchedBytes,
          markedPackets: row.markedPackets,
          droppedPackets: row.droppedPackets,
          lastMatchAtNs: row.lastMatchAtNs,
        };
      })
      .sort((left, right) =>
        left.interfaceName.localeCompare(right.interfaceName)
        || left.direction.localeCompare(right.direction)
        || left.policyMapId.localeCompare(right.policyMapId)
        || left.className.localeCompare(right.className));
  }

  resetCounters(): void {
    this.counters.clear();
  }

  private counterRow(result: QosClassificationResult): CounterRow {
    const key = counterKey(result);
    let row = this.counters.get(key);
    if (!row) {
      row = { matchedPackets: 0, matchedBytes: 0, markedPackets: 0, droppedPackets: 0, lastMatchAtNs: undefined };
      this.counters.set(key, row);
    }
    return row;
  }

  // --- validation ---------------------------------------------------------

  /** Structural problems a learner should see, never thrown mid-packet. */
  problems(): QosProblem[] {
    const problems: QosProblem[] = [];
    for (const policy of this.policyMapConfigurations()) {
      let bandwidthTotal = 0;
      let priorityTotal = 0;
      for (const policyClass of policy.classes) {
        if (policyClass.className !== QOS_CLASS_DEFAULT && !this.classMaps.has(policyClass.className)) {
          problems.push({
            code: "policy-missing-class-map",
            message: `Policy-map ${policy.id} references undefined class-map '${policyClass.className}'.`,
            policyMapId: policy.id,
            className: policyClass.className,
          });
        }
        bandwidthTotal += policyClass.bandwidthPercent ?? 0;
        priorityTotal += policyClass.priority?.percent ?? 0;
      }
      if (bandwidthTotal + priorityTotal > QOS_RESOURCE_LIMITS.maximumBandwidthPercentTotal) {
        problems.push({
          code: "policy-bandwidth-exceeded",
          message: `Policy-map ${policy.id} allocates ${bandwidthTotal + priorityTotal}% of the interface, which exceeds 100%.`,
          policyMapId: policy.id,
        });
      }
      if (priorityTotal > QOS_RESOURCE_LIMITS.maximumPriorityPercent) {
        problems.push({
          code: "policy-priority-exceeded",
          message: `Policy-map ${policy.id} reserves ${priorityTotal}% for priority traffic, above the ${QOS_RESOURCE_LIMITS.maximumPriorityPercent}% starvation guard.`,
          policyMapId: policy.id,
        });
      }
    }
    for (const binding of this.bindingConfigurations()) {
      const policy = this.policyMaps.get(binding.policyMapId);
      if (!policy) {
        problems.push({
          code: "service-policy-missing-policy-map",
          message: `Interface ${binding.interfaceName} references undefined policy-map '${binding.policyMapId}'.`,
          interfaceName: binding.interfaceName,
          policyMapId: binding.policyMapId,
        });
        continue;
      }
      const schedules = policy.classes.some((entry) =>
        entry.priority !== undefined || entry.bandwidthPercent !== undefined || entry.shape !== undefined);
      if (binding.direction === "input" && schedules) {
        problems.push({
          code: "service-policy-type-mismatch",
          message: `Policy-map ${policy.id} schedules or shapes traffic, so it cannot be applied inbound on ${binding.interfaceName}.`,
          interfaceName: binding.interfaceName,
          policyMapId: policy.id,
        });
      }
    }
    return problems;
  }
}

// --- packet helpers -------------------------------------------------------

/** The DSCP an IPv4 packet or an IPv6 traffic class currently carries. */
export function dscpOf(packet: Ipv4Packet | Ipv6Packet): number {
  return packet.kind === "ipv4" ? packet.dscp ?? 0 : packet.trafficClass ?? 0;
}

/** An updated copy carrying the new DSCP; the original is never mutated. */
export function withDscp<T extends Ipv4Packet | Ipv6Packet>(packet: T, dscp: number): T {
  return packet.kind === "ipv4"
    ? { ...packet, dscp } as T
    : { ...packet, trafficClass: dscp } as T;
}

function matchesProtocol(protocol: "icmp" | "tcp" | "udp", packet: Ipv4Packet | Ipv6Packet): boolean {
  if (packet.kind === "ipv4") {
    if (protocol === "icmp") return packet.protocol === IpProtocol.ICMP;
    if (protocol === "tcp") return packet.protocol === IpProtocol.TCP;
    return packet.protocol === IpProtocol.UDP;
  }
  if (protocol === "icmp") return packet.nextHeader === Ipv6NextHeader.ICMPv6;
  if (protocol === "tcp") return packet.nextHeader === Ipv6NextHeader.TCP;
  return packet.nextHeader === Ipv6NextHeader.UDP;
}

function transportPort(packet: Ipv4Packet | Ipv6Packet, side: "source" | "destination"): number | undefined {
  const payload = packet.payload;
  if (payload.kind !== "tcp" && payload.kind !== "udp") return undefined;
  return side === "source" ? payload.srcPort : payload.dstPort;
}

function matchesPort(matcher: PortMatcher, port: number | undefined): boolean {
  if (port === undefined) return false;
  if (matcher.kind === "any") return true;
  if (matcher.kind === "eq") return port === matcher.port;
  return port >= matcher.start && port <= matcher.end;
}

function matchesAddress(
  rule: { readonly ipv4?: Ipv4AddressMatcher; readonly ipv6?: Ipv6AddressMatcher },
  packet: Ipv4Packet | Ipv6Packet,
  side: "source" | "destination",
): boolean {
  if (packet.kind === "ipv4") {
    if (!rule.ipv4) return false;
    return matchesIpv4(rule.ipv4, side === "source" ? packet.src : packet.dst);
  }
  if (!rule.ipv6) return false;
  return matchesIpv6(rule.ipv6, side === "source" ? packet.src : packet.dst);
}

function matchesIpv4(matcher: Ipv4AddressMatcher, address: string): boolean {
  if (matcher.kind === "any") return true;
  if (matcher.kind === "host") return ipToInt(address) === ipToInt(matcher.address);
  const mustMatch = (~ipToInt(matcher.wildcard)) >>> 0;
  return ((ipToInt(address) & mustMatch) >>> 0) === ((ipToInt(matcher.address) & mustMatch) >>> 0);
}

function matchesIpv6(matcher: Ipv6AddressMatcher, address: string): boolean {
  if (matcher.kind === "any") return true;
  if (matcher.kind === "host") return normalizeIpv6(address) === normalizeIpv6(matcher.address);
  return ipv6InPrefix(address, matcher.address, matcher.prefixLength);
}

// --- validation and cloning -----------------------------------------------

function validateClassMap(map: QosClassMap): void {
  if (map.id.trim().length === 0) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", "Class-map name is required.");
  }
  if (map.id === QOS_CLASS_DEFAULT) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `'${QOS_CLASS_DEFAULT}' is reserved.`);
  }
  if (map.matches.length > QOS_RESOURCE_LIMITS.maximumMatchRulesPerClass) {
    throw new QosPolicyError(
      "QOS_MATCH_LIMIT",
      `Class-map '${map.id}' exceeds the ${QOS_RESOURCE_LIMITS.maximumMatchRulesPerClass}-match limit.`,
    );
  }
  for (const rule of map.matches) validateMatchRule(map.id, rule);
}

function validateMatchRule(classMapId: string, rule: QosMatchRule): void {
  if (rule.kind === "dscp") {
    if (rule.values.length === 0) {
      throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `Class-map '${classMapId}' has an empty DSCP match.`);
    }
    for (const value of rule.values) requireDscp(value);
    return;
  }
  if (rule.kind === "precedence") {
    for (const value of rule.values) requireIpPrecedence(value);
    return;
  }
  if (rule.kind === "cos") {
    for (const value of rule.values) requireCos(value);
    return;
  }
  if ((rule.kind === "access-group" || rule.kind === "ipv6-access-group") && rule.aclId.trim().length === 0) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `Class-map '${classMapId}' has an empty ACL reference.`);
  }
  if (rule.kind === "traffic-flow" && rule.flowId.trim().length === 0) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `Class-map '${classMapId}' has an empty flow id.`);
  }
  if ((rule.kind === "source-prefix" || rule.kind === "destination-prefix")
    && rule.ipv4 === undefined && rule.ipv6 === undefined) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `Class-map '${classMapId}' has an empty prefix match.`);
  }
}

function validatePolicyMap(map: QosPolicyMap): void {
  if (map.id.trim().length === 0) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", "Policy-map name is required.");
  }
  if (map.classes.length > QOS_RESOURCE_LIMITS.maximumClassesPerPolicy) {
    throw new QosPolicyError(
      "QOS_CLASS_LIMIT",
      `Policy-map '${map.id}' exceeds the ${QOS_RESOURCE_LIMITS.maximumClassesPerPolicy}-class limit.`,
    );
  }
  const seen = new Set<string>();
  for (const policyClass of map.classes) {
    if (seen.has(policyClass.className)) {
      throw new QosPolicyError(
        "QOS_INVALID_CONFIGURATION",
        `Policy-map '${map.id}' lists class '${policyClass.className}' twice.`,
      );
    }
    seen.add(policyClass.className);
    validatePolicyClass(map.id, policyClass);
  }
}

function validatePolicyClass(policyMapId: string, policyClass: QosPolicyClass): void {
  const marking = policyClass.marking;
  if (marking?.dscp !== undefined) requireDscp(marking.dscp);
  if (marking?.precedence !== undefined) requireIpPrecedence(marking.precedence);
  if (marking?.cos !== undefined) requireCos(marking.cos);
  if (policyClass.priority && policyClass.bandwidthPercent !== undefined) {
    throw new QosPolicyError(
      "QOS_INVALID_CONFIGURATION",
      `Class '${policyClass.className}' in policy-map '${policyMapId}' cannot be both priority and bandwidth.`,
    );
  }
  if (policyClass.bandwidthPercent !== undefined) requirePercent(policyClass.bandwidthPercent, "bandwidth percent");
  if (policyClass.priority?.percent !== undefined) requirePercent(policyClass.priority.percent, "priority percent");
  if (policyClass.priority?.rateBps !== undefined) {
    requireRate(policyClass.priority.rateBps, "priority rate", QOS_RESOURCE_LIMITS.minimumPolicerRateBps, QOS_RESOURCE_LIMITS.maximumPolicerRateBps);
  }
  if (policyClass.police) {
    requireRate(policyClass.police.rateBps, "police rate", QOS_RESOURCE_LIMITS.minimumPolicerRateBps, QOS_RESOURCE_LIMITS.maximumPolicerRateBps);
    requireRate(policyClass.police.burstBytes, "police burst", QOS_RESOURCE_LIMITS.minimumPolicerBurstBytes, QOS_RESOURCE_LIMITS.maximumPolicerBurstBytes);
    if (policyClass.police.exceedAction === "set-dscp-transmit") {
      if (policyClass.police.exceedDscp === undefined) {
        throw new QosPolicyError(
          "QOS_INVALID_CONFIGURATION",
          `Policer in '${policyMapId}' uses exceed-action set-dscp-transmit without a DSCP value.`,
        );
      }
      requireDscp(policyClass.police.exceedDscp);
    }
  }
  if (policyClass.shape) {
    requireRate(policyClass.shape.averageRateBps, "shape average", QOS_RESOURCE_LIMITS.minimumShaperRateBps, QOS_RESOURCE_LIMITS.maximumShaperRateBps);
    if (policyClass.shape.burstBytes !== undefined) {
      requireRate(policyClass.shape.burstBytes, "shape burst", QOS_RESOURCE_LIMITS.minimumPolicerBurstBytes, QOS_RESOURCE_LIMITS.maximumPolicerBurstBytes);
    }
  }
}

function requirePercent(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > QOS_RESOURCE_LIMITS.maximumBandwidthPercentTotal) {
    throw new QosPolicyError("QOS_INVALID_CONFIGURATION", `${label} must be an integer between 1 and 100.`);
  }
}

function requireRate(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new QosPolicyError(
      "QOS_INVALID_CONFIGURATION",
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function cloneClassMap(map: QosClassMap): QosClassMap {
  return {
    id: map.id,
    matchType: map.matchType,
    matches: map.matches.map(cloneMatchRule),
  };
}

function cloneMatchRule(rule: QosMatchRule): QosMatchRule {
  if (rule.kind === "dscp" || rule.kind === "precedence" || rule.kind === "cos") {
    return { ...rule, values: [...rule.values].sort((a, b) => a - b) };
  }
  if (rule.kind === "source-port" || rule.kind === "destination-port") {
    return { ...rule, port: { ...rule.port } };
  }
  if (rule.kind === "source-prefix" || rule.kind === "destination-prefix") {
    return {
      ...rule,
      ipv4: rule.ipv4 ? { ...rule.ipv4 } : undefined,
      ipv6: rule.ipv6 ? { ...rule.ipv6 } : undefined,
    };
  }
  return { ...rule };
}

function clonePolicyMap(map: QosPolicyMap): QosPolicyMap {
  return { id: map.id, classes: map.classes.map(clonePolicyClass) };
}

function clonePolicyClass(policyClass: QosPolicyClass): QosPolicyClass {
  return {
    ...policyClass,
    marking: policyClass.marking ? { ...policyClass.marking } : undefined,
    priority: policyClass.priority ? { ...policyClass.priority } : undefined,
    police: policyClass.police ? { ...policyClass.police } : undefined,
    shape: policyClass.shape ? { ...policyClass.shape } : undefined,
  };
}

function bindingKey(interfaceName: string, direction: QosDirection): string {
  return `${interfaceName} ${direction}`;
}

function counterKey(result: QosClassificationResult): string {
  return [result.policyMapId, result.direction, result.interfaceName, result.className].join(" ");
}

export { MAXIMUM_COS };
