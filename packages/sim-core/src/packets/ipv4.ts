import type { IpProtocol } from "@sim/contracts";
import type { Ipv4 } from "../util/ipv4";
import type { GrePacket } from "./gre";
import type { IcmpMessage } from "./icmp";
import type { OspfPacket } from "./ospf";
import type { UdpDatagram } from "./udp";
import type { TcpSegment } from "./tcp";

/**
 * Upper-layer payloads carried in IPv4. Extended as protocols are added.
 *
 * `GrePacket` makes the union recursive: a tunnelled packet is an ordinary IPv4
 * packet nested inside another one, which is exactly what an intermediate
 * router sees — outer addresses and protocol only.
 */
export type Ipv4Payload = IcmpMessage | UdpDatagram | TcpSegment | OspfPacket | GrePacket;

export interface Ipv4Packet {
  readonly kind: "ipv4";
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly protocol: IpProtocol;
  /**
   * Differentiated Services Code Point, 0-63. Absent means the packet has never
   * been marked and is treated as `default` (0).
   */
  readonly dscp?: number;
  /** Time-to-live; decremented on each router hop, dropped (TimeExceeded) at 0. */
  ttl: number;
  readonly payload: Ipv4Payload;
}
