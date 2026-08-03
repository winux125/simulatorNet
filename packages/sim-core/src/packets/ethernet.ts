import type { EtherType } from "@sim/contracts";
import type { Mac } from "../util/mac";
import type { ArpPacket } from "./arp";
import type { BpduPacket } from "./bpdu";
import type { CdpPacket, LldpPacket } from "./discovery";
import type { LacpPacket, PagpPacket } from "./etherchannel";
import type { Ipv4Packet } from "./ipv4";
import type { Ipv6Packet } from "./ipv6";
import type { MplsPacket } from "./mpls";

/**
 * Link-local control payloads. They are consumed by the receiving device's
 * control plane and are never routed, NATed, or filtered by an IP ACL.
 */
export type L2ControlPayload = BpduPacket | LacpPacket | PagpPacket | CdpPacket | LldpPacket;

const CONTROL_PAYLOAD_KINDS = new Set(["bpdu", "lacp", "pagp", "cdp", "lldp"]);

/** Payloads an Ethernet frame can carry, discriminated by `kind`. */
export type L2Payload = ArpPacket | Ipv4Packet | Ipv6Packet | MplsPacket | L2ControlPayload;

/** True for a payload handled by a device's link-local control plane. */
export function isControlPayload(payload: L2Payload): payload is L2ControlPayload {
  return CONTROL_PAYLOAD_KINDS.has(payload.kind);
}

export interface EthernetFrame {
  readonly src: Mac;
  readonly dst: Mac;
  readonly etherType: EtherType;
  /** 802.1Q VLAN id carried on the wire; undefined = untagged. */
  readonly vlan?: number;
  /**
   * 802.1p priority code point, 0-7. It only exists inside an 802.1Q tag, so it
   * is meaningful only when `vlan` is set; an untagged frame never carries one.
   */
  readonly pcp?: number;
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
