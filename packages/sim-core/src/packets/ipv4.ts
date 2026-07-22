import type { IpProtocol } from "@sim/contracts";
import type { Ipv4 } from "../util/ipv4";
import type { IcmpMessage } from "./icmp";

/** Upper-layer payloads carried in IPv4. Extended as protocols are added. */
export type Ipv4Payload = IcmpMessage;

export interface Ipv4Packet {
  readonly kind: "ipv4";
  readonly src: Ipv4;
  readonly dst: Ipv4;
  readonly protocol: IpProtocol;
  /** Time-to-live; decremented per router hop (routing lands next milestone). */
  ttl: number;
  readonly payload: Ipv4Payload;
}
