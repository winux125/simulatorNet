import type { ArpOp } from "@sim/contracts";
import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";

export interface ArpPacket {
  readonly kind: "arp";
  readonly op: ArpOp;
  readonly senderMac: Mac;
  readonly senderIp: Ipv4;
  /** Zeroed in a request; filled in a reply. */
  readonly targetMac: Mac;
  readonly targetIp: Ipv4;
}
