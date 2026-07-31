import type { Ipv4Packet } from "./ipv4";
import type { Ipv6Packet } from "./ipv6";

/**
 * Structured Generic Routing Encapsulation.
 *
 * SimulatorNet never serializes a packet to bytes, so a GRE tunnel carries the
 * inner packet as a typed object rather than a raw byte buffer. The outer IPv4
 * packet that transports this payload is an ordinary `Ipv4Packet` with protocol
 * `IpProtocol.GRE`, so it is routed, filtered, translated and queued by exactly
 * the same underlay pipeline as any other packet.
 */
export interface GrePacket {
  readonly kind: "gre";
  /** The inner protocol the tunnel is transporting. */
  readonly protocol: "ipv4" | "ipv6";
  readonly innerPacket: Ipv4Packet | Ipv6Packet;
  /** Logical interface that encapsulated this packet, e.g. "Tunnel0". */
  readonly tunnelId: string;
}

/**
 * Educational GRE header size: 2 flag bytes plus a 2-byte protocol type. The
 * optional key, sequence and checksum fields are not modelled.
 */
export const GRE_HEADER_BYTES = 4;

export function isGrePacket(payload: { kind: string }): payload is GrePacket {
  return payload.kind === "gre";
}
