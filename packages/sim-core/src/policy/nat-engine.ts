import { IpProtocol } from "@sim/contracts";
import {
  EPHEMERAL_PORT_END,
  EPHEMERAL_PORT_START,
  NS_PER_S,
} from "../engine/constants";
import type { Ipv4Packet } from "../packets/ipv4";
import { policyProtocolOf, type PolicyProtocol } from "./packet-policy-engine";
import type { Ipv4 } from "../util/ipv4";
import { intToIp, ipToInt } from "../util/ipv4";

export const NAT_RESOURCE_LIMITS = Object.freeze({
  maximumRulesPerDevice: 128,
  maximumPoolsPerDevice: 32,
  maximumAddressesPerPool: 256,
  maximumRuntimeTranslations: 1_024,
  patPortStart: EPHEMERAL_PORT_START,
  patPortEnd: EPHEMERAL_PORT_END,
  dynamicTimeoutNs: 300 * NS_PER_S,
  tcpTimeoutNs: 300 * NS_PER_S,
  udpTimeoutNs: 60 * NS_PER_S,
  icmpTimeoutNs: 30 * NS_PER_S,
});

export type NatInterfaceRole = "inside" | "outside";

export type NatSourceSelector =
  | { readonly kind: "any" }
  | { readonly kind: "acl"; readonly aclId: string };

export interface StaticNatRule {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "static";
  readonly insideLocal: Ipv4;
  readonly insideGlobal: Ipv4;
}

export interface DynamicNatRule {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "dynamic";
  readonly source: NatSourceSelector;
  readonly poolId: string;
}

export interface PatNatRule {
  readonly id: string;
  readonly sequence: number;
  readonly kind: "pat";
  readonly source: NatSourceSelector;
  /** Use the selected outside interface address or a configured global address. */
  readonly outsideAddress: "interface" | Ipv4;
}

export type NatRule = StaticNatRule | DynamicNatRule | PatNatRule;

export interface NatPool {
  readonly id: string;
  readonly startAddress: Ipv4;
  readonly endAddress: Ipv4;
}

export type NatTranslationProtocol = PolicyProtocol;

export interface NatTranslation {
  readonly id: string;
  readonly ruleId: string;
  readonly kind: NatRule["kind"];
  readonly protocol: NatTranslationProtocol;
  readonly insideLocalAddress: Ipv4;
  readonly insideGlobalAddress: Ipv4;
  readonly insideLocalToken: number | undefined;
  readonly insideGlobalToken: number | undefined;
  readonly remoteAddress: Ipv4 | undefined;
  readonly remoteToken: number | undefined;
  readonly createdAtNs: number;
  readonly lastUsedAtNs: number;
  readonly expiresAtNs: number | undefined;
}

interface MutableNatTranslation extends NatTranslation {
  lastUsedAtNs: number;
  expiresAtNs: number | undefined;
}

export interface NatTranslationResult {
  readonly packet: Ipv4Packet;
  readonly translation: NatTranslation | undefined;
}

export interface NatTranslationContext {
  readonly nowNs: number;
  readonly outsideInterfaceAddress: Ipv4 | undefined;
  readonly aclPermits?: (aclId: string, packet: Ipv4Packet) => boolean;
}

export type NatErrorCode =
  | "NAT_PORT_EXHAUSTED"
  | "NAT_POOL_EXHAUSTED"
  | "NAT_NO_TRANSLATION"
  | "NAT_ROLE_MISSING"
  | "NAT_LIMIT_EXCEEDED"
  | "NAT_INVALID_CONFIGURATION";

export class NatError extends Error {
  override readonly name = "NatError";

  constructor(
    readonly code: NatErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface NatEngineLimits {
  readonly maximumRulesPerDevice: number;
  readonly maximumPoolsPerDevice: number;
  readonly maximumAddressesPerPool: number;
  readonly maximumRuntimeTranslations: number;
  readonly patPortStart: number;
  readonly patPortEnd: number;
  readonly dynamicTimeoutNs: number;
  readonly tcpTimeoutNs: number;
  readonly udpTimeoutNs: number;
  readonly icmpTimeoutNs: number;
}

/**
 * Deterministic address/port translator. Routing and interface roles stay in
 * the owning Router/Firewall; this class only owns bounded configuration and
 * transient translations.
 */
export class NatEngine {
  private readonly rules = new Map<string, NatRule>();
  private readonly pools = new Map<string, NatPool>();
  private readonly translations = new Map<string, MutableNatTranslation>();
  private translationSerial = 0;

  constructor(private readonly limits: NatEngineLimits = NAT_RESOURCE_LIMITS) {
    validateLimits(limits);
  }

  definePool(pool: NatPool): void {
    validateId(pool.id, "NAT pool");
    const start = checkedIp(pool.startAddress);
    const end = checkedIp(pool.endAddress);
    if (start > end) {
      throw new NatError("NAT_INVALID_CONFIGURATION", `NAT pool '${pool.id}' start exceeds its end.`);
    }
    if (end - start + 1 > this.limits.maximumAddressesPerPool) {
      throw new NatError(
        "NAT_LIMIT_EXCEEDED",
        `NAT pool '${pool.id}' exceeds ${this.limits.maximumAddressesPerPool} addresses.`,
      );
    }
    if (!this.pools.has(pool.id) && this.pools.size >= this.limits.maximumPoolsPerDevice) {
      throw new NatError(
        "NAT_LIMIT_EXCEEDED",
        `NAT pool limit exceeded (${this.limits.maximumPoolsPerDevice}).`,
      );
    }
    this.pools.set(pool.id, { ...pool });
  }

  removePool(poolId: string): void {
    if ([...this.rules.values()].some((rule) => rule.kind === "dynamic" && rule.poolId === poolId)) {
      throw new NatError("NAT_INVALID_CONFIGURATION", `NAT pool '${poolId}' is still referenced by a rule.`);
    }
    this.pools.delete(poolId);
  }

  defineRule(rule: NatRule): void {
    validateRule(rule);
    if (rule.kind === "dynamic" && !this.pools.has(rule.poolId)) {
      throw new NatError("NAT_INVALID_CONFIGURATION", `NAT pool '${rule.poolId}' is not defined.`);
    }
    if (!this.rules.has(rule.id) && this.rules.size >= this.limits.maximumRulesPerDevice) {
      throw new NatError(
        "NAT_LIMIT_EXCEEDED",
        `NAT rule limit exceeded (${this.limits.maximumRulesPerDevice}).`,
      );
    }
    for (const existing of this.rules.values()) {
      if (existing.id === rule.id) continue;
      if (existing.sequence === rule.sequence) {
        throw new NatError("NAT_INVALID_CONFIGURATION", `Duplicate NAT sequence ${rule.sequence}.`);
      }
      if (existing.kind === "static" && rule.kind === "static"
        && (existing.insideLocal === rule.insideLocal || existing.insideGlobal === rule.insideGlobal)) {
        throw new NatError("NAT_INVALID_CONFIGURATION", "Static NAT addresses must be unique.");
      }
    }
    this.rules.set(rule.id, cloneRule(rule));
    this.removeTranslationsForRule(rule.id);
  }

  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
    this.removeTranslationsForRule(ruleId);
  }

  hasRules(): boolean {
    return this.rules.size > 0;
  }

  ruleConfigurations(): NatRule[] {
    return this.orderedRules().map(cloneRule);
  }

  poolConfigurations(): NatPool[] {
    return [...this.pools.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((pool) => ({ ...pool }));
  }

  /**
   * Source translation after route lookup. A non-selected packet is returned
   * unchanged; selected resource exhaustion is a typed failure.
   */
  translateOutbound(packet: Ipv4Packet, context: NatTranslationContext): NatTranslationResult {
    this.expire(context.nowNs);
    for (const rule of this.orderedRules()) {
      if (rule.kind === "static") {
        if (packet.src !== rule.insideLocal) continue;
        return {
          packet: { ...packet, src: rule.insideGlobal },
          translation: {
            id: `static:${rule.id}`,
            ruleId: rule.id,
            kind: "static",
            protocol: "ip",
            insideLocalAddress: rule.insideLocal,
            insideGlobalAddress: rule.insideGlobal,
            insideLocalToken: undefined,
            insideGlobalToken: undefined,
            remoteAddress: undefined,
            remoteToken: undefined,
            createdAtNs: 0,
            lastUsedAtNs: context.nowNs,
            expiresAtNs: undefined,
          },
        };
      }
      if (!selectorMatches(rule.source, packet, context.aclPermits)) continue;
      if (rule.kind === "dynamic") return this.translateDynamic(packet, rule, context.nowNs);
      return this.translatePat(packet, rule, context);
    }
    return { packet, translation: undefined };
  }

  /**
   * Destination translation before the outside inbound ACL. ACLs therefore see
   * the translated inside-local destination, a rule documented in README.
   */
  translateInbound(packet: Ipv4Packet, context: NatTranslationContext): NatTranslationResult {
    this.expire(context.nowNs);

    for (const rule of this.orderedRules()) {
      if (rule.kind === "static" && packet.dst === rule.insideGlobal) {
        return {
          packet: { ...packet, dst: rule.insideLocal },
          translation: {
            id: `static:${rule.id}`,
            ruleId: rule.id,
            kind: "static",
            protocol: "ip",
            insideLocalAddress: rule.insideLocal,
            insideGlobalAddress: rule.insideGlobal,
            insideLocalToken: undefined,
            insideGlobalToken: undefined,
            remoteAddress: undefined,
            remoteToken: undefined,
            createdAtNs: 0,
            lastUsedAtNs: context.nowNs,
            expiresAtNs: undefined,
          },
        };
      }
    }

    const token = packetToken(packet, "destination");
    for (const translation of this.translations.values()) {
      if (translation.insideGlobalAddress !== packet.dst) continue;
      if (translation.protocol !== "ip" && translation.protocol !== packet.protocol) continue;
      if (translation.kind === "pat") {
        if (token === undefined || token !== translation.insideGlobalToken) continue;
        const remoteSourceToken = packetToken(packet, "source");
        if (translation.remoteAddress !== packet.src) continue;
        if (translation.protocol !== IpProtocol.ICMP && translation.remoteToken !== remoteSourceToken) continue;
      }
      touchTranslation(translation, context.nowNs, this.timeoutFor(translation.protocol));
      return {
        packet: translateInboundPacket(packet, translation),
        translation: snapshotTranslation(translation),
      };
    }

    if (this.managesOutsideDestination(packet.dst, context.outsideInterfaceAddress)) {
      throw new NatError(
        "NAT_NO_TRANSLATION",
        `No active NAT translation for ${packet.dst}${token === undefined ? "" : `:${token}`}.`,
      );
    }
    return { packet, translation: undefined };
  }

  translationTable(nowNs: number): NatTranslation[] {
    this.expire(nowNs);
    return [...this.translations.values()]
      .map(snapshotTranslation)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  ownsOutsideAddress(address: Ipv4, outsideInterfaceAddress: Ipv4 | undefined): boolean {
    return this.managesOutsideDestination(address, outsideInterfaceAddress);
  }

  resetRuntime(): void {
    this.translations.clear();
    this.translationSerial = 0;
  }

  private translateDynamic(
    packet: Ipv4Packet,
    rule: DynamicNatRule,
    nowNs: number,
  ): NatTranslationResult {
    const key = `dynamic\u0000${rule.id}\u0000${packet.src}`;
    let translation = this.translations.get(key);
    if (!translation) {
      this.ensureTranslationCapacity();
      const pool = this.pools.get(rule.poolId)!;
      const global = this.allocatePoolAddress(pool);
      translation = this.createTranslation(key, {
        ruleId: rule.id,
        kind: "dynamic",
        protocol: "ip",
        insideLocalAddress: packet.src,
        insideGlobalAddress: global,
        insideLocalToken: undefined,
        insideGlobalToken: undefined,
        remoteAddress: undefined,
        remoteToken: undefined,
      }, nowNs, this.limits.dynamicTimeoutNs);
    } else {
      touchTranslation(translation, nowNs, this.limits.dynamicTimeoutNs);
    }
    return {
      packet: { ...packet, src: translation.insideGlobalAddress },
      translation: snapshotTranslation(translation),
    };
  }

  private translatePat(
    packet: Ipv4Packet,
    rule: PatNatRule,
    context: NatTranslationContext,
  ): NatTranslationResult {
    const localToken = packetToken(packet, "source");
    const remoteToken = packet.protocol === IpProtocol.ICMP
      ? undefined
      : packetToken(packet, "destination");
    if (localToken === undefined) {
      throw new NatError("NAT_NO_TRANSLATION", `PAT does not support IPv4 protocol ${packet.protocol}.`);
    }
    const globalAddress = rule.outsideAddress === "interface"
      ? context.outsideInterfaceAddress
      : rule.outsideAddress;
    if (!globalAddress) {
      throw new NatError("NAT_ROLE_MISSING", "PAT requires an addressed outside interface.");
    }
    const key = [
      "pat",
      rule.id,
      packet.protocol,
      packet.src,
      localToken,
      packet.dst,
      remoteToken ?? -1,
    ].join("\u0000");
    let translation = this.translations.get(key);
    if (!translation) {
      this.ensureTranslationCapacity();
      const translatedToken = this.allocatePatToken(globalAddress, packet.protocol);
      translation = this.createTranslation(key, {
        ruleId: rule.id,
        kind: "pat",
        protocol: policyProtocolOf(packet.protocol),
        insideLocalAddress: packet.src,
        insideGlobalAddress: globalAddress,
        insideLocalToken: localToken,
        insideGlobalToken: translatedToken,
        remoteAddress: packet.dst,
        remoteToken,
      }, context.nowNs, this.timeoutFor(policyProtocolOf(packet.protocol)));
    } else {
      touchTranslation(translation, context.nowNs, this.timeoutFor(policyProtocolOf(packet.protocol)));
    }
    return {
      packet: translateOutboundPacket(packet, translation),
      translation: snapshotTranslation(translation),
    };
  }

  private createTranslation(
    key: string,
    input: Omit<MutableNatTranslation, "id" | "createdAtNs" | "lastUsedAtNs" | "expiresAtNs">,
    nowNs: number,
    timeoutNs: number,
  ): MutableNatTranslation {
    const translation: MutableNatTranslation = {
      id: `nat-${++this.translationSerial}`,
      ...input,
      createdAtNs: nowNs,
      lastUsedAtNs: nowNs,
      expiresAtNs: nowNs + timeoutNs,
    };
    this.translations.set(key, translation);
    return translation;
  }

  private allocatePoolAddress(pool: NatPool): Ipv4 {
    const allocated = new Set(
      [...this.translations.values()]
        .filter((translation) => translation.kind === "dynamic")
        .map((translation) => translation.insideGlobalAddress),
    );
    const start = ipToInt(pool.startAddress);
    const end = ipToInt(pool.endAddress);
    for (let candidate = start; candidate <= end; candidate++) {
      const address = intToIp(candidate);
      if (!allocated.has(address)) return address;
    }
    throw new NatError("NAT_POOL_EXHAUSTED", `NAT pool '${pool.id}' has no free addresses.`);
  }

  private allocatePatToken(address: Ipv4, protocol: IpProtocol): number {
    const allocated = new Set(
      [...this.translations.values()]
        .filter((translation) =>
          translation.kind === "pat"
          && translation.insideGlobalAddress === address
          && translation.protocol === protocol)
        .map((translation) => translation.insideGlobalToken),
    );
    for (let token = this.limits.patPortStart; token <= this.limits.patPortEnd; token++) {
      if (!allocated.has(token)) return token;
    }
    throw new NatError("NAT_PORT_EXHAUSTED", `PAT token range ${this.limits.patPortStart}-${this.limits.patPortEnd} is exhausted.`);
  }

  private ensureTranslationCapacity(): void {
    if (this.translations.size >= this.limits.maximumRuntimeTranslations) {
      throw new NatError(
        "NAT_LIMIT_EXCEEDED",
        `NAT translation limit exceeded (${this.limits.maximumRuntimeTranslations}).`,
      );
    }
  }

  private timeoutFor(protocol: NatTranslationProtocol): number {
    if (protocol === IpProtocol.TCP) return this.limits.tcpTimeoutNs;
    if (protocol === IpProtocol.UDP) return this.limits.udpTimeoutNs;
    if (protocol === IpProtocol.ICMP) return this.limits.icmpTimeoutNs;
    return this.limits.dynamicTimeoutNs;
  }

  private expire(nowNs: number): void {
    for (const [key, translation] of this.translations) {
      if (translation.expiresAtNs !== undefined && translation.expiresAtNs <= nowNs) {
        this.translations.delete(key);
      }
    }
  }

  private managesOutsideDestination(address: Ipv4, outsideInterfaceAddress: Ipv4 | undefined): boolean {
    for (const rule of this.rules.values()) {
      if (rule.kind === "static" && rule.insideGlobal === address) return true;
      if (rule.kind === "pat") {
        const global = rule.outsideAddress === "interface" ? outsideInterfaceAddress : rule.outsideAddress;
        if (global === address) return true;
      }
      if (rule.kind === "dynamic") {
        const pool = this.pools.get(rule.poolId);
        if (pool && ipToInt(address) >= ipToInt(pool.startAddress) && ipToInt(address) <= ipToInt(pool.endAddress)) {
          return true;
        }
      }
    }
    return false;
  }

  private orderedRules(): NatRule[] {
    return [...this.rules.values()].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  }

  private removeTranslationsForRule(ruleId: string): void {
    for (const [key, translation] of this.translations) {
      if (translation.ruleId === ruleId) this.translations.delete(key);
    }
  }
}

function selectorMatches(
  selector: NatSourceSelector,
  packet: Ipv4Packet,
  aclPermits: NatTranslationContext["aclPermits"],
): boolean {
  if (selector.kind === "any") return true;
  if (!aclPermits) {
    throw new NatError("NAT_INVALID_CONFIGURATION", `NAT selector requires ACL '${selector.aclId}'.`);
  }
  return aclPermits(selector.aclId, packet);
}

function packetToken(packet: Ipv4Packet, side: "source" | "destination"): number | undefined {
  if (packet.payload.kind === "tcp" || packet.payload.kind === "udp") {
    return side === "source" ? packet.payload.srcPort : packet.payload.dstPort;
  }
  if (packet.payload.kind === "icmp") return packet.payload.identifier;
  return undefined;
}

function translateOutboundPacket(packet: Ipv4Packet, translation: NatTranslation): Ipv4Packet {
  const payload = packet.payload.kind === "tcp" || packet.payload.kind === "udp"
    ? { ...packet.payload, srcPort: translation.insideGlobalToken! }
    : { ...packet.payload, identifier: translation.insideGlobalToken! };
  return { ...packet, src: translation.insideGlobalAddress, payload };
}

function translateInboundPacket(packet: Ipv4Packet, translation: NatTranslation): Ipv4Packet {
  if (translation.kind !== "pat") return { ...packet, dst: translation.insideLocalAddress };
  const payload = packet.payload.kind === "tcp" || packet.payload.kind === "udp"
    ? { ...packet.payload, dstPort: translation.insideLocalToken! }
    : { ...packet.payload, identifier: translation.insideLocalToken! };
  return { ...packet, dst: translation.insideLocalAddress, payload };
}

function touchTranslation(translation: MutableNatTranslation, nowNs: number, timeoutNs: number): void {
  translation.lastUsedAtNs = nowNs;
  translation.expiresAtNs = nowNs + timeoutNs;
}

function snapshotTranslation(translation: NatTranslation): NatTranslation {
  return { ...translation };
}

function cloneRule(rule: NatRule): NatRule {
  if (rule.kind === "static") return { ...rule };
  return { ...rule, source: { ...rule.source } };
}

function validateRule(rule: NatRule): void {
  validateId(rule.id, "NAT rule");
  if (!Number.isSafeInteger(rule.sequence) || rule.sequence < 0) {
    throw new NatError("NAT_INVALID_CONFIGURATION", "NAT sequence must be a non-negative integer.");
  }
  if (rule.kind === "static") {
    checkedIp(rule.insideLocal);
    checkedIp(rule.insideGlobal);
  } else if (rule.source.kind === "acl") {
    validateId(rule.source.aclId, "NAT source ACL");
  }
  if (rule.kind === "pat" && rule.outsideAddress !== "interface") checkedIp(rule.outsideAddress);
}

function validateLimits(limits: NatEngineLimits): void {
  const integerFields = [
    limits.maximumRulesPerDevice,
    limits.maximumPoolsPerDevice,
    limits.maximumAddressesPerPool,
    limits.maximumRuntimeTranslations,
    limits.patPortStart,
    limits.patPortEnd,
    limits.dynamicTimeoutNs,
    limits.tcpTimeoutNs,
    limits.udpTimeoutNs,
    limits.icmpTimeoutNs,
  ];
  if (integerFields.some((value) => !Number.isSafeInteger(value) || value < 0)
    || limits.patPortStart > limits.patPortEnd
    || limits.patPortEnd > 65_535) {
    throw new NatError("NAT_INVALID_CONFIGURATION", "Invalid NAT resource limits.");
  }
}

function validateId(id: string, label: string): void {
  if (id.trim().length === 0) throw new NatError("NAT_INVALID_CONFIGURATION", `${label} ID is required.`);
}

function checkedIp(address: Ipv4): number {
  try {
    return ipToInt(address);
  } catch (error) {
    throw new NatError(
      "NAT_INVALID_CONFIGURATION",
      error instanceof Error ? error.message : `Invalid IPv4 address '${address}'.`,
    );
  }
}
