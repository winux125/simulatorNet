import type { Icmpv6Message } from "./icmpv6";
import type { TcpSegment } from "./tcp";
import type { UdpDatagram } from "./udp";
import type { Ospfv3Packet } from "./ospfv3";
import type { Ipv6 } from "../util/ipv6";

export const Ipv6NextHeader = {
  TCP: 6,
  UDP: 17,
  ICMPv6: 58,
  OSPF: 89,
} as const;
export type Ipv6NextHeader = (typeof Ipv6NextHeader)[keyof typeof Ipv6NextHeader];

/** Extended by DHCPv6 and OSPFv3 without introducing a second IP stack. */
export type Ipv6Payload = Icmpv6Message | UdpDatagram | TcpSegment | Ospfv3Packet;

export interface Ipv6Packet {
  readonly kind: "ipv6";
  readonly src: Ipv6;
  readonly dst: Ipv6;
  readonly nextHeader: Ipv6NextHeader;
  /**
   * Traffic Class DSCP bits, 0-63. Absent means unmarked; the low ECN bits are
   * deliberately not modelled.
   */
  readonly trafficClass?: number;
  /** Decremented at each routed hop; hosts never decrement it. */
  readonly hopLimit: number;
  readonly payload: Ipv6Payload;
}
