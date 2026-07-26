import type { Mac } from "../util/mac";

/**
 * Structured Spanning Tree BPDUs.
 *
 * SimulatorNet never serializes protocol frames to bytes, so a BPDU is a plain
 * structured message just like an ARP packet or a DHCP message. Field names
 * follow IEEE 802.1D/802.1w so the model stays readable next to the standard,
 * but this is an educational subset, not wire-format parity.
 */

/** `spanning-tree mode pvst` (802.1D-like) or `rapid-pvst` (802.1w-like). */
export type SpanningTreeProtocolVersion = "stp" | "rstp";

export type BpduType = "configuration" | "topology-change-notification";

export type BpduPortRole = "root" | "designated" | "alternate" | "backup" | "unknown";

/** Bridge priority + VLAN extended system id + the stable bridge MAC. */
export interface BridgeIdentifier {
  readonly priority: number;
  readonly vlanId: number;
  readonly mac: Mac;
}

/** Port priority + the stable port number derived from the interface order. */
export interface PortIdentifier {
  readonly priority: number;
  readonly number: number;
}

export interface BpduPacket {
  readonly kind: "bpdu";
  readonly version: SpanningTreeProtocolVersion;
  readonly type: BpduType;
  /** PVST-like: every BPDU belongs to exactly one VLAN instance. */
  readonly vlanId: number;
  readonly rootId: BridgeIdentifier;
  readonly rootPathCost: number;
  readonly bridgeId: BridgeIdentifier;
  readonly portId: PortIdentifier;
  readonly messageAgeNs: number;
  readonly maxAgeNs: number;
  readonly helloTimeNs: number;
  readonly forwardDelayNs: number;
  readonly topologyChange: boolean;
  readonly topologyChangeAck: boolean;
  /** 802.1w proposal flag set by a designated port on a point-to-point link. */
  readonly proposal?: boolean;
  /** 802.1w agreement flag returned by the peer's new root port. */
  readonly agreement?: boolean;
  readonly role?: BpduPortRole;
  readonly learning?: boolean;
  readonly forwarding?: boolean;
  readonly edge?: boolean;
}

/** Compare two bridge identifiers; negative when `a` is superior. */
export function compareBridgeId(a: BridgeIdentifier, b: BridgeIdentifier): number {
  const aValue = a.priority + a.vlanId;
  const bValue = b.priority + b.vlanId;
  if (aValue !== bValue) return aValue - bValue;
  return a.mac.localeCompare(b.mac);
}

/** Compare two port identifiers; negative when `a` is superior. */
export function comparePortId(a: PortIdentifier, b: PortIdentifier): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.number - b.number;
}

export function formatBridgeId(id: BridgeIdentifier): string {
  return `${id.priority + id.vlanId}.${id.mac}`;
}

export function formatPortId(id: PortIdentifier): string {
  return `${id.priority}.${id.number}`;
}

export function bridgeIdEquals(a: BridgeIdentifier, b: BridgeIdentifier): boolean {
  return compareBridgeId(a, b) === 0;
}
