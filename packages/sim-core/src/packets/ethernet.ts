import type { EtherType } from "@sim/contracts";
import type { Mac } from "../util/mac";
import type { ArpPacket } from "./arp";
import type { Ipv4Packet } from "./ipv4";

/** Layer-3 payloads an Ethernet frame can carry, discriminated by `kind`. */
export type L2Payload = ArpPacket | Ipv4Packet;

export interface EthernetFrame {
  readonly src: Mac;
  readonly dst: Mac;
  readonly etherType: EtherType;
  /** 802.1Q VLAN id; undefined = untagged. Full VLAN handling lands next milestone. */
  readonly vlan?: number;
  readonly payload: L2Payload;
}
