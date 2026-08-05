import type { Ipv4 } from "../util/ipv4";
import type { EthernetFrame } from "./ethernet";

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
 * One VXLAN-encapsulated Ethernet frame.
 *
 * This is a structured educational model, not a byte layout: the inner frame is
 * carried as an object so the receiving VTEP switches exactly the frame the
 * sender put in. `sourceVtep`/`destinationVtep` mirror the outer IPv4 header so
 * a trace and a `show` command can name the tunnel endpoints without reaching
 * back into the packet that transported it.
 */
export interface VxlanPacket {
  readonly kind: "vxlan";
  readonly vni: number;
  readonly innerFrame: EthernetFrame;
  readonly sourceVtep: Ipv4;
  readonly destinationVtep: Ipv4;
}

export function isVxlanPacket(value: unknown): value is VxlanPacket {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "vxlan";
}

export function isValidVni(value: number): boolean {
  return Number.isInteger(value) && value >= MINIMUM_VNI && value <= MAXIMUM_VNI;
}

/**
 * Stable per-flow outer source port. Only fields the engine actually models
 * take part, so every frame of one conversation leaves with the same entropy
 * and two engines always agree.
 */
export function vxlanSourcePort(vni: number, frame: EthernetFrame): number {
  let hash = 2_166_136_261;
  for (const char of `${vni}:${frame.src}:${frame.dst}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  }
  const range = VXLAN_SOURCE_PORT_END - VXLAN_SOURCE_PORT_START + 1;
  return VXLAN_SOURCE_PORT_START + (hash % range);
}
