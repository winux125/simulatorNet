import type { Ipv4Packet } from "./ipv4";
import type { Ipv6Packet } from "./ipv6";

/** One structured MPLS shim entry. No raw wire encoding is attempted. */
export interface MplsLabelEntry {
  readonly label: number;
  readonly trafficClass: number;
  readonly bottomOfStack: boolean;
  readonly ttl: number;
}

/**
 * A label stack transports either IP family. There is deliberately no second
 * "MPLSv6" forwarding engine: the label operations are identical and only the
 * payload's own hop-count field differs.
 */
export type MplsPayload = Ipv4Packet | Ipv6Packet;

/** The first entry is the top label. */
export interface MplsPacket {
  readonly kind: "mpls";
  readonly labels: readonly MplsLabelEntry[];
  readonly payload: MplsPayload;
}

/** The payload's hop count, whatever the family calls it. */
export function mplsPayloadTtl(payload: MplsPayload): number {
  return payload.kind === "ipv4" ? payload.ttl : payload.hopLimit;
}

/** Restore a hop count into the payload after the label stack is gone. */
export function withMplsPayloadTtl(payload: MplsPayload, ttl: number): MplsPayload {
  return payload.kind === "ipv4" ? { ...payload, ttl } : { ...payload, hopLimit: ttl };
}

/** Ingress Traffic Class, derived from the payload's own DSCP field. */
export function mplsPayloadTrafficClass(payload: MplsPayload): number {
  const dscp = payload.kind === "ipv4" ? payload.dscp : payload.trafficClass;
  return Math.min(7, Math.max(0, Math.floor((dscp ?? 0) / 8)));
}

export const MPLS_IMPLICIT_NULL_LABEL = 3;
export const MPLS_FIRST_DYNAMIC_LABEL = 16;
export const MPLS_MAX_LABEL = 1_048_575;
/** One shim entry on the wire; the size model and the MTU check share it. */
export const MPLS_LABEL_STACK_ENTRY_BYTES = 4;

export function isReservedMplsLabel(label: number): boolean {
  return Number.isInteger(label) && label >= 0 && label < MPLS_FIRST_DYNAMIC_LABEL;
}
