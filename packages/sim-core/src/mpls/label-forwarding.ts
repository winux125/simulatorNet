import type { Ipv4 } from "../util/ipv4";
import {
  MPLS_FIRST_DYNAMIC_LABEL,
  MPLS_IMPLICIT_NULL_LABEL,
  MPLS_MAX_LABEL,
  mplsPayloadTrafficClass,
  mplsPayloadTtl,
  withMplsPayloadTtl,
  type MplsLabelEntry,
  type MplsPacket,
  type MplsPayload,
} from "../packets/mpls";
import type { Ipv4Packet } from "../packets/ipv4";
import type { Ipv6Packet } from "../packets/ipv6";
import { DEFAULT_MPLS_LIMITS, MplsConfigurationError, MplsLimitError, type MplsLimits } from "./limits";

export type MplsLabelOperation =
  | { readonly type: "push"; readonly labels: readonly number[] }
  | { readonly type: "swap"; readonly outgoingLabel: number }
  | { readonly type: "pop" }
  | { readonly type: "deliver"; readonly vrfId?: string }
  | { readonly type: "drop"; readonly reason: string };

export interface MplsForwardingEntry {
  readonly incomingLabel: number;
  readonly fec: string;
  readonly operation: MplsLabelOperation;
  readonly nextHop?: Ipv4;
  readonly outgoingInterfaceId?: string;
  readonly source: "ldp" | "vpn" | "local";
}

export type MplsForwardingDecision =
  | { readonly kind: "mpls"; readonly packet: MplsPacket; readonly entry: MplsForwardingEntry }
  | { readonly kind: "ipv4"; readonly packet: Ipv4Packet; readonly entry: MplsForwardingEntry }
  | { readonly kind: "ipv6"; readonly packet: Ipv6Packet; readonly entry: MplsForwardingEntry }
  | { readonly kind: "deliver"; readonly packet: MplsPayload; readonly vrfId?: string; readonly entry: MplsForwardingEntry }
  | { readonly kind: "drop"; readonly reason: "empty-label-stack" | "unknown-label" | "ttl-exceeded" | "configured-drop"; readonly detail: string; readonly incomingLabel?: number };

/**
 * Deterministic label allocator. Callers provide the complete FEC set; sorting
 * before allocation makes labels independent of Map insertion or discovery order.
 */
export class DeterministicLabelAllocator {
  private readonly labelsByFec = new Map<string, number>();

  constructor(private readonly limits: MplsLimits = DEFAULT_MPLS_LIMITS) {}

  allocateAll(fecs: readonly string[]): ReadonlyMap<string, number> {
    const canonical = [...new Set(fecs)].sort((a, b) => a.localeCompare(b));
    if (canonical.length > this.limits.maximumLabelsPerRouter) {
      throw new MplsLimitError("maximumLabelsPerRouter", canonical.length, this.limits.maximumLabelsPerRouter);
    }
    this.labelsByFec.clear();
    canonical.forEach((fec, index) => this.labelsByFec.set(fec, MPLS_FIRST_DYNAMIC_LABEL + index));
    return new Map(this.labelsByFec);
  }

  labelFor(fec: string): number | undefined {
    return this.labelsByFec.get(fec);
  }

  clear(): void {
    this.labelsByFec.clear();
  }
}

/** Pure LFIB and label-stack processor; physical transmission stays on Router. */
export class MplsForwardingPlane {
  private readonly enabledInterfaces = new Set<string>();
  private readonly entries = new Map<number, MplsForwardingEntry>();
  private forwardingEvents = 0;

  constructor(private readonly limits: MplsLimits = DEFAULT_MPLS_LIMITS) {}

  setInterfaceEnabled(interfaceId: string, enabled: boolean): void {
    if (enabled) this.enabledInterfaces.add(interfaceId);
    else this.enabledInterfaces.delete(interfaceId);
  }

  interfaceEnabled(interfaceId: string): boolean {
    return this.enabledInterfaces.has(interfaceId);
  }

  enabledInterfaceIds(): readonly string[] {
    return [...this.enabledInterfaces].sort((a, b) => a.localeCompare(b));
  }

  install(entry: MplsForwardingEntry): void {
    validateDynamicLabel(entry.incomingLabel, "incoming label");
    validateOperation(entry.operation, this.limits.maximumLabelStackDepth);
    const nextSize = this.entries.has(entry.incomingLabel) ? this.entries.size : this.entries.size + 1;
    if (nextSize > this.limits.maximumLfibEntriesPerLab) {
      throw new MplsLimitError("maximumLfibEntriesPerLab", nextSize, this.limits.maximumLfibEntriesPerLab);
    }
    this.entries.set(entry.incomingLabel, freezeEntry(entry));
  }

  remove(incomingLabel: number): boolean {
    return this.entries.delete(incomingLabel);
  }

  removeBySource(source: MplsForwardingEntry["source"]): number {
    let removed = 0;
    for (const [label, entry] of this.entries) {
      if (entry.source !== source) continue;
      this.entries.delete(label);
      removed++;
    }
    return removed;
  }

  clearRuntime(): void {
    this.entries.clear();
    this.forwardingEvents = 0;
  }

  resetOperationBudget(): void {
    this.forwardingEvents = 0;
  }

  forwardingTable(): readonly MplsForwardingEntry[] {
    return [...this.entries.values()]
      .sort((a, b) => a.incomingLabel - b.incomingLabel)
      .map(freezeEntry);
  }

  /**
   * The uniform model copies the payload's own hop count into every imposed
   * label, so an IPv6 payload behaves exactly like an IPv4 one across the core.
   */
  impose(payload: MplsPayload, labels: readonly number[]): MplsPacket {
    if (labels.length === 0) throw new MplsConfigurationError("An MPLS label stack cannot be empty.");
    if (labels.length > this.limits.maximumLabelStackDepth) {
      throw new MplsLimitError("maximumLabelStackDepth", labels.length, this.limits.maximumLabelStackDepth);
    }
    labels.forEach((label) => validateDynamicLabel(label, "imposed label"));
    const trafficClass = mplsPayloadTrafficClass(payload);
    const ttl = mplsPayloadTtl(payload);
    return {
      kind: "mpls",
      labels: labels.map((label, index): MplsLabelEntry => ({
        label,
        trafficClass,
        bottomOfStack: index === labels.length - 1,
        ttl,
      })),
      payload,
    };
  }

  forward(packet: MplsPacket): MplsForwardingDecision {
    this.forwardingEvents++;
    if (this.forwardingEvents > this.limits.maximumForwardingEventsPerOperation) {
      throw new MplsLimitError(
        "maximumForwardingEventsPerOperation",
        this.forwardingEvents,
        this.limits.maximumForwardingEventsPerOperation,
      );
    }
    const top = packet.labels[0];
    if (!top) return { kind: "drop", reason: "empty-label-stack", detail: "MPLS packet has no top label." };
    if (top.ttl <= 1) {
      return { kind: "drop", reason: "ttl-exceeded", detail: `MPLS TTL expired for label ${top.label}.`, incomingLabel: top.label };
    }
    const entry = this.entries.get(top.label);
    if (!entry) {
      return { kind: "drop", reason: "unknown-label", detail: `No LFIB entry for label ${top.label}.`, incomingLabel: top.label };
    }
    if (entry.operation.type === "drop") {
      return { kind: "drop", reason: "configured-drop", detail: entry.operation.reason, incomingLabel: top.label };
    }

    const decremented: MplsLabelEntry = { ...top, ttl: top.ttl - 1 };
    let labels = [decremented, ...packet.labels.slice(1)];
    switch (entry.operation.type) {
      case "push": {
        const pushed = entry.operation.labels.map((label): MplsLabelEntry => ({
          label,
          trafficClass: decremented.trafficClass,
          bottomOfStack: false,
          ttl: decremented.ttl,
        }));
        labels = normalizeBottomOfStack([...pushed, ...labels]);
        break;
      }
      case "swap":
        labels = normalizeBottomOfStack([{ ...decremented, label: entry.operation.outgoingLabel }, ...labels.slice(1)]);
        break;
      case "pop":
        labels = normalizeBottomOfStack(labels.slice(1));
        break;
      case "deliver":
        return {
          kind: "deliver",
          packet: withMplsPayloadTtl(packet.payload, decremented.ttl),
          vrfId: entry.operation.vrfId,
          entry,
        };
    }
    if (labels.length === 0) {
      const payload = withMplsPayloadTtl(packet.payload, decremented.ttl);
      return payload.kind === "ipv4"
        ? { kind: "ipv4", packet: payload, entry }
        : { kind: "ipv6", packet: payload, entry };
    }
    return { kind: "mpls", packet: { ...packet, labels }, entry };
  }
}

function validateLabel(label: number, field: string): void {
  if (!Number.isInteger(label) || label < 0 || label > MPLS_MAX_LABEL) {
    throw new MplsConfigurationError(`${field} must be an integer between 0 and ${MPLS_MAX_LABEL}.`);
  }
}

function validateDynamicLabel(label: number, field: string): void {
  validateLabel(label, field);
  if (label < MPLS_FIRST_DYNAMIC_LABEL) {
    throw new MplsConfigurationError(`${field} ${label} is reserved; dynamic labels start at ${MPLS_FIRST_DYNAMIC_LABEL}.`);
  }
}

function validateOperation(operation: MplsLabelOperation, maximumDepth: number): void {
  if (operation.type === "push") {
    if (operation.labels.length === 0 || operation.labels.length > maximumDepth) {
      throw new MplsConfigurationError(`Push operation requires 1-${maximumDepth} labels.`);
    }
    operation.labels.forEach((label) => validateDynamicLabel(label, "pushed label"));
  } else if (operation.type === "swap") {
    if (operation.outgoingLabel === MPLS_IMPLICIT_NULL_LABEL) {
      throw new MplsConfigurationError("Implicit null is represented by a pop operation, not swap label 3.");
    }
    validateDynamicLabel(operation.outgoingLabel, "outgoing label");
  }
}

function normalizeBottomOfStack(labels: readonly MplsLabelEntry[]): MplsLabelEntry[] {
  return labels.map((entry, index) => ({ ...entry, bottomOfStack: index === labels.length - 1 }));
}

function freezeEntry(entry: MplsForwardingEntry): MplsForwardingEntry {
  return {
    ...entry,
    operation: entry.operation.type === "push"
      ? { ...entry.operation, labels: [...entry.operation.labels] }
      : { ...entry.operation },
  };
}
