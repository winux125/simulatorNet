import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";
import type { EthernetFrame } from "./ethernet";
import type { Ipv4Packet } from "./ipv4";

/** The IANA VXLAN destination port. The outer transport is ordinary UDP. */
export const VXLAN_UDP_PORT = 4789;

/** Flags + reserved + 24-bit VNI + reserved, exactly as the header is laid out. */
export const VXLAN_HEADER_BYTES = 8;

export const MINIMUM_VNI = 1;
export const MAXIMUM_VNI = 16_777_215;

/**
 * Deterministic source-port entropy range. A real VTEP hashes the inner flow
 * into an ephemeral source port so the underlay can load-share; SimulatorNet
 * derives the same value from the inner addresses, so the number is stable for
 * one conversation and never random.
 */
export const VXLAN_SOURCE_PORT_START = 49_152;
export const VXLAN_SOURCE_PORT_END = 65_535;

/**
 * The outer identity every VXLAN packet carries.
 *
 * This is a structured educational model, not a byte layout. `sourceVtep`/
 * `destinationVtep` mirror the outer IPv4 header so a trace and a `show` command
 * can name the tunnel endpoints without reaching back into the packet that
 * transported it.
 */
interface VxlanPacketBase {
  readonly kind: "vxlan";
  readonly vni: number;
  readonly sourceVtep: Ipv4;
  readonly destinationVtep: Ipv4;
}

/**
 * An L2VNI packet: one bridged Ethernet frame. The inner frame is carried as an
 * object so the receiving VTEP switches exactly the frame the sender put in.
 */
export interface VxlanL2Packet extends VxlanPacketBase {
  readonly payloadKind: "l2";
  readonly innerFrame: EthernetFrame;
  /**
   * The Ethernet Segment the frame entered the fabric on, when it entered on a
   * multihomed attachment.
   *
   * This is simulator metadata carried beside the packet, never an Ethernet or
   * VXLAN header field: it is what lets another VTEP attached to the *same*
   * segment refuse to send the frame straight back to the CE it came from.
   */
  readonly sourceEsi?: string;
}

/**
 * An L3VNI packet: one *routed* IPv4 packet, as symmetric IRB transports it.
 *
 * The ingress VTEP already made its VRF routing decision, so no Ethernet header
 * crosses the fabric — the egress VTEP repeats the lookup in the VRF the VNI
 * names and builds a fresh frame for the local segment. `innerSourceMac` is
 * simulator metadata for the trace, never a real VXLAN header field.
 */
export interface VxlanL3Packet extends VxlanPacketBase {
  readonly payloadKind: "l3";
  readonly innerPacket: Ipv4Packet;
  readonly innerSourceMac: Mac;
}

export type VxlanPacket = VxlanL2Packet | VxlanL3Packet;

export function isVxlanPacket(value: unknown): value is VxlanPacket {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "vxlan";
}

/** What one VXLAN packet transports, for a size estimate or an MTU decision. */
export type VxlanInnerPayload = EthernetFrame | Ipv4Packet;

export function vxlanInnerPayload(packet: VxlanPacket): VxlanInnerPayload {
  return packet.payloadKind === "l3" ? packet.innerPacket : packet.innerFrame;
}

export function isValidVni(value: number): boolean {
  return Number.isInteger(value) && value >= MINIMUM_VNI && value <= MAXIMUM_VNI;
}

/**
 * Stable per-flow outer source port. Only fields the engine actually models
 * take part, so every frame of one conversation leaves with the same entropy
 * and two engines always agree.
 */
export function vxlanSourcePort(vni: number, inner: VxlanInnerPayload): number {
  // An L2VNI hashes the inner MACs, an L3VNI the routed IPv4 endpoints; both
  // are fields the engine actually models, so two engines always agree.
  let hash = 2_166_136_261;
  for (const char of `${vni}:${inner.src}:${inner.dst}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  const range = VXLAN_SOURCE_PORT_END - VXLAN_SOURCE_PORT_START + 1;
  return VXLAN_SOURCE_PORT_START + (hash % range);
}
