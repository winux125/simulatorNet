import type { Ipv4 } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import type { IpAddress } from "../util/ip-address";

export const BGP_TCP_PORT = 179;
export const BGP_VERSION = 4;

/**
 * The address families one BGP session may carry. They are negotiated in OPEN
 * and each keeps its own RIBs; the FSM, the TCP session and the timers are
 * shared, exactly as MP-BGP intends.
 */
export type BgpAddressFamily =
  | "ipv4-unicast"
  | "ipv6-unicast"
  | "vpnv4-unicast"
  | "vpnv6-unicast"
  | "l2vpn-evpn";

/** The two families whose NLRI is a plain unicast prefix. */
export type BgpUnicastAddressFamily = Extract<BgpAddressFamily, "ipv4-unicast" | "ipv6-unicast">;

export interface BgpOpenMessage {
  readonly kind: "bgp-open";
  readonly version: 4;
  readonly localAs: number;
  readonly holdTimeSeconds: number;
  readonly bgpIdentifier: Ipv4;
  readonly addressFamilies?: readonly BgpAddressFamily[];
}

export interface BgpKeepaliveMessage {
  readonly kind: "bgp-keepalive";
}

export interface BgpPathAttributes {
  readonly origin: "igp" | "egp" | "incomplete";
  readonly asPath: readonly number[];
  /**
   * The next hop of the family this NLRI belongs to: an IPv4 address for IPv4
   * unicast and for both VPN families (whose next hop is the PE loopback that
   * the IPv4 core resolves), and an IPv6 address for IPv6 unicast.
   */
  readonly nextHop: IpAddress;
  readonly localPreference?: number;
  readonly med?: number;
  /**
   * Standard communities, canonical and sorted. They only cross the wire when
   * the sending neighbor has `send-community`, which is exactly why the field
   * is optional rather than always populated.
   */
  readonly communities?: readonly string[];
  /** Router ID of the iBGP speaker that first announced the route. */
  readonly originatorId?: Ipv4;
  /** Cluster IDs of every reflector the route has already traversed. */
  readonly clusterList?: readonly string[];
  /** `true` when a route reflector, not the originator, sent this NLRI. */
  readonly reflected?: boolean;
  /** Contributing ASNs of an `as-set` aggregate, deterministic and sorted. */
  readonly aggregatorAsSet?: readonly number[];
}

export interface BgpNlri {
  readonly network: IpAddress;
  readonly prefixLength: number;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

export interface Vpnv4Nlri {
  readonly routeDistinguisher: string;
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly vpnLabel: number;
  readonly nextHop: Ipv4;
  readonly sourceVrfId: string;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

/**
 * A VPNv6 NLRI is a VPNv4 NLRI whose prefix is IPv6. Its next hop stays the
 * advertising PE's IPv4 loopback: the transport LSP is resolved by the IPv4
 * OSPF/LDP core, which is the simplification this educational model makes
 * explicit rather than modelling an IPv4-mapped IPv6 next hop.
 */
export interface Vpnv6Nlri {
  readonly routeDistinguisher: string;
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly vpnLabel: number;
  readonly nextHop: Ipv4;
  readonly sourceVrfId: string;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

/**
 * EVPN Route Type 2 — MAC/IP Advertisement.
 *
 * The path attributes keep their own field name rather than the `path` used by
 * the unicast and VPN NLRI shapes, because an EVPN route is keyed by its route
 * type and MAC rather than by a prefix. `label` is the VNI-scoped delivery
 * label; in a VXLAN fabric it is the VNI itself.
 */
export interface EvpnMacIpRoute {
  readonly type: 2;
  readonly routeDistinguisher: string;
  readonly ethernetTag: number;
  readonly macAddress: string;
  /** Optional IPv4 binding. IPv6 bindings and ARP suppression are not modelled. */
  readonly ipAddress?: Ipv4;
  readonly vni: number;
  readonly routeTargets: readonly string[];
  readonly nextHop: Ipv4;
  readonly label: number;
  readonly pathAttributes: BgpPathAttributes;
  readonly routeId: string;
}

/**
 * EVPN Route Type 3 — Inclusive Multicast Ethernet Tag. It is what builds the
 * head-end replication list: a VTEP that advertises one for a VNI is asking to
 * receive that VNI's BUM traffic.
 */
export interface EvpnImetRoute {
  readonly type: 3;
  readonly routeDistinguisher: string;
  readonly ethernetTag: number;
  readonly vni: number;
  readonly routeTargets: readonly string[];
  readonly originatingVtep: Ipv4;
  readonly nextHop: Ipv4;
  readonly pathAttributes: BgpPathAttributes;
  readonly routeId: string;
}

export type EvpnNlri = EvpnMacIpRoute | EvpnImetRoute;

/** The identity an EVPN withdrawal names; never the whole advertised route. */
export interface EvpnWithdrawnNlri {
  readonly type: 2 | 3;
  readonly routeDistinguisher: string;
  readonly ethernetTag: number;
  readonly vni: number;
  readonly macAddress?: string;
  /** Type 3 only: the originating router address is part of the NLRI. */
  readonly originatingVtep?: Ipv4;
}

/**
 * The stable RIB key of one EVPN route.
 *
 * A Type 3 is keyed by its originating router as well as its RD, exactly as the
 * NLRI carries it — two VTEPs that share one route distinguisher still each
 * announce their own membership. A Type 2 is keyed by RD and MAC, so the same
 * MAC advertised twice under one RD collapses into a single best path.
 */
export function evpnRouteKey(route: EvpnWithdrawnNlri): string {
  return [
    route.type,
    route.routeDistinguisher,
    route.ethernetTag,
    route.vni,
    route.macAddress ?? "",
    route.type === 3 ? route.originatingVtep ?? "" : "",
  ].join("|");
}

export interface BgpUpdateMessage {
  readonly kind: "bgp-update";
  readonly withdrawn: readonly Pick<BgpNlri, "network" | "prefixLength">[];
  readonly nlri: readonly BgpNlri[];
  readonly ipv6Withdrawn?: readonly Pick<BgpNlri, "network" | "prefixLength">[];
  readonly ipv6Nlri?: readonly BgpNlri[];
  readonly vpnv4Withdrawn?: readonly Pick<Vpnv4Nlri, "routeDistinguisher" | "network" | "prefixLength">[];
  readonly vpnv4Nlri?: readonly Vpnv4Nlri[];
  readonly vpnv6Withdrawn?: readonly Pick<Vpnv6Nlri, "routeDistinguisher" | "network" | "prefixLength">[];
  readonly vpnv6Nlri?: readonly Vpnv6Nlri[];
  readonly evpnWithdrawn?: readonly EvpnWithdrawnNlri[];
  readonly evpnNlri?: readonly EvpnNlri[];
}

export interface BgpNotificationMessage {
  readonly kind: "bgp-notification";
  readonly code: "message-header" | "open-message" | "update-message" | "hold-timer" | "cease";
  readonly subcode: string;
  readonly message: string;
}

export type BgpMessage =
  | BgpOpenMessage
  | BgpKeepaliveMessage
  | BgpUpdateMessage
  | BgpNotificationMessage;

export function isBgpMessage(value: unknown): value is BgpMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "bgp-open" || kind === "bgp-keepalive" || kind === "bgp-update" || kind === "bgp-notification";
}
