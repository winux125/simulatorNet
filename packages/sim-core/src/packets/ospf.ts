import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";

/**
 * Structured OSPFv2 packets and link-state advertisements.
 *
 * This is an educational IPv4 subset: one process per device, area 0 only,
 * broadcast and point-to-point Ethernet, Router and Network LSAs. Multiple
 * areas, ABR/ASBR behaviour, external LSAs, redistribution, stub/NSSA areas,
 * summaries, virtual links, authentication, OSPFv3, graceful restart and demand
 * circuits are all deliberately out of scope. Packets are structured messages,
 * never RFC 2328 bytes.
 */

/** IP protocol number carried in the IPv4 header. */
export const OSPF_PROTOCOL = 89;

export const OSPF_ALL_ROUTERS: Ipv4 = "224.0.0.5";
export const OSPF_ALL_DESIGNATED_ROUTERS: Ipv4 = "224.0.0.6";
/** IANA IPv4 multicast MAC mappings for the two OSPF groups. */
export const OSPF_ALL_ROUTERS_MAC: Mac = "01:00:5e:00:00:05";
export const OSPF_ALL_DESIGNATED_ROUTERS_MAC: Mac = "01:00:5e:00:00:06";

/** The only area this milestone supports. */
export const OSPF_BACKBONE_AREA = 0;

export type OspfNetworkType = "broadcast" | "point-to-point";

export type OspfNeighborState =
  | "down"
  | "init"
  | "two-way"
  | "exstart"
  | "exchange"
  | "loading"
  | "full";

export type OspfLsaType = "router" | "network";

export type OspfRouterLinkType = "point-to-point" | "transit" | "stub";

export interface OspfRouterLsaLink {
  readonly type: OspfRouterLinkType;
  /** Neighbour router id, DR interface address, or stub network address. */
  readonly linkId: string;
  /** Local interface address, or the stub network mask. */
  readonly linkData: string;
  readonly metric: number;
}

export interface OspfLsaHeader {
  readonly type: OspfLsaType;
  readonly linkStateId: Ipv4;
  readonly advertisingRouter: Ipv4;
  readonly sequence: number;
  /** Virtual time the LSA was originated; age is derived from it on read. */
  readonly originatedAtNs: number;
  /** Deterministic logical hash over the LSA body, not an RFC checksum. */
  readonly checksum: number;
}

export interface OspfRouterLsa extends OspfLsaHeader {
  readonly type: "router";
  readonly links: readonly OspfRouterLsaLink[];
}

export interface OspfNetworkLsa extends OspfLsaHeader {
  readonly type: "network";
  readonly networkMask: Ipv4;
  readonly attachedRouters: readonly Ipv4[];
}

export type OspfLsa = OspfRouterLsa | OspfNetworkLsa;

interface OspfPacketBase {
  readonly kind: "ospf";
  readonly routerId: Ipv4;
  readonly areaId: number;
  /** Address of the sending interface, used for DR identification. */
  readonly sourceAddress: Ipv4;
}

export interface OspfHelloPacket extends OspfPacketBase {
  readonly type: "hello";
  readonly networkMask: Ipv4;
  readonly helloIntervalNs: number;
  readonly deadIntervalNs: number;
  readonly priority: number;
  readonly networkType: OspfNetworkType;
  readonly designatedRouter?: Ipv4;
  readonly backupDesignatedRouter?: Ipv4;
  /** Router ids the sender has already heard from on this segment. */
  readonly neighbors: readonly Ipv4[];
}

export interface OspfDatabaseDescriptionPacket extends OspfPacketBase {
  readonly type: "dbd";
  readonly sequence: number;
  readonly init: boolean;
  readonly more: boolean;
  readonly master: boolean;
  readonly headers: readonly OspfLsaHeader[];
}

export interface OspfLinkStateRequestPacket extends OspfPacketBase {
  readonly type: "lsr";
  readonly requests: ReadonlyArray<{
    readonly type: OspfLsaType;
    readonly linkStateId: Ipv4;
    readonly advertisingRouter: Ipv4;
  }>;
}

export interface OspfLinkStateUpdatePacket extends OspfPacketBase {
  readonly type: "lsu";
  readonly lsas: readonly OspfLsa[];
}

export interface OspfLinkStateAckPacket extends OspfPacketBase {
  readonly type: "lsack";
  readonly headers: readonly OspfLsaHeader[];
}

export type OspfPacket =
  | OspfHelloPacket
  | OspfDatabaseDescriptionPacket
  | OspfLinkStateRequestPacket
  | OspfLinkStateUpdatePacket
  | OspfLinkStateAckPacket;

export function lsaKey(type: OspfLsaType, linkStateId: Ipv4, advertisingRouter: Ipv4): string {
  return `${type}\u0000${linkStateId}\u0000${advertisingRouter}`;
}

export function lsaHeaderOf(lsa: OspfLsa): OspfLsaHeader {
  return {
    type: lsa.type,
    linkStateId: lsa.linkStateId,
    advertisingRouter: lsa.advertisingRouter,
    sequence: lsa.sequence,
    originatedAtNs: lsa.originatedAtNs,
    checksum: lsa.checksum,
  };
}

/**
 * Deterministic logical hash standing in for the RFC checksum. It only has to
 * change whenever the LSA body changes, and it must never depend on iteration
 * order or wall-clock time.
 */
export type OspfLsaChecksumInput =
  | Omit<OspfRouterLsa, "checksum">
  | Omit<OspfNetworkLsa, "checksum">;

export function lsaChecksum(lsa: OspfLsaChecksumInput): number {
  const body = lsa.type === "router"
    ? lsa.links.map((link) => `${link.type}|${link.linkId}|${link.linkData}|${link.metric}`).join(";")
    : `${lsa.networkMask}|${[...lsa.attachedRouters].join(",")}`;
  const canonical = `${lsa.type}|${lsa.linkStateId}|${lsa.advertisingRouter}|${lsa.sequence}|${body}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < canonical.length; index++) {
    hash = Math.imul(hash ^ canonical.charCodeAt(index), 16_777_619) >>> 0;
  }
  return hash >>> 0;
}
