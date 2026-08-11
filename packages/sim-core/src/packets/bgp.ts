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
  /**
   * The Ethernet Segment this MAC was learned behind, when it is multihomed.
   *
   * Absent — and ESI 0 — mean an ordinary single-homed port, which is why every
   * route written before M10.16 stays exactly what it was. A non-zero value is
   * what makes the receiving leaf resolve the MAC through the segment's
   * reachability rather than through this route's own next hop.
   */
  readonly ethernetSegmentId?: string;
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

/**
 * EVPN Route Type 5 — IP Prefix.
 *
 * This is what makes routing between two tenant subnets possible without
 * stretching either of them: the prefix travels on its own, and `l3Vni` names
 * the transit segment symmetric IRB forwards it through. Scope is IPv4 only —
 * an IPv6 tenant prefix is deliberately not modelled.
 */
export interface EvpnIpPrefixRoute {
  readonly type: 5;
  readonly routeDistinguisher: string;
  readonly ethernetTag: number;
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  /** The VRF's transit VNI on the advertising VTEP. */
  readonly l3Vni: number;
  /** The VTEP a receiver must encapsulate towards; also the BGP next hop. */
  readonly nextHopVtep: Ipv4;
  readonly nextHop: Ipv4;
  readonly pathAttributes: BgpPathAttributes;
  readonly routeId: string;
}

/**
 * EVPN Route Type 4 — Ethernet Segment.
 *
 * This is how two leaves discover that they attach the *same* CE: each one
 * advertises the shared ESI, and the resulting candidate list is what the
 * Designated Forwarder election runs over. It carries no MAC and no prefix —
 * only the segment identity and the VTEP that owns an attachment to it.
 */
export interface EvpnEthernetSegmentRoute {
  readonly type: 4;
  readonly routeDistinguisher: string;
  readonly esi: string;
  readonly originatingVtep: Ipv4;
  readonly routeTargets: readonly string[];
  readonly nextHop: Ipv4;
  readonly pathAttributes: BgpPathAttributes;
  readonly routeId: string;
}

/**
 * EVPN Route Type 1 — Ethernet Auto-Discovery.
 *
 * It exists in two scopes and they answer two different questions. The **per-ES**
 * route says "this VTEP still has a working attachment to this segment", so
 * withdrawing one invalidates every MAC behind it in a single message rather
 * than waiting for one Type 2 withdrawal per address — that is the fast mass
 * withdrawal. The **per-EVI** route says "this VTEP can serve this segment in
 * this EVI", which is what makes deterministic backup selection possible.
 *
 * There is no MPLS ESI label here: the VXLAN data plane's split horizon is built
 * from the simulator's own origin metadata, not from a label.
 */
export type EvpnEthernetAdRoute =
  | {
    readonly type: 1;
    readonly scope: "per-es";
    readonly routeDistinguisher: string;
    readonly esi: string;
    readonly originatingVtep: Ipv4;
    readonly routeTargets: readonly string[];
    readonly nextHop: Ipv4;
    readonly pathAttributes: BgpPathAttributes;
    readonly routeId: string;
  }
  | {
    readonly type: 1;
    readonly scope: "per-evi";
    readonly routeDistinguisher: string;
    readonly esi: string;
    readonly ethernetTag: number;
    readonly vni: number;
    readonly originatingVtep: Ipv4;
    readonly routeTargets: readonly string[];
    readonly nextHop: Ipv4;
    readonly pathAttributes: BgpPathAttributes;
    readonly routeId: string;
  };

export type EvpnNlri =
  | EvpnMacIpRoute
  | EvpnImetRoute
  | EvpnIpPrefixRoute
  | EvpnEthernetSegmentRoute
  | EvpnEthernetAdRoute;

/** The identity an EVPN withdrawal names; never the whole advertised route. */
export interface EvpnWithdrawnNlri {
  readonly type: 1 | 2 | 3 | 4 | 5;
  readonly routeDistinguisher: string;
  readonly ethernetTag: number;
  readonly vni: number;
  readonly macAddress?: string;
  /** Types 1, 3 and 4: the originating router address is part of the NLRI. */
  readonly originatingVtep?: Ipv4;
  /** Types 1 and 4: the Ethernet Segment the route is about. */
  readonly esi?: string;
  /** Type 1: which of the two Ethernet A-D scopes is being withdrawn. */
  readonly scope?: "per-es" | "per-evi";
  /** Type 5 only: the advertised prefix is what identifies the route. */
  readonly network?: Ipv4;
  readonly prefixLength?: number;
}

/**
 * The stable RIB key of one EVPN route.
 *
 * A Type 3 is keyed by its originating router as well as its RD, exactly as the
 * NLRI carries it — two VTEPs that share one route distinguisher still each
 * announce their own membership. A Type 2 is keyed by RD and MAC, so the same
 * MAC advertised twice under one RD collapses into a single best path. A Type 5
 * is keyed by RD and prefix, so two VTEPs advertising the same tenant network
 * are two paths to compare rather than two unrelated routes. A Type 4 is keyed
 * by its ESI *and* its originating VTEP, because two leaves announcing one
 * shared segment are precisely what the DF election needs to see as two routes.
 */
export function evpnRouteKey(route: EvpnWithdrawnNlri | EvpnNlri): string {
  return [
    route.type,
    route.routeDistinguisher,
    "ethernetTag" in route ? route.ethernetTag : 0,
    evpnKeyVni(route),
    route.type === 2 ? route.macAddress ?? "" : "",
    route.type === 1 || route.type === 3 || route.type === 4 ? route.originatingVtep ?? "" : "",
    route.type === 1 || route.type === 4 ? route.esi ?? "" : "",
    route.type === 1 ? route.scope ?? "" : "",
    route.type === 5 ? `${route.network ?? ""}/${route.prefixLength ?? ""}` : "",
  ].join("|");
}

/**
 * The VNI a route is filed under. A Type 5 names its transit **L3VNI**, so the
 * one field is enough for every RIB key, ordering and `show` row — there is no
 * second VNI on the route to disagree with it. A Type 4 is about a whole
 * Ethernet Segment rather than one segment of the overlay, so it has none.
 */
export function evpnRouteVni(route: EvpnWithdrawnNlri | EvpnNlri): number {
  return evpnKeyVni(route);
}

function evpnKeyVni(route: EvpnWithdrawnNlri | EvpnNlri): number {
  if ("l3Vni" in route) return route.l3Vni;
  return "vni" in route && route.vni !== undefined ? route.vni : 0;
}

/** The withdrawal identity of one advertised EVPN route. */
export function evpnWithdrawnNlriOf(route: EvpnNlri): EvpnWithdrawnNlri {
  if (route.type === 1) {
    return {
      type: 1,
      routeDistinguisher: route.routeDistinguisher,
      ethernetTag: route.scope === "per-evi" ? route.ethernetTag : 0,
      vni: route.scope === "per-evi" ? route.vni : 0,
      esi: route.esi,
      scope: route.scope,
      originatingVtep: route.originatingVtep,
    };
  }
  if (route.type === 4) {
    return {
      type: 4,
      routeDistinguisher: route.routeDistinguisher,
      ethernetTag: 0,
      vni: 0,
      esi: route.esi,
      originatingVtep: route.originatingVtep,
    };
  }
  if (route.type === 3) {
    return {
      type: 3,
      routeDistinguisher: route.routeDistinguisher,
      ethernetTag: route.ethernetTag,
      vni: route.vni,
      originatingVtep: route.originatingVtep,
    };
  }
  if (route.type === 5) {
    return {
      type: 5,
      routeDistinguisher: route.routeDistinguisher,
      ethernetTag: route.ethernetTag,
      vni: route.l3Vni,
      network: route.network,
      prefixLength: route.prefixLength,
    };
  }
  return {
    type: 2,
    routeDistinguisher: route.routeDistinguisher,
    ethernetTag: route.ethernetTag,
    vni: route.vni,
    macAddress: route.macAddress,
  };
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
