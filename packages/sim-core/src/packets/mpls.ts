import type { Ipv4Packet } from "./ipv4";

/** One structured MPLS shim entry. No raw wire encoding is attempted. */
export interface MplsLabelEntry {
  readonly label: number;
  readonly trafficClass: number;
  readonly bottomOfStack: boolean;
  readonly ttl: number;
}

/** M10.11 carries IPv4 only. The first entry is the top label. */
export interface MplsPacket {
  readonly kind: "mpls";
  readonly labels: readonly MplsLabelEntry[];
  readonly payload: Ipv4Packet;
}

export const MPLS_IMPLICIT_NULL_LABEL = 3;
export const MPLS_FIRST_DYNAMIC_LABEL = 16;
export const MPLS_MAX_LABEL = 1_048_575;

export function isReservedMplsLabel(label: number): boolean {
  return Number.isInteger(label) && label >= 0 && label < MPLS_FIRST_DYNAMIC_LABEL;
}
