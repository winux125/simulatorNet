import type { IpProtocol } from "@sim/contracts";
import type { Ipv4 } from "../util/ipv4";
import type { IcmpMessage } from "./icmp";
import type { UdpDatagram } from "./udp";

/** Upper-layer payloads carried in IPv4. Extended as protocols are added. */
export type Ipv4Payload = IcmpMessage | UdpDatagram;

export interface Ipv4Packet {
  readonly kind: "ipv4";
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly protocol: IpProtocol;
  /** Time-to-live; decremented on each router hop, dropped (TimeExceeded) at 0. */
  ttl: number;
  readonly payload: Ipv4Payload;
}
