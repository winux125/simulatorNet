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
  /** 802.1Q VLAN id carried on the wire; undefined = untagged. */
  readonly vlan?: number;
  readonly payload: L2Payload;
}

export const DEFAULT_FRAME_TRAVERSAL_BUDGET = 64;

const traversalBudget = Symbol("simulatornet.frame-traversal-budget");
type InternalEthernetFrame = EthernetFrame & { [traversalBudget]?: number };

/** Internal simulator safety metadata. Symbol keys never become wire fields or JSON. */
export function nextFrameTraversal(frame: EthernetFrame): EthernetFrame | undefined {
  const current = (frame as InternalEthernetFrame)[traversalBudget] ?? DEFAULT_FRAME_TRAVERSAL_BUDGET;
  if (current <= 0) return undefined;
  const next: InternalEthernetFrame = { ...frame, [traversalBudget]: current - 1 };
  return next;
}

export function frameTraversalBudget(frame: EthernetFrame): number {
  return (frame as InternalEthernetFrame)[traversalBudget] ?? DEFAULT_FRAME_TRAVERSAL_BUDGET;
}
