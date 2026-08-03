import type { SimulationEngine } from "../engine/simulation-engine";
import { NS_PER_S } from "../engine/constants";
import {
  BGP_TCP_PORT,
  BGP_VERSION,
  isBgpMessage,
  type BgpAddressFamily,
  type BgpMessage,
  type BgpNotificationMessage,
  type BgpPathAttributes,
  type BgpUnicastAddressFamily,
  type Vpnv4Nlri,
} from "../packets/bgp";
import type { TcpApplicationPayload } from "../packets/tcp";
import { TcpState, type TcpConnection, type TcpConnectionHandlers } from "../transport/tcp";
import type { HostTransportStack } from "../transport/host-transport";
import type { Ipv4 } from "../util/ipv4";
import { intToIp, ipToInt, maskToInt } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import { ipv6Network, normalizeIpv6, validateIpv6PrefixLength } from "../util/ipv6";
import { compareIpAddresses, ipFamilyOf, type IpAddress } from "../util/ip-address";
import {
  ControlProtocolConfigurationError,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  enforceStructuralLimit,
} from "./limits";
import { ProtocolActivity } from "./protocol-activity";
import { RoutingPolicyEngine, type RoutePolicyBinding } from "../routing/route-policy";
import { communityBlocksAdvertisement, normalizeBgpCommunities } from "../routing/bgp-community";

export const DEFAULT_BGP_KEEPALIVE_SECONDS = 60;
export const DEFAULT_BGP_HOLD_SECONDS = 180;
export const BGP_ACTIVITY_QUIESCENCE_ROUNDS = 4;
export const BGP_MAXIMUM_ACTIVITY_TICKS = 64;
export const BGP_ACTIVITY_WINDOW_SECONDS = 30;

/** Route-ID namespace that marks a locally originated `aggregate-address`. */
const AGGREGATE_ROUTE_PREFIX = "aggregate:";

export type BgpSessionState =
  | "idle"
  | "connect"
  | "active"
  | "open-sent"
  | "open-confirm"
  | "established";

/**
 * Per-address-family neighbor settings for IPv6 unicast. IPv4 unicast keeps its
 * flat fields — that is what every document written before M10.13 contains —
 * so the IPv6 family declares its own activation and policy instead of
 * retro-fitting a nested shape onto the existing one.
 */
export interface BgpNeighborIpv6AddressFamily {
  /** `neighbor <a> activate` under `address-family ipv6 unicast`. */
  readonly activated?: boolean;
  readonly nextHopSelf?: boolean;
  readonly prefixListIn?: string;
  readonly prefixListOut?: string;
  readonly routeMapIn?: string;
  readonly routeMapOut?: string;
  readonly sendCommunityStandard?: boolean;
  readonly routeReflectorClient?: boolean;
  readonly defaultOriginate?: boolean;
  readonly defaultOriginateRouteMap?: string;
}

export interface BgpNeighborConfiguration {
  /** IPv4 or IPv6 transport address of the peer. */
  readonly address: IpAddress;
  readonly remoteAs: number;
  readonly description?: string;
  readonly updateSource?: string;
  readonly ebgpMultihop?: number;
  readonly enabled?: boolean;
  readonly nextHopSelf?: boolean;
  readonly prefixListIn?: string;
  readonly prefixListOut?: string;
  readonly routeMapIn?: string;
  readonly routeMapOut?: string;
  readonly vpnv4Activated?: boolean;
  readonly vpnv6Activated?: boolean;
  readonly sendCommunityExtended?: boolean;
  /** `neighbor <a> send-community`: standard communities may leave this device. */
  readonly sendCommunityStandard?: boolean;
  /** iBGP peer this device reflects for; invalid on an eBGP neighbor. */
  readonly routeReflectorClient?: boolean;
  /** `neighbor <a> default-originate`: 0.0.0.0/0 for this peer only. */
  readonly defaultOriginate?: boolean;
  /** Bounded route-map deciding whether default-originate advertises. */
  readonly defaultOriginateRouteMap?: string;
  /** `address-family ipv6 unicast` settings for this neighbor. */
  readonly ipv6?: BgpNeighborIpv6AddressFamily;
}

export interface BgpAggregateConfiguration {
  readonly prefix: Ipv4;
  readonly prefixLength: number;
  /** Advertise only the summary; more-specific routes stay in the Loc-RIB. */
  readonly summaryOnly?: boolean;
  /** Carry the deterministic sorted set of contributing ASNs in AS_PATH. */
  readonly asSet?: boolean;
}

export interface BgpNetworkStatement {
  readonly network: Ipv4;
  readonly prefixLength: number;
}

export interface BgpIpv6NetworkStatement {
  readonly network: Ipv6;
  readonly prefixLength: number;
}

export interface BgpConfiguration {
  readonly localAs: number;
  readonly routerId?: Ipv4;
  readonly keepaliveSeconds?: number;
  readonly holdTimeSeconds?: number;
  /** Reflection cluster identity; falls back to the BGP router ID. */
  readonly clusterId?: Ipv4;
  readonly neighbors?: readonly BgpNeighborConfiguration[];
  readonly networks?: readonly BgpNetworkStatement[];
  /** `network <prefix>/<length>` under `address-family ipv6 unicast`. */
  readonly ipv6Networks?: readonly BgpIpv6NetworkStatement[];
  readonly aggregates?: readonly BgpAggregateConfiguration[];
  readonly vrfAddressFamilies?: readonly BgpVrfAddressFamilyConfiguration[];
}

export interface BgpAggregateSummary extends BgpAggregateConfiguration {
  readonly active: boolean;
  readonly contributingRoutes: number;
  readonly suppressedRoutes: number;
}

export interface BgpSuppressedRoute {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly aggregate: string;
}

export interface BgpVrfAddressFamilyConfiguration {
  readonly vrfId: string;
  readonly redistributeConnected?: boolean;
  readonly redistributeStatic?: boolean;
  /** `address-family ipv6 vrf <name>` redistribution into VPNv6. */
  readonly redistributeConnectedIpv6?: boolean;
  readonly redistributeStaticIpv6?: boolean;
}

export type BgpRouteSource = "local" | "ebgp" | "ibgp";

export interface BgpRoute {
  /** Which unicast RIB this path belongs to; the two never mix. */
  readonly addressFamily: BgpUnicastAddressFamily;
  readonly network: IpAddress;
  readonly prefixLength: number;
  readonly origin: "igp" | "egp" | "incomplete";
  readonly asPath: readonly number[];
  readonly nextHop: IpAddress;
  readonly localPreference: number;
  readonly med: number;
  readonly weight: number;
  readonly source: BgpRouteSource;
  readonly neighborAddress?: IpAddress;
  readonly neighborAs?: number;
  readonly neighborRouterId?: Ipv4;
  readonly learnedAtNs: number;
  readonly routeId: string;
  readonly igpMetric: number;
  /** Canonical standard communities; never route-target extended communities. */
  readonly communities: readonly string[];
  /** Set once a route reflector forwards an iBGP route. */
  readonly originatorId?: Ipv4;
  /** Cluster IDs already traversed; empty on a route that was never reflected. */
  readonly clusterList: readonly string[];
}

export interface Vpnv4Route extends Vpnv4Nlri {
  readonly source: "local" | "ebgp" | "ibgp";
  readonly neighborAddress?: Ipv4;
  readonly neighborAs?: number;
  readonly neighborRouterId?: Ipv4;
  readonly learnedAtNs: number;
  readonly localPreference: number;
  readonly med: number;
  readonly weight: number;
  readonly igpMetric: number;
  readonly best?: boolean;
  readonly communities: readonly string[];
  readonly originatorId?: Ipv4;
  readonly clusterList: readonly string[];
}

export interface BgpRibEntry extends BgpRoute {
  readonly best: boolean;
  readonly valid: boolean;
  readonly rejectionReason?: string;
}

export interface BgpNeighborSummary {
  readonly address: IpAddress;
  readonly remoteAs: number;
  readonly state: BgpSessionState;
  readonly description?: string;
  readonly localAddress?: IpAddress;
  readonly negotiatedHoldTimeSeconds?: number;
  readonly lastError?: string;
  readonly messagesSent: number;
  readonly messagesReceived: number;
  /** Address families both ends have activated on this one session. */
  readonly addressFamilies: readonly BgpAddressFamily[];
}

export interface BgpHost {
  readonly id: string;
  readonly engine: SimulationEngine;
  readonly management: HostTransportStack;
  /** Family-neutral: the address decides which stack answers. */
  bgpSourceAddress(remoteAddress: IpAddress, updateSource?: string): IpAddress | undefined;
  /**
   * The local next hop for one unicast family toward a peer. A dual-stack
   * session runs over one transport but still needs a same-family next hop for
   * the other address family's prefixes.
   */
  bgpNextHop(
    family: BgpUnicastAddressFamily,
    remoteAddress: IpAddress,
    updateSource?: string,
  ): IpAddress | undefined;
  bgpOwnsAddress(address: IpAddress): boolean;
  bgpRouteReachable(address: IpAddress): boolean;
  bgpExactRouteExists(network: IpAddress, prefixLength: number, family: BgpUnicastAddressFamily): boolean;
  bgpIgpMetric(address: IpAddress): number | undefined;
  bgpRoutesChanged(family: BgpUnicastAddressFamily): void;
  bgpVpnv4Exports(): readonly Vpnv4Route[];
  bgpVpnv4RoutesChanged(routes: readonly Vpnv4Route[]): void;
}

interface NeighborRuntime {
  configuration: BgpNeighborConfiguration;
  state: BgpSessionState;
  connection?: TcpConnection;
  localAddress?: IpAddress;
  negotiatedHoldTimeSeconds?: number;
  lastReceivedAtNs?: number;
  lastError?: string;
  messagesSent: number;
  messagesReceived: number;
  generation: number;
  remoteRouterId?: Ipv4;
  remoteAddressFamilies?: readonly BgpAddressFamily[];
}

const ORIGIN_ORDER: Readonly<Record<BgpRoute["origin"], number>> = Object.freeze({ igp: 0, egp: 1, incomplete: 2 });

/**
 * Address ordering that never mixes families. Both are plain strings in this
 * engine, so a comparator that assumed IPv4 would throw on an IPv6 neighbor.
 */
function compareBgpAddresses(left: IpAddress | undefined, right: IpAddress | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  const leftFamily = ipFamilyOf(left);
  const rightFamily = ipFamilyOf(right);
  if (leftFamily !== rightFamily) return leftFamily === "ipv4" ? -1 : 1;
  return compareIpAddresses(leftFamily, left, right);
}

/** Cisco-like deterministic educational best-path ordering. */
export function compareBgpPaths(left: BgpRoute, right: BgpRoute): number {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.localPreference !== right.localPreference) return right.localPreference - left.localPreference;
  if ((left.source === "local") !== (right.source === "local")) return left.source === "local" ? -1 : 1;
  if (left.asPath.length !== right.asPath.length) return left.asPath.length - right.asPath.length;
  if (ORIGIN_ORDER[left.origin] !== ORIGIN_ORDER[right.origin]) return ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin];
  if (left.neighborAs !== undefined && left.neighborAs === right.neighborAs && left.med !== right.med) {
    return left.med - right.med;
  }
  if ((left.source === "ebgp") !== (right.source === "ebgp")) return left.source === "ebgp" ? -1 : 1;
  if (left.igpMetric !== right.igpMetric) return left.igpMetric - right.igpMetric;
  if (left.learnedAtNs !== right.learnedAtNs) return left.learnedAtNs - right.learnedAtNs;
  const routerId = ipToInt(left.neighborRouterId ?? "0.0.0.0") - ipToInt(right.neighborRouterId ?? "0.0.0.0");
  if (routerId !== 0) return routerId;
  const neighbor = compareBgpAddresses(left.neighborAddress, right.neighborAddress);
  return neighbor || left.routeId.localeCompare(right.routeId);
}

export function selectBestBgpPath(routes: readonly BgpRoute[]): BgpRoute | undefined {
  return [...routes].sort(compareBgpPaths)[0];
}

export function compareVpnv4Paths(left: Vpnv4Route, right: Vpnv4Route): number {
  return compareBgpPaths(vpnComparable(left), vpnComparable(right));
}

function vpnComparable(route: Vpnv4Route): BgpRoute {
  return {
    addressFamily: "ipv4-unicast",
    network: route.network,
    prefixLength: route.prefixLength,
    origin: route.path.origin,
    asPath: route.path.asPath,
    nextHop: route.nextHop,
    localPreference: route.localPreference,
    med: route.med,
    weight: route.weight,
    source: route.source,
    neighborAddress: route.neighborAddress,
    neighborAs: route.neighborAs,
    neighborRouterId: route.neighborRouterId,
    learnedAtNs: route.learnedAtNs,
    routeId: route.routeId,
    igpMetric: route.igpMetric,
    communities: route.communities,
    originatorId: route.originatorId,
    clusterList: route.clusterList,
  };
}

function validateAsn(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`${field} must be between 1 and 4294967295`, field);
  }
}

function validateTimer(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ControlProtocolConfigurationError(`${field} must be between 0 and ${maximum} seconds`, field);
  }
}

/**
 * Deterministic educational BGPv4 session layer. It deliberately carries
 * structured messages over the shared simulated TCP stack: reachability,
 * ACL/firewall policy, TCP retransmission and IP TTL therefore remain real
 * parts of the simulation instead of direct process-to-process calls.
 */
/** One complete set of unicast RIBs. Two families never share any of them. */
interface UnicastRibs {
  readonly raw: Map<IpAddress, Map<string, BgpRoute>>;
  readonly adjIn: Map<IpAddress, Map<string, BgpRoute>>;
  readonly loc: Map<string, BgpRoute>;
  readonly adjOut: Map<IpAddress, Map<string, BgpRoute>>;
  readonly failures: Map<string, string>;
}

function createUnicastRibs(): UnicastRibs {
  return { raw: new Map(), adjIn: new Map(), loc: new Map(), adjOut: new Map(), failures: new Map() };
}

const UNICAST_FAMILIES: readonly BgpUnicastAddressFamily[] = ["ipv4-unicast", "ipv6-unicast"];

export class BgpProcess {
  readonly routingPolicy = new RoutingPolicyEngine(() => this.reevaluatePolicies());
  private configuration: BgpConfiguration | undefined;
  private readonly neighbors = new Map<IpAddress, NeighborRuntime>();
  private readonly unicast: Record<BgpUnicastAddressFamily, UnicastRibs> = {
    "ipv4-unicast": createUnicastRibs(),
    "ipv6-unicast": createUnicastRibs(),
  };
  private readonly vpnv4AdjRibIn = new Map<IpAddress, Map<string, Vpnv4Route>>();
  private readonly vpnv4LocRib = new Map<string, Vpnv4Route>();
  private readonly vpnv4AdjRibOut = new Map<IpAddress, Map<string, Vpnv4Route>>();
  /** Aggregates that currently have a contributing route, for change tracing. */
  private readonly activeAggregates = new Set<string>();
  private listening = false;
  private activity: ProtocolActivity | undefined;
  private activityRounds = 1;
  private activityRound = 0;

  constructor(private readonly host: BgpHost) {}

  get enabled(): boolean {
    return this.configuration !== undefined;
  }

  get localAs(): number | undefined {
    return this.configuration?.localAs;
  }

  configure(configuration: BgpConfiguration): void {
    validateAsn(configuration.localAs, "localAs");
    const keepaliveSeconds = configuration.keepaliveSeconds ?? DEFAULT_BGP_KEEPALIVE_SECONDS;
    const holdTimeSeconds = configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
    validateTimer(keepaliveSeconds, "keepaliveSeconds", 65_535);
    validateTimer(holdTimeSeconds, "holdTimeSeconds", 65_535);
    if (holdTimeSeconds !== 0 && keepaliveSeconds * 3 > holdTimeSeconds) {
      throw new ControlProtocolConfigurationError(
        "BGP hold time must be zero or at least three times the keepalive time",
        "holdTimeSeconds",
      );
    }
    if (configuration.routerId !== undefined) ipToInt(configuration.routerId);
    if (configuration.clusterId !== undefined) ipToInt(configuration.clusterId);
    const configured = [...(configuration.neighbors ?? [])];
    enforceStructuralLimit("maximumBgpPeersPerDevice", configured.length);
    const seen = new Set<string>();
    let clients = 0;
    for (const neighbor of configured) {
      // Both transports are legal; the address itself decides which stack the
      // TCP session, the routing lookup and the next hop come from.
      if (ipFamilyOf(neighbor.address) === "ipv6") normalizeIpv6(neighbor.address);
      else ipToInt(neighbor.address);
      validateAsn(neighbor.remoteAs, "remoteAs");
      if (seen.has(neighbor.address)) {
        throw new ControlProtocolConfigurationError(`Duplicate BGP neighbor ${neighbor.address}`, "neighbors");
      }
      seen.add(neighbor.address);
      if (neighbor.ebgpMultihop !== undefined
        && (!Number.isInteger(neighbor.ebgpMultihop) || neighbor.ebgpMultihop < 1 || neighbor.ebgpMultihop > 255)) {
        throw new ControlProtocolConfigurationError("eBGP multihop TTL must be between 1 and 255", "ebgpMultihop");
      }
      if (neighbor.routeReflectorClient || neighbor.ipv6?.routeReflectorClient) {
        // Reflection only has meaning inside one AS; an eBGP peer already
        // receives every path, so accepting it would teach the wrong rule.
        if (neighbor.remoteAs !== configuration.localAs) {
          throw new ControlProtocolConfigurationError(
            `Route-reflector-client requires an iBGP neighbor; ${neighbor.address} is in AS ${neighbor.remoteAs}`,
            "routeReflectorClient",
          );
        }
        clients++;
      }
    }
    enforceStructuralLimit("maximumBgpRouteReflectorClientsPerDevice", clients);
    const networks = [...(configuration.networks ?? [])];
    for (const network of networks) {
      if (!Number.isInteger(network.prefixLength) || network.prefixLength < 0 || network.prefixLength > 32) {
        throw new ControlProtocolConfigurationError("BGP network prefix length must be between 0 and 32", "networks");
      }
      const mask = maskToInt(network.prefixLength);
      if (((ipToInt(network.network) & mask) >>> 0) !== ipToInt(network.network)) {
        throw new ControlProtocolConfigurationError("BGP network statement must use a canonical network address", "networks");
      }
    }
    const ipv6Networks = [...(configuration.ipv6Networks ?? [])].map((network) => {
      validateIpv6PrefixLength(network.prefixLength);
      const canonical = ipv6Network(network.network, network.prefixLength);
      if (canonical !== normalizeIpv6(network.network)) {
        throw new ControlProtocolConfigurationError("BGP network statement must use a canonical network address", "ipv6Networks");
      }
      return { network: canonical, prefixLength: network.prefixLength };
    });
    const aggregates = [...(configuration.aggregates ?? [])];
    enforceStructuralLimit("maximumBgpAggregatesPerDevice", aggregates.length);
    const seenAggregates = new Set<string>();
    for (const aggregate of aggregates) {
      if (!Number.isInteger(aggregate.prefixLength) || aggregate.prefixLength < 0 || aggregate.prefixLength > 31) {
        throw new ControlProtocolConfigurationError("An aggregate prefix length must be between 0 and 31", "aggregates");
      }
      if (((ipToInt(aggregate.prefix) & maskToInt(aggregate.prefixLength)) >>> 0) !== ipToInt(aggregate.prefix)) {
        throw new ControlProtocolConfigurationError("An aggregate must use a canonical network address", "aggregates");
      }
      const key = `${aggregate.prefix}/${aggregate.prefixLength}`;
      if (seenAggregates.has(key)) {
        throw new ControlProtocolConfigurationError(`Duplicate aggregate-address ${key}`, "aggregates");
      }
      seenAggregates.add(key);
    }
    const vrfAddressFamilies = [...(configuration.vrfAddressFamilies ?? [])];
    const vrfIds = new Set<string>();
    for (const family of vrfAddressFamilies) {
      if (!family.vrfId.trim() || vrfIds.has(family.vrfId)) {
        throw new ControlProtocolConfigurationError(`Duplicate or empty BGP VRF address family '${family.vrfId}'`, "vrfAddressFamilies");
      }
      vrfIds.add(family.vrfId);
    }
    this.resetRuntime(false);
    this.configuration = {
      ...configuration,
      keepaliveSeconds,
      holdTimeSeconds,
      neighbors: configured,
      networks,
      // Absent rather than empty, so an IPv4-only process serializes exactly
      // as it did before M10.13.
      ...(ipv6Networks.length ? { ipv6Networks } : {}),
      aggregates,
      vrfAddressFamilies,
    };
    this.activityRounds = Math.max(
      1,
      Math.min(BGP_ACTIVITY_QUIESCENCE_ROUNDS, Math.floor(BGP_ACTIVITY_WINDOW_SECONDS / Math.max(1, keepaliveSeconds))),
    );
    this.activity = new ProtocolActivity(
      () => this.host.engine,
      {
        name: "bgp",
        intervalNs: Math.max(1, keepaliveSeconds) * NS_PER_S,
        quiescenceRounds: this.activityRounds,
        maximumTicks: BGP_MAXIMUM_ACTIVITY_TICKS,
      },
      () => this.tick(),
    );
    this.neighbors.clear();
    for (const neighbor of configured.sort((a, b) => compareBgpAddresses(a.address, b.address))) {
      this.neighbors.set(neighbor.address, {
        configuration: { ...neighbor },
        state: "idle",
        messagesSent: 0,
        messagesReceived: 0,
        generation: 0,
      });
    }
    this.refreshRoutes();
    this.start();
  }

  disable(): void {
    this.resetRuntime(true);
    this.configuration = undefined;
    this.neighbors.clear();
    for (const family of UNICAST_FAMILIES) {
      const ribs = this.unicast[family];
      ribs.raw.clear();
      ribs.adjIn.clear();
      ribs.loc.clear();
      ribs.adjOut.clear();
      ribs.failures.clear();
    }
    this.vpnv4AdjRibIn.clear();
    this.vpnv4LocRib.clear();
    this.vpnv4AdjRibOut.clear();
    this.host.bgpVpnv4RoutesChanged([]);
  }

  start(): void {
    if (!this.configuration) return;
    this.ensureListener();
    for (const runtime of this.neighbors.values()) this.tryConnect(runtime);
    this.activity?.arm();
  }

  restart(address?: Ipv4): void {
    const selected = address === undefined ? [...this.neighbors.values()] : [this.requireNeighbor(address)];
    for (const runtime of selected) {
      this.trace("bgp-session-reset", { neighbor: runtime.configuration.address, reason: "administrative reset" });
      runtime.connection?.abort();
      runtime.connection = undefined;
      runtime.lastError = undefined;
      runtime.generation++;
      this.transition(runtime, "idle", "administrative reset");
      this.tryConnect(runtime);
    }
  }

  onInterfaceStateChanged(): void {
    for (const runtime of this.neighbors.values()) {
      if (runtime.state === "established" && !this.host.bgpRouteReachable(runtime.configuration.address)) {
        this.fail(runtime, "transport route unavailable");
      } else if (runtime.state !== "established") {
        this.tryConnect(runtime);
      }
    }
  }

  summaries(): BgpNeighborSummary[] {
    this.expireHoldTimers();
    return [...this.neighbors.values()]
      .map((runtime) => ({
        address: runtime.configuration.address,
        remoteAs: runtime.configuration.remoteAs,
        state: runtime.state,
        description: runtime.configuration.description,
        localAddress: runtime.localAddress,
        negotiatedHoldTimeSeconds: runtime.negotiatedHoldTimeSeconds,
        lastError: runtime.lastError,
        messagesSent: runtime.messagesSent,
        messagesReceived: runtime.messagesReceived,
        addressFamilies: this.negotiatedFamilies(runtime),
      }))
      .sort((a, b) => compareBgpAddresses(a.address, b.address));
  }

  /** Families both ends activated; before OPEN this is the local offer. */
  private negotiatedFamilies(runtime: NeighborRuntime): BgpAddressFamily[] {
    const local = this.localFamilies(runtime.configuration);
    const remote = runtime.remoteAddressFamilies;
    return remote === undefined ? local : local.filter((family) => remote.includes(family));
  }

  /**
   * The families this device offers a peer. IPv4 unicast stays implicit on an
   * IPv4-transport neighbor — that is exactly what a pre-M10.13 document means
   * — while an IPv6-transport neighbor has no IPv4 next hop to give and carries
   * the IPv6 family instead. Every other family is activated explicitly.
   */
  private localFamilies(neighbor: BgpNeighborConfiguration): BgpAddressFamily[] {
    const families: BgpAddressFamily[] = [];
    if (ipFamilyOf(neighbor.address) === "ipv4") families.push("ipv4-unicast");
    if (neighbor.ipv6?.activated || ipFamilyOf(neighbor.address) === "ipv6") families.push("ipv6-unicast");
    if (neighbor.vpnv4Activated) families.push("vpnv4-unicast");
    if (neighbor.vpnv6Activated) families.push("vpnv6-unicast");
    return families;
  }

  private familyNegotiated(runtime: NeighborRuntime, family: BgpAddressFamily): boolean {
    return this.localFamilies(runtime.configuration).includes(family)
      && runtime.remoteAddressFamilies?.includes(family) === true;
  }

  routes(family: BgpUnicastAddressFamily = "ipv4-unicast"): BgpRibEntry[] {
    this.expireHoldTimers();
    const ribs = this.unicast[family];
    const all = new Map<string, BgpRoute>();
    for (const routes of ribs.adjIn.values()) {
      for (const route of routes.values()) all.set(`${route.routeId}\u0000${route.neighborAddress ?? ""}`, route);
    }
    for (const route of this.localCandidates(family)) all.set(route.routeId, route);
    return [...all.values()].map((route) => ({
      ...route,
      best: ribs.loc.get(this.prefixKey(route.network, route.prefixLength))?.routeId === route.routeId,
      valid: ribs.failures.get(route.routeId) === undefined,
      rejectionReason: ribs.failures.get(route.routeId),
    })).sort((a, b) => a.network.localeCompare(b.network) || a.prefixLength - b.prefixLength || compareBgpPaths(a, b));
  }

  selectedRoutes(family: BgpUnicastAddressFamily = "ipv4-unicast"): BgpRoute[] {
    this.expireHoldTimers();
    return [...this.unicast[family].loc.values()].sort((a, b) =>
      compareBgpAddresses(a.network, b.network)
      || b.prefixLength - a.prefixLength
      || a.routeId.localeCompare(b.routeId));
  }

  vpnv4Routes(): Vpnv4Route[] {
    this.expireHoldTimers();
    const all = new Map<string, Vpnv4Route>();
    for (const route of this.host.bgpVpnv4Exports()) all.set(route.routeId, route);
    for (const rib of this.vpnv4AdjRibIn.values()) {
      for (const route of rib.values()) all.set(`${route.routeId}\u0000${route.neighborAddress ?? ""}`, route);
    }
    return [...all.values()].map((route) => ({
      ...route,
      best: this.vpnv4LocRib.get(this.vpnPrefixKey(route.routeDistinguisher, route.network, route.prefixLength))?.routeId === route.routeId,
    })).sort((a, b) => a.routeDistinguisher.localeCompare(b.routeDistinguisher)
      || ipToInt(a.network) - ipToInt(b.network)
      || compareVpnv4Paths(a, b));
  }

  selectedVpnv4Routes(): Vpnv4Route[] {
    return [...this.vpnv4LocRib.values()].sort((a, b) =>
      a.routeDistinguisher.localeCompare(b.routeDistinguisher)
      || ipToInt(a.network) - ipToInt(b.network)
      || a.routeId.localeCompare(b.routeId));
  }

  adjRibInEntries(address?: IpAddress, family: BgpUnicastAddressFamily = "ipv4-unicast"): BgpRoute[] {
    this.expireHoldTimers();
    const rib = this.unicast[family].adjIn;
    const entries = address === undefined ? [...rib.values()] : [rib.get(address) ?? new Map()];
    return entries.flatMap((value) => [...value.values()]).sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  adjRibOutEntries(address?: IpAddress, family: BgpUnicastAddressFamily = "ipv4-unicast"): BgpRoute[] {
    this.expireHoldTimers();
    const rib = this.unicast[family].adjOut;
    const entries = address === undefined ? [...rib.values()] : [rib.get(address) ?? new Map()];
    return entries.flatMap((value) => [...value.values()]).sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  ribFailureSummaries(family: BgpUnicastAddressFamily = "ipv4-unicast"): Array<{ routeId: string; reason: string }> {
    this.expireHoldTimers();
    return [...this.unicast[family].failures.entries()].map(([routeId, reason]) => ({ routeId, reason }))
      .sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  refreshRoutes(): void {
    if (!this.configuration) return;
    for (const family of UNICAST_FAMILIES) this.recomputeLocRib(family);
    this.recomputeVpnv4LocRib();
    this.advertiseRoutes();
  }

  configurationSnapshot(): BgpConfiguration | undefined {
    if (!this.configuration) return undefined;
    const { aggregates: configured, ipv6Networks: configuredIpv6, ...rest } = this.configuration;
    const aggregates = [...(configured ?? [])].map((aggregate) => ({ ...aggregate }));
    const ipv6Networks = [...(configuredIpv6 ?? [])].map((network) => ({ ...network }));
    return {
      ...rest,
      neighbors: [...(rest.neighbors ?? [])].map((neighbor) => ({
        ...neighbor,
        ...(neighbor.ipv6 ? { ipv6: { ...neighbor.ipv6 } } : {}),
      })),
      networks: [...(rest.networks ?? [])].map((network) => ({ ...network })),
      // Omitted rather than emitted empty, so a lab that configures no
      // aggregate or IPv6 network serializes exactly as it did before.
      ...(aggregates.length ? { aggregates } : {}),
      ...(ipv6Networks.length ? { ipv6Networks } : {}),
      vrfAddressFamilies: [...(rest.vrfAddressFamilies ?? [])].map((family) => ({ ...family })),
    };
  }

  setNetworks(networks: readonly BgpNetworkStatement[]): void {
    if (!this.configuration) {
      throw new ControlProtocolConfigurationError("BGP process is not configured", "networks");
    }
    for (const network of networks) {
      if (!Number.isInteger(network.prefixLength) || network.prefixLength < 0 || network.prefixLength > 32) {
        throw new ControlProtocolConfigurationError("BGP network prefix length must be between 0 and 32", "networks");
      }
      const mask = maskToInt(network.prefixLength);
      if (((ipToInt(network.network) & mask) >>> 0) !== ipToInt(network.network)) {
        throw new ControlProtocolConfigurationError("BGP network statement must use a canonical network address", "networks");
      }
    }
    this.configuration = { ...this.configuration, networks: networks.map((network) => ({ ...network })) };
    this.refreshRoutes();
  }

  setIpv6Networks(networks: readonly BgpIpv6NetworkStatement[]): void {
    if (!this.configuration) {
      throw new ControlProtocolConfigurationError("BGP process is not configured", "ipv6Networks");
    }
    this.configure({ ...this.configuration, ipv6Networks: networks });
  }

  outboundTtl(remoteAddress: IpAddress): number | undefined {
    const runtime = this.neighbors.get(remoteAddress);
    if (!runtime || !this.configuration) return undefined;
    return runtime.configuration.remoteAs === this.configuration.localAs
      ? 64
      : (runtime.configuration.ebgpMultihop ?? 1);
  }

  private ensureListener(): void {
    if (this.listening) return;
    try {
      this.host.management.tcp.listen(BGP_TCP_PORT, (connection) => this.accept(connection), "bgp");
      this.listening = true;
    } catch (error) {
      this.trace("bgp-session-rejected", { reason: error instanceof Error ? error.message : "TCP port unavailable" });
    }
  }

  private tryConnect(runtime: NeighborRuntime): void {
    if (!this.configuration || runtime.configuration.enabled === false || runtime.connection) return;
    const transport = ipFamilyOf(runtime.configuration.address) === "ipv6" ? "IPv6" : "IPv4";
    const localAddress = this.host.bgpSourceAddress(runtime.configuration.address, runtime.configuration.updateSource);
    if (localAddress === undefined) {
      runtime.lastError = runtime.configuration.updateSource
        ? `update-source ${runtime.configuration.updateSource} has no usable ${transport} address`
        : `no usable local ${transport} address`;
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    runtime.localAddress = localAddress;
    if (!this.host.bgpRouteReachable(runtime.configuration.address)) {
      runtime.lastError = `neighbor is not reachable through the ${transport} routing table`;
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    // Exactly one side actively opens a symmetric session. The lower endpoint
    // wins, avoiding duplicate TCP sessions without randomness.
    if (compareBgpAddresses(localAddress, runtime.configuration.address) > 0) {
      this.transition(runtime, "active", "waiting for deterministic passive open");
      return;
    }
    this.transition(runtime, "connect");
    this.trace("bgp-tcp-connect-started", {
      neighbor: runtime.configuration.address,
      localAddress,
      destinationPort: BGP_TCP_PORT,
    });
    const handlers = this.handlers(runtime);
    try {
      runtime.connection = this.host.management.tcp.connect(
        runtime.configuration.address,
        BGP_TCP_PORT,
        handlers,
        "bgp",
        localAddress,
      );
    } catch (error) {
      runtime.connection = undefined;
      runtime.lastError = error instanceof Error ? error.message : "TCP open failed";
      this.transition(runtime, "active", runtime.lastError);
    }
  }

  private accept(connection: TcpConnection): void {
    const remote = connection.remoteAddress as IpAddress;
    const runtime = this.neighbors.get(remote);
    if (!runtime || runtime.configuration.enabled === false || !this.host.bgpOwnsAddress(connection.localAddress as IpAddress)) {
      connection.setHandlers({ onEstablished: (established) => established.close() });
      this.trace("bgp-session-rejected", { neighbor: remote, reason: "unconfigured neighbor" });
      return;
    }
    runtime.connection?.abort();
    runtime.connection = connection;
    runtime.localAddress = connection.localAddress as IpAddress;
    connection.setHandlers(this.handlers(runtime));
    this.onTcpEstablished(runtime, connection);
  }

  private handlers(runtime: NeighborRuntime): TcpConnectionHandlers {
    return {
      onEstablished: (connection) => this.onTcpEstablished(runtime, connection),
      onMessage: (payload, connection) => this.onTcpMessage(runtime, payload, connection),
      onClosed: () => this.onTcpClosed(runtime, "TCP connection closed"),
      onReset: () => this.onTcpClosed(runtime, "TCP connection reset"),
    };
  }

  private onTcpEstablished(runtime: NeighborRuntime, connection: TcpConnection): void {
    if (runtime.connection !== connection || connection.state !== TcpState.Established || !this.configuration) return;
    this.transition(runtime, "open-sent");
    this.send(runtime, {
      kind: "bgp-open",
      version: BGP_VERSION,
      localAs: this.configuration.localAs,
      holdTimeSeconds: this.configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS,
      bgpIdentifier: this.configuration.routerId
        ?? (runtime.localAddress !== undefined && ipFamilyOf(runtime.localAddress) === "ipv4" ? runtime.localAddress : undefined)
        ?? "0.0.0.0",
      addressFamilies: this.localFamilies(runtime.configuration),
    });
  }

  private onTcpMessage(runtime: NeighborRuntime, payload: unknown, connection: TcpConnection): void {
    if (runtime.connection !== connection
      || typeof payload !== "object" || payload === null
      || (payload as { kind?: unknown }).kind !== "tcp-application"
      || (payload as TcpApplicationPayload).protocol !== "bgp"
      || !isBgpMessage((payload as TcpApplicationPayload).data)) {
      this.notifyAndFail(runtime, "message-header", "invalid-message", "Malformed BGP message");
      return;
    }
    const message = (payload as TcpApplicationPayload).data as BgpMessage;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.messagesReceived++;
    runtime.lastReceivedAtNs = this.host.engine.now();
    this.trace("bgp-message-received", { neighbor: runtime.configuration.address, messageType: message.kind });
    if (message.kind === "bgp-open") {
      if (runtime.state !== "open-sent") {
        this.notifyAndFail(runtime, "open-message", "unexpected-open", "Unexpected OPEN message");
        return;
      }
      if (message.version !== BGP_VERSION || message.localAs !== runtime.configuration.remoteAs) {
        this.notifyAndFail(runtime, "open-message", "bad-peer-as", "Remote AS does not match neighbor configuration");
        return;
      }
      const localHold = this.configuration?.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
      runtime.negotiatedHoldTimeSeconds = Math.min(localHold, message.holdTimeSeconds);
      runtime.remoteRouterId = message.bgpIdentifier;
      runtime.remoteAddressFamilies = message.addressFamilies ?? ["ipv4-unicast"];
      this.transition(runtime, "open-confirm");
      this.send(runtime, { kind: "bgp-keepalive" });
      return;
    }
    if (message.kind === "bgp-keepalive") {
      if (runtime.state === "open-confirm") {
        runtime.lastError = undefined;
        this.transition(runtime, "established");
        this.trace("bgp-session-established", { neighbor: runtime.configuration.address });
        this.refreshRoutes();
      }
      return;
    }
    if (message.kind === "bgp-notification") {
      this.fail(runtime, `${message.code}/${message.subcode}: ${message.message}`);
      return;
    }
    if (runtime.state !== "established") {
      this.notifyAndFail(runtime, "update-message", "unexpected-update", "UPDATE received before Established");
      return;
    }
    this.applyUpdate(runtime, message);
    // One event per family that actually carried something, so a Packet Trace
    // filter can separate an IPv4 UPDATE from an IPv6 one without a second
    // near-identical event name.
    for (const [family, announced, withdrawn] of [
      ["ipv4-unicast", message.nlri.length, message.withdrawn.length],
      ["ipv6-unicast", message.ipv6Nlri?.length ?? 0, message.ipv6Withdrawn?.length ?? 0],
      ["vpnv4-unicast", message.vpnv4Nlri?.length ?? 0, message.vpnv4Withdrawn?.length ?? 0],
      ["vpnv6-unicast", message.vpnv6Nlri?.length ?? 0, message.vpnv6Withdrawn?.length ?? 0],
    ] as const) {
      if (announced === 0 && withdrawn === 0 && family !== "ipv4-unicast") continue;
      this.trace("bgp-update-received", {
        neighbor: runtime.configuration.address,
        addressFamily: family,
        announced,
        withdrawn,
      });
    }
  }

  private send(runtime: NeighborRuntime, message: BgpMessage): void {
    if (!runtime.connection || runtime.connection.state !== TcpState.Established) return;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.connection.send({ kind: "tcp-application", protocol: "bgp", data: message });
    runtime.messagesSent++;
    const traceType = message.kind === "bgp-update"
      ? "bgp-update-sent"
      : message.kind === "bgp-open"
        ? "bgp-open-sent"
        : message.kind === "bgp-keepalive"
          ? "bgp-keepalive-sent"
          : "bgp-message-sent";
    this.trace(traceType, {
      neighbor: runtime.configuration.address,
      messageType: message.kind,
      ...(message.kind === "bgp-update" ? {
        announced: message.nlri.length,
        withdrawn: message.withdrawn.length,
        ipv6Announced: message.ipv6Nlri?.length ?? 0,
        ipv6Withdrawn: message.ipv6Withdrawn?.length ?? 0,
        vpnv4Announced: message.vpnv4Nlri?.length ?? 0,
        vpnv4Withdrawn: message.vpnv4Withdrawn?.length ?? 0,
        vpnv6Announced: message.vpnv6Nlri?.length ?? 0,
        vpnv6Withdrawn: message.vpnv6Withdrawn?.length ?? 0,
      } : {}),
    });
  }

  private notifyAndFail(
    runtime: NeighborRuntime,
    code: BgpNotificationMessage["code"],
    subcode: string,
    message: string,
  ): void {
    this.send(runtime, { kind: "bgp-notification", code, subcode, message });
    this.trace("bgp-notification", { neighbor: runtime.configuration.address, code, subcode, message });
    this.fail(runtime, message);
  }

  private onTcpClosed(runtime: NeighborRuntime, reason: string): void {
    if (!runtime.connection) return;
    runtime.connection = undefined;
    this.fail(runtime, reason, false);
  }

  private fail(runtime: NeighborRuntime, reason: string, abort = true): void {
    const connection = runtime.connection;
    runtime.connection = undefined;
    this.withdrawNeighborRoutes(runtime.configuration.address);
    runtime.lastError = reason;
    runtime.generation++;
    if (abort) connection?.abort();
    this.transition(runtime, "idle", reason);
    this.trace("bgp-session-failed", { neighbor: runtime.configuration.address, reason });
  }

  private withdrawNeighborRoutes(address: IpAddress): void {
    for (const family of UNICAST_FAMILIES) {
      const ribs = this.unicast[family];
      const changed = [ribs.raw.delete(address), ribs.adjIn.delete(address), ribs.adjOut.delete(address)]
        .some(Boolean);
      if (changed) this.recomputeLocRib(family);
    }
    const vpnInboundChanged = this.vpnv4AdjRibIn.delete(address);
    const vpnOutboundChanged = this.vpnv4AdjRibOut.delete(address);
    if (vpnInboundChanged || vpnOutboundChanged) this.recomputeVpnv4LocRib();
  }

  private transition(runtime: NeighborRuntime, state: BgpSessionState, reason?: string): void {
    if (runtime.state === state) return;
    const previous = runtime.state;
    this.host.engine.controlProtocolBudget.consume("bgpStateTransitions", this.host.id);
    runtime.state = state;
    this.activityRound = 0;
    this.trace("bgp-state-changed", { neighbor: runtime.configuration.address, previous, state, reason });
    this.activity?.arm();
  }

  private requireNeighbor(address: Ipv4): NeighborRuntime {
    const neighbor = this.neighbors.get(address);
    if (!neighbor) throw new ControlProtocolConfigurationError(`BGP neighbor ${address} is not configured`, "neighbor");
    return neighbor;
  }

  private resetRuntime(removeListener: boolean): void {
    this.activity?.quiesce();
    this.activity?.resetBudget();
    for (const runtime of this.neighbors.values()) runtime.connection?.abort();
    if (removeListener && this.listening) {
      this.host.management.tcp.unlisten(BGP_TCP_PORT);
      this.listening = false;
    }
  }

  /**
   * BGP periodic work is deliberately bounded. Four quiet KEEPALIVE rounds
   * are enough to expose timer behavior in Step mode, after which the process
   * goes quiescent so Auto execution and headless verification can drain.
   * A configuration, link or session transition re-opens this window.
   */
  private tick(): void {
    if (!this.configuration) return;
    for (const runtime of this.neighbors.values()) {
      if (runtime.state === "established") {
        if ((runtime.negotiatedHoldTimeSeconds ?? 0) > 0) {
          this.send(runtime, { kind: "bgp-keepalive" });
        }
      } else {
        this.tryConnect(runtime);
      }
    }
    this.activityRound++;
    if (this.activityRound >= this.activityRounds) {
      // The control plane now enters quiescence. Freeze the baseline at the
      // end of the finite activity window; only a later explicit virtual-time
      // jump is inactivity rather than an artifact of another peer's window.
      const now = this.host.engine.now();
      for (const runtime of this.neighbors.values()) {
        if (runtime.state === "established") runtime.lastReceivedAtNs = now;
      }
    }
  }

  /**
   * Quiescent control protocols leave no future events in the engine queue.
   * Inspection and route lookup therefore perform the same deterministic lazy
   * expiry used by other bounded runtime caches after an explicit clock jump.
   */
  private expireHoldTimers(): void {
    const now = this.host.engine.now();
    for (const runtime of this.neighbors.values()) {
      const holdSeconds = runtime.negotiatedHoldTimeSeconds;
      if (runtime.state !== "established" || !holdSeconds || runtime.lastReceivedAtNs === undefined) continue;
      if (now - runtime.lastReceivedAtNs < holdSeconds * NS_PER_S) continue;
      this.trace("bgp-hold-expired", {
        neighbor: runtime.configuration.address,
        holdTimeSeconds: holdSeconds,
      });
      this.fail(runtime, `BGP hold timer expired after ${holdSeconds} seconds`);
    }
  }

  private applyUpdate(runtime: NeighborRuntime, message: Extract<BgpMessage, { kind: "bgp-update" }>): void {
    if (!this.configuration) return;
    this.applyUnicastUpdate(runtime, "ipv4-unicast", message.withdrawn, message.nlri);
    if (this.familyNegotiated(runtime, "ipv6-unicast")) {
      this.applyUnicastUpdate(runtime, "ipv6-unicast", message.ipv6Withdrawn ?? [], message.ipv6Nlri ?? []);
    }
    this.applyVpnv4Update(runtime, message);
    this.advertiseRoutes();
  }

  /**
   * One inbound path for both unicast families. The NLRI shape is identical;
   * only the prefix canonicalization differs, so there is a single loop rather
   * than a copied IPv6 one.
   */
  private applyUnicastUpdate(
    runtime: NeighborRuntime,
    family: BgpUnicastAddressFamily,
    withdrawn: readonly { network: IpAddress; prefixLength: number }[],
    announced: readonly import("../packets/bgp").BgpNlri[],
  ): void {
    if (!this.configuration) return;
    if (withdrawn.length === 0 && announced.length === 0) return;
    const ribs = this.unicast[family];
    const rawRib = ribs.raw.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
    for (const entry of withdrawn) {
      rawRib.delete(this.prefixKey(this.canonicalPrefix(entry.network, entry.prefixLength, family), entry.prefixLength));
    }
    enforceStructuralLimit("maximumBgpPrefixesPerPeer", rawRib.size + announced.length);
    const maximumPrefixLength = family === "ipv6-unicast" ? 128 : 32;
    for (const nlri of announced) {
      if (nlri.prefixLength < 0 || nlri.prefixLength > maximumPrefixLength || nlri.path.asPath.length > 256) {
        this.trace("bgp-route-rejected", { neighbor: runtime.configuration.address, addressFamily: family, routeId: nlri.routeId, reason: "malformed NLRI" });
        continue;
      }
      if (nlri.path.asPath.includes(this.configuration.localAs)) {
        this.trace("bgp-loop-rejected", { neighbor: runtime.configuration.address, addressFamily: family, routeId: nlri.routeId });
        continue;
      }
      if (this.rejectReflectionLoop(runtime, nlri.routeId, nlri.path, family)) continue;
      const igpMetric = this.host.bgpIgpMetric(nlri.path.nextHop);
      const route: BgpRoute = {
        addressFamily: family,
        network: this.canonicalPrefix(nlri.network, nlri.prefixLength, family),
        prefixLength: nlri.prefixLength,
        origin: nlri.path.origin,
        asPath: [...nlri.path.asPath],
        nextHop: nlri.path.nextHop,
        localPreference: nlri.path.localPreference ?? 100,
        med: nlri.path.med ?? 0,
        weight: 0,
        source: runtime.configuration.remoteAs === this.configuration.localAs ? "ibgp" : "ebgp",
        neighborAddress: runtime.configuration.address,
        neighborAs: runtime.configuration.remoteAs,
        neighborRouterId: runtime.remoteRouterId,
        learnedAtNs: this.host.engine.now(),
        routeId: nlri.routeId,
        igpMetric: igpMetric ?? Number.MAX_SAFE_INTEGER,
        communities: normalizeBgpCommunities(nlri.path.communities),
        originatorId: nlri.path.originatorId,
        clusterList: [...(nlri.path.clusterList ?? [])],
      };
      if (nlri.path.reflected) {
        this.trace("bgp-route-reflected", {
          neighbor: runtime.configuration.address,
          addressFamily: family,
          direction: "in",
          routeId: route.routeId,
          originatorId: route.originatorId,
          clusterList: route.clusterList,
        });
      }
      rawRib.set(this.prefixKey(route.network, route.prefixLength), route);
    }
    ribs.raw.set(runtime.configuration.address, rawRib);
    this.evaluateInboundRib(runtime, family);
    this.recomputeLocRib(family);
  }

  private canonicalPrefix(network: IpAddress, prefixLength: number, family: BgpUnicastAddressFamily): IpAddress {
    return family === "ipv6-unicast"
      ? ipv6Network(network, prefixLength)
      : intToIp((ipToInt(network) & maskToInt(prefixLength)) >>> 0);
  }

  /**
   * A `network` statement originates a prefix only while an exact route of the
   * same family already exists locally, which is what makes the statement a
   * teaching point rather than a free advertisement.
   */
  private localCandidates(family: BgpUnicastAddressFamily): BgpRoute[] {
    if (!this.configuration) return [];
    const routerId = this.configuration.routerId ?? "0.0.0.0";
    const statements: ReadonlyArray<{ network: IpAddress; prefixLength: number }> = family === "ipv6-unicast"
      ? (this.configuration.ipv6Networks ?? [])
      : (this.configuration.networks ?? []);
    const unspecified = family === "ipv6-unicast" ? "::" : "0.0.0.0";
    return statements
      .filter((network) => this.host.bgpExactRouteExists(network.network, network.prefixLength, family))
      .map((network) => ({
        addressFamily: family,
        network: network.network,
        prefixLength: network.prefixLength,
        origin: "igp" as const,
        asPath: [],
        nextHop: unspecified,
        localPreference: 100,
        med: 0,
        weight: 32_768,
        source: "local" as const,
        neighborRouterId: routerId,
        learnedAtNs: 0,
        routeId: `local:${network.network}/${network.prefixLength}`,
        igpMetric: 0,
        communities: [],
        clusterList: [],
      }));
  }

  /** `true` for a route this process originated from `aggregate-address`. */
  private isAggregate(route: BgpRoute): boolean {
    return route.source === "local" && route.routeId.startsWith(AGGREGATE_ROUTE_PREFIX);
  }

  private aggregateOf(route: BgpRoute): BgpAggregateConfiguration | undefined {
    if (!this.isAggregate(route)) return undefined;
    return this.configuration?.aggregates?.find((aggregate) =>
      aggregate.prefix === route.network && aggregate.prefixLength === route.prefixLength);
  }

  private contributorsOf(aggregate: BgpAggregateConfiguration, candidates: readonly BgpRoute[]): BgpRoute[] {
    const mask = maskToInt(aggregate.prefixLength);
    const network = ipToInt(aggregate.prefix);
    return candidates.filter((route) => route.prefixLength > aggregate.prefixLength
      && ((ipToInt(route.network) & mask) >>> 0) === network);
  }

  /**
   * One summary per configured aggregate that has at least one contributing
   * more-specific path. ORIGIN is INCOMPLETE, the next hop is local and the
   * community set is the bounded canonical union of the contributing paths, so
   * a summary can still carry `no-export` from the routes it represents.
   */
  private aggregateCandidates(candidates: readonly BgpRoute[]): BgpRoute[] {
    const configured = this.configuration?.aggregates ?? [];
    if (!configured.length) return [];
    const routerId = this.configuration?.routerId ?? "0.0.0.0";
    const produced: BgpRoute[] = [];
    const active = new Set<string>();
    for (const aggregate of configured) {
      const key = `${aggregate.prefix}/${aggregate.prefixLength}`;
      const contributors = this.contributorsOf(aggregate, candidates);
      if (!contributors.length) continue;
      active.add(key);
      const asSet = aggregate.asSet
        ? [...new Set(contributors.flatMap((route) => route.asPath))].sort((a, b) => a - b)
          .slice(0, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpClusterListLength)
        : [];
      const communities = normalizeBgpCommunities(contributors.flatMap((route) => route.communities))
        .slice(0, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpCommunitiesPerRoute);
      produced.push({
        addressFamily: "ipv4-unicast",
        network: aggregate.prefix,
        prefixLength: aggregate.prefixLength,
        origin: "incomplete",
        asPath: asSet,
        nextHop: "0.0.0.0",
        localPreference: 100,
        med: 0,
        weight: 32_768,
        source: "local",
        neighborRouterId: routerId,
        learnedAtNs: 0,
        routeId: `${AGGREGATE_ROUTE_PREFIX}${key}`,
        igpMetric: 0,
        communities,
        clusterList: [],
      });
    }
    for (const key of active) {
      if (!this.activeAggregates.has(key)) {
        this.trace("bgp-aggregate-originated", { prefix: key, contributingRoutes: this.activeAggregates.size });
      }
    }
    for (const key of this.activeAggregates) {
      if (!active.has(key)) this.trace("bgp-aggregate-withdrawn", { prefix: key, reason: "no contributing route" });
    }
    this.activeAggregates.clear();
    for (const key of active) this.activeAggregates.add(key);
    return produced;
  }

  /** Configured aggregates with their live contribution and suppression counts. */
  aggregateSummaries(): BgpAggregateSummary[] {
    const candidates = [...this.unicast["ipv4-unicast"].loc.values()].filter((route) => !this.isAggregate(route));
    return (this.configuration?.aggregates ?? []).map((aggregate) => {
      const contributors = this.contributorsOf(aggregate, candidates);
      return {
        ...aggregate,
        active: this.activeAggregates.has(`${aggregate.prefix}/${aggregate.prefixLength}`),
        contributingRoutes: contributors.length,
        suppressedRoutes: aggregate.summaryOnly ? contributors.length : 0,
      };
    }).sort((a, b) => ipToInt(a.prefix) - ipToInt(b.prefix) || a.prefixLength - b.prefixLength);
  }

  /** More-specific routes a `summary-only` aggregate hides from advertisements. */
  suppressedRoutes(): BgpSuppressedRoute[] {
    const candidates = [...this.unicast["ipv4-unicast"].loc.values()].filter((route) => !this.isAggregate(route));
    return (this.configuration?.aggregates ?? [])
      .filter((aggregate) => aggregate.summaryOnly && this.activeAggregates.has(`${aggregate.prefix}/${aggregate.prefixLength}`))
      .flatMap((aggregate) => this.contributorsOf(aggregate, candidates).map((route) => ({
        network: route.network,
        prefixLength: route.prefixLength,
        aggregate: `${aggregate.prefix}/${aggregate.prefixLength}`,
      })))
      .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.prefixLength - b.prefixLength);
  }

  private recomputeLocRib(family: BgpUnicastAddressFamily): void {
    const ribs = this.unicast[family];
    const learned = [...this.localCandidates(family), ...this.adjRibInEntries(undefined, family)];
    // Aggregation is IPv4-only in M10.13: the generic refactor its IPv6
    // counterpart would need is deliberately deferred rather than copied.
    const candidates = family === "ipv4-unicast"
      ? [...learned, ...this.aggregateCandidates(learned)]
      : learned;
    const groups = new Map<string, BgpRoute[]>();
    ribs.failures.clear();
    for (const route of candidates) {
      if (route.source !== "local" && this.host.bgpIgpMetric(route.nextHop) === undefined) {
        ribs.failures.set(route.routeId, `next hop ${route.nextHop} is unreachable`);
        continue;
      }
      const key = this.prefixKey(route.network, route.prefixLength);
      const group = groups.get(key) ?? [];
      group.push({ ...route, igpMetric: route.source === "local" ? 0 : (this.host.bgpIgpMetric(route.nextHop) ?? route.igpMetric) });
      groups.set(key, group);
    }
    const next = new Map<string, BgpRoute>();
    for (const [key, routes] of groups) {
      const best = selectBestBgpPath(routes);
      if (best) next.set(key, best);
    }
    const before = JSON.stringify([...ribs.loc.entries()]);
    const after = JSON.stringify([...next.entries()]);
    if (before === after) return;
    ribs.loc.clear();
    for (const [key, route] of next) ribs.loc.set(key, route);
    this.host.bgpRoutesChanged(family);
    this.trace("bgp-best-path-changed", { addressFamily: family, routes: ribs.loc.size });
  }

  private applyVpnv4Update(runtime: NeighborRuntime, message: Extract<BgpMessage, { kind: "bgp-update" }>): void {
    const negotiated = runtime.configuration.vpnv4Activated === true
      && runtime.remoteAddressFamilies?.includes("vpnv4-unicast") === true;
    if (!negotiated) return;
    const rib = this.vpnv4AdjRibIn.get(runtime.configuration.address) ?? new Map<string, Vpnv4Route>();
    for (const withdrawn of message.vpnv4Withdrawn ?? []) {
      rib.delete(this.vpnPrefixKey(withdrawn.routeDistinguisher, withdrawn.network, withdrawn.prefixLength));
    }
    for (const nlri of message.vpnv4Nlri ?? []) {
      if (nlri.prefixLength < 0 || nlri.prefixLength > 32 || nlri.path.asPath.length > 256) continue;
      if (this.configuration && nlri.path.asPath.includes(this.configuration.localAs)) continue;
      if (this.rejectReflectionLoop(runtime, nlri.routeId, nlri.path, "vpnv4")) continue;
      const metric = this.host.bgpIgpMetric(nlri.nextHop);
      const route: Vpnv4Route = {
        ...nlri,
        routeTargets: [...nlri.routeTargets],
        path: { ...nlri.path, asPath: [...nlri.path.asPath] },
        communities: normalizeBgpCommunities(nlri.path.communities),
        originatorId: nlri.path.originatorId,
        clusterList: [...(nlri.path.clusterList ?? [])],
        source: runtime.configuration.remoteAs === this.configuration?.localAs ? "ibgp" : "ebgp",
        neighborAddress: runtime.configuration.address,
        neighborAs: runtime.configuration.remoteAs,
        neighborRouterId: runtime.remoteRouterId,
        learnedAtNs: this.host.engine.now(),
        localPreference: nlri.path.localPreference ?? 100,
        med: nlri.path.med ?? 0,
        weight: 0,
        igpMetric: metric ?? Number.MAX_SAFE_INTEGER,
      };
      rib.set(this.vpnPrefixKey(route.routeDistinguisher, route.network, route.prefixLength), route);
      this.trace("bgp-vpnv4-route-received", {
        neighbor: runtime.configuration.address,
        rd: route.routeDistinguisher,
        prefix: `${route.network}/${route.prefixLength}`,
        routeTargets: route.routeTargets,
      });
    }
    this.vpnv4AdjRibIn.set(runtime.configuration.address, rib);
    this.recomputeVpnv4LocRib();
  }

  private recomputeVpnv4LocRib(): void {
    const groups = new Map<string, Vpnv4Route[]>();
    for (const route of [...this.host.bgpVpnv4Exports(), ...[...this.vpnv4AdjRibIn.values()].flatMap((rib) => [...rib.values()])]) {
      if (route.source !== "local" && this.host.bgpIgpMetric(route.nextHop) === undefined) continue;
      const key = this.vpnPrefixKey(route.routeDistinguisher, route.network, route.prefixLength);
      const list = groups.get(key) ?? [];
      list.push({ ...route, igpMetric: route.source === "local" ? 0 : (this.host.bgpIgpMetric(route.nextHop) ?? route.igpMetric) });
      groups.set(key, list);
    }
    const next = new Map<string, Vpnv4Route>();
    for (const [key, candidates] of groups) {
      const best = [...candidates].sort(compareVpnv4Paths)[0];
      if (best) next.set(key, best);
    }
    if (JSON.stringify([...next]) === JSON.stringify([...this.vpnv4LocRib])) return;
    this.vpnv4LocRib.clear();
    for (const [key, route] of next) this.vpnv4LocRib.set(key, route);
    this.host.bgpVpnv4RoutesChanged([...next.values()].filter((route) => route.source !== "local"));
    this.trace("bgp-vpnv4-best-path-changed", { routes: next.size });
  }

  private advertiseRoutes(): void {
    if (!this.configuration) return;
    for (const runtime of this.neighbors.values()) {
      if (runtime.state !== "established" || !runtime.localAddress) continue;
      const peerIsIbgp = runtime.configuration.remoteAs === this.configuration.localAs;
      const ipv4 = this.advertiseUnicast(runtime, "ipv4-unicast", peerIsIbgp);
      const ipv6 = this.familyNegotiated(runtime, "ipv6-unicast")
        ? this.advertiseUnicast(runtime, "ipv6-unicast", peerIsIbgp)
        : { announcements: [], withdrawn: [] };
      const vpnPrevious = this.vpnv4AdjRibOut.get(runtime.configuration.address) ?? new Map<string, Vpnv4Route>();
      const vpnDesired = new Map<string, Vpnv4Route>();
      const vpnAnnouncements: Vpnv4Nlri[] = [];
      const sendsCommunities = runtime.configuration.sendCommunityStandard === true;
      const vpnNegotiated = this.familyNegotiated(runtime, "vpnv4-unicast");
      if (vpnNegotiated) {
        for (const route of this.vpnv4LocRib.values()) {
          if (route.neighborAddress === runtime.configuration.address) continue;
          const reflection = this.reflectionDecision(route, runtime, peerIsIbgp);
          if (!reflection.advertise) continue;
          if (communityBlocksAdvertisement(route.communities, peerIsIbgp) !== undefined) continue;
          const reflectedAttributes = this.reflectAttributes(route, reflection.reflect, peerIsIbgp);
          if (reflectedAttributes === undefined) continue;
          const key = this.vpnPrefixKey(route.routeDistinguisher, route.network, route.prefixLength);
          const advertised: Vpnv4Route = {
            ...route,
            ...reflectedAttributes,
            communities: sendsCommunities ? [...route.communities] : [],
            routeTargets: runtime.configuration.sendCommunityExtended ? [...route.routeTargets] : [],
            path: {
              ...route.path,
              asPath: peerIsIbgp ? [...route.path.asPath] : [this.configuration.localAs, ...route.path.asPath],
              localPreference: peerIsIbgp ? route.localPreference : undefined,
              communities: sendsCommunities && route.communities.length ? [...route.communities] : undefined,
              originatorId: reflectedAttributes.originatorId,
              clusterList: reflectedAttributes.clusterList.length ? [...reflectedAttributes.clusterList] : undefined,
              reflected: reflection.reflect ? true : undefined,
            },
            routeId: `${this.configuration.routerId ?? this.host.id}:vpnv4:${key}`,
          };
          if (reflection.reflect) {
            this.host.engine.controlProtocolBudget.consume("bgpReflectedUpdates", this.host.id);
            this.trace("bgp-route-reflected", {
              neighbor: runtime.configuration.address,
              direction: "out",
              addressFamily: "vpnv4-unicast",
              rd: route.routeDistinguisher,
              prefix: `${route.network}/${route.prefixLength}`,
              originatorId: advertised.originatorId,
              clusterList: advertised.clusterList,
            });
          }
          vpnDesired.set(key, advertised);
          if (JSON.stringify(vpnPrevious.get(key)) !== JSON.stringify(advertised)) {
            vpnAnnouncements.push({
              routeDistinguisher: advertised.routeDistinguisher,
              network: advertised.network,
              prefixLength: advertised.prefixLength,
              routeTargets: advertised.routeTargets,
              vpnLabel: advertised.vpnLabel,
              nextHop: advertised.nextHop,
              sourceVrfId: advertised.sourceVrfId,
              path: advertised.path,
              routeId: advertised.routeId,
            });
          }
        }
      }
      const vpnWithdrawn = [...vpnPrevious.entries()]
        .filter(([key]) => !vpnDesired.has(key))
        .map(([, route]) => ({
          routeDistinguisher: route.routeDistinguisher,
          network: route.network,
          prefixLength: route.prefixLength,
        }));
      const carries = ipv4.announcements.length || ipv4.withdrawn.length
        || ipv6.announcements.length || ipv6.withdrawn.length
        || vpnAnnouncements.length || vpnWithdrawn.length;
      if (carries) {
        this.send(runtime, {
          kind: "bgp-update",
          withdrawn: ipv4.withdrawn,
          nlri: ipv4.announcements,
          ipv6Withdrawn: ipv6.withdrawn,
          ipv6Nlri: ipv6.announcements,
          vpnv4Withdrawn: vpnWithdrawn,
          vpnv4Nlri: vpnAnnouncements,
        });
      }
      this.vpnv4AdjRibOut.set(runtime.configuration.address, vpnDesired);
    }
  }

  /**
   * The outbound path of one unicast family for one peer. Reflection, community
   * blocking, `next-hop-self` and policy are identical in both families; only
   * aggregation and `default-originate` are IPv4-specific, and the per-family
   * neighbor policy binding decides which prefix lists and route maps apply.
   */
  private advertiseUnicast(
    runtime: NeighborRuntime,
    family: BgpUnicastAddressFamily,
    peerIsIbgp: boolean,
  ): { announcements: import("../packets/bgp").BgpNlri[]; withdrawn: Array<{ network: IpAddress; prefixLength: number }> } {
    const empty = { announcements: [], withdrawn: [] };
    if (!this.configuration || runtime.localAddress === undefined) return empty;
    const ribs = this.unicast[family];
    const policy = this.familyPolicy(runtime.configuration, family);
    const localAddress = this.localAddressFor(runtime, family);
    if (localAddress === undefined) return empty;
    const previous = ribs.adjOut.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
    const desired = new Map<string, BgpRoute>();
    const announcements: import("../packets/bgp").BgpNlri[] = [];
    const sendsCommunities = policy.sendCommunityStandard === true;
    // Aggregates are evaluated first so `summary-only` can only suppress a
    // more-specific route on a peer that actually received the summary.
    const suppressing: BgpAggregateConfiguration[] = [];
    const ordered = [...ribs.loc.values()].sort((a, b) =>
      Number(this.isAggregate(b)) - Number(this.isAggregate(a))
      || compareBgpAddresses(a.network, b.network)
      || a.prefixLength - b.prefixLength);
    {
      for (const route of ordered) {
        if (route.neighborAddress === runtime.configuration.address) continue;
        const summary = suppressing.find((aggregate) => this.contributorsOf(aggregate, [route]).length > 0);
        if (summary) {
          this.trace("bgp-specific-suppressed", {
            neighbor: runtime.configuration.address,
            prefix: `${route.network}/${route.prefixLength}`,
            aggregate: `${summary.prefix}/${summary.prefixLength}`,
          });
          continue;
        }
        const reflection = this.reflectionDecision(route, runtime, peerIsIbgp);
        if (!reflection.advertise) continue;
        const blocked = communityBlocksAdvertisement(route.communities, peerIsIbgp);
        if (blocked !== undefined) {
          this.trace("bgp-community-suppressed-advertisement", {
            neighbor: runtime.configuration.address,
            prefix: `${route.network}/${route.prefixLength}`,
            community: blocked,
          });
          continue;
        }
        const reflectedAttributes = this.reflectAttributes(route, reflection.reflect, peerIsIbgp);
        if (reflectedAttributes === undefined) {
          this.trace("bgp-route-reflection-rejected", {
            neighbor: runtime.configuration.address,
            prefix: `${route.network}/${route.prefixLength}`,
            reason: `cluster list exceeds ${DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpClusterListLength} entries`,
          });
          continue;
        }
        const advertised: BgpRoute = {
          ...route,
          asPath: peerIsIbgp ? [...route.asPath] : [this.configuration.localAs, ...route.asPath],
          nextHop: (!peerIsIbgp || policy.nextHopSelf || route.source === "local")
            ? localAddress
            : route.nextHop,
          ...reflectedAttributes,
          routeId: `${this.configuration.routerId ?? this.host.id}:${route.network}/${route.prefixLength}`,
        };
        const decision = this.routingPolicy.evaluate(advertised, this.outboundBinding(policy), this.configuration.localAs);
        this.trace(decision.action === "permit" ? "bgp-policy-permit" : "bgp-policy-deny", {
          direction: "out",
          neighbor: runtime.configuration.address,
          routeId: advertised.routeId,
          reason: decision.reason,
        });
        this.traceCommunityChanges(decision, "out", runtime.configuration.address);
        this.traceListEvaluations(decision, "out", runtime.configuration.address);
        if (decision.action === "deny") continue;
        // Adj-RIB-Out stores exactly what leaves this device: without
        // `send-community` the peer never learns the attribute, so the
        // advertised-routes view must not pretend otherwise.
        const permitted: BgpRoute = {
          ...decision.route,
          communities: sendsCommunities ? decision.route.communities : [],
        };
        if (reflection.reflect) {
          this.host.engine.controlProtocolBudget.consume("bgpReflectedUpdates", this.host.id);
          this.trace("bgp-route-reflected", {
            neighbor: runtime.configuration.address,
            addressFamily: family,
            direction: "out",
            prefix: `${permitted.network}/${permitted.prefixLength}`,
            originatorId: permitted.originatorId,
            clusterList: permitted.clusterList,
          });
        }
        desired.set(this.prefixKey(route.network, route.prefixLength), permitted);
        const aggregate = this.aggregateOf(route);
        if (aggregate?.summaryOnly) suppressing.push(aggregate);
        if (JSON.stringify(previous.get(this.prefixKey(route.network, route.prefixLength))) !== JSON.stringify(permitted)) {
          announcements.push({
            network: permitted.network,
            prefixLength: permitted.prefixLength,
            routeId: permitted.routeId,
            path: {
              origin: permitted.origin,
              asPath: permitted.asPath,
              nextHop: permitted.nextHop,
              localPreference: peerIsIbgp ? permitted.localPreference : undefined,
              med: permitted.med,
              communities: permitted.communities.length ? permitted.communities : undefined,
              originatorId: permitted.originatorId,
              clusterList: permitted.clusterList.length ? permitted.clusterList : undefined,
              reflected: reflection.reflect ? true : undefined,
              aggregatorAsSet: aggregate?.asSet && permitted.asPath.length ? [...permitted.asPath] : undefined,
            },
          });
        }
      }
      this.originateDefault(runtime, family, policy, peerIsIbgp, localAddress, previous, desired, announcements);
      const withdrawn = [...previous.entries()]
        .filter(([key]) => !desired.has(key))
        .map(([, route]) => ({ network: route.network, prefixLength: route.prefixLength }));
      ribs.adjOut.set(runtime.configuration.address, desired);
      return { announcements, withdrawn };
    }
  }

  /** Per-family neighbor policy; IPv4 keeps the flat pre-M10.13 fields. */
  private familyPolicy(
    neighbor: BgpNeighborConfiguration,
    family: BgpUnicastAddressFamily,
  ): BgpNeighborIpv6AddressFamily {
    return family === "ipv6-unicast" ? (neighbor.ipv6 ?? {}) : {
      nextHopSelf: neighbor.nextHopSelf,
      prefixListIn: neighbor.prefixListIn,
      prefixListOut: neighbor.prefixListOut,
      routeMapIn: neighbor.routeMapIn,
      routeMapOut: neighbor.routeMapOut,
      sendCommunityStandard: neighbor.sendCommunityStandard,
      routeReflectorClient: neighbor.routeReflectorClient,
      defaultOriginate: neighbor.defaultOriginate,
      defaultOriginateRouteMap: neighbor.defaultOriginateRouteMap,
    };
  }

  /**
   * The next hop this device offers for one family. An IPv6 prefix needs an
   * IPv6 next hop even when the session itself runs over IPv4, so the local
   * transport address is only reusable when the families already match.
   */
  private localAddressFor(runtime: NeighborRuntime, family: BgpUnicastAddressFamily): IpAddress | undefined {
    const wanted = family === "ipv6-unicast" ? "ipv6" : "ipv4";
    if (runtime.localAddress !== undefined && ipFamilyOf(runtime.localAddress) === wanted) return runtime.localAddress;
    return this.host.bgpNextHop(family, runtime.configuration.address, runtime.configuration.updateSource);
  }

  /**
   * `neighbor <a> default-originate` advertises the family's default route to
   * exactly one peer. Cisco-like educational behaviour: no local default route
   * is required, and the default is never installed locally — it only ever
   * exists in that peer's Adj-RIB-Out.
   */
  private originateDefault(
    runtime: NeighborRuntime,
    family: BgpUnicastAddressFamily,
    policy: BgpNeighborIpv6AddressFamily,
    peerIsIbgp: boolean,
    localAddress: IpAddress,
    previous: Map<string, BgpRoute>,
    desired: Map<string, BgpRoute>,
    announcements: import("../packets/bgp").BgpNlri[],
  ): void {
    if (!this.configuration || !policy.defaultOriginate) return;
    const network = family === "ipv6-unicast" ? "::" : "0.0.0.0";
    const candidate: BgpRoute = {
      addressFamily: family,
      network,
      prefixLength: 0,
      origin: "igp",
      asPath: peerIsIbgp ? [] : [this.configuration.localAs],
      nextHop: localAddress,
      localPreference: 100,
      med: 0,
      weight: 32_768,
      source: "local",
      neighborRouterId: this.configuration.routerId,
      learnedAtNs: 0,
      routeId: `default-originate:${family}:${runtime.configuration.address}`,
      igpMetric: 0,
      communities: [],
      clusterList: [],
    };
    const routeMapId = policy.defaultOriginateRouteMap;
    const decision = routeMapId === undefined
      ? { action: "permit" as const, route: candidate, reason: "default-originate" }
      : this.routingPolicy.evaluate(candidate, { routeMapId }, this.configuration.localAs);
    if (decision.action === "deny") {
      this.trace("bgp-policy-deny", {
        direction: "out",
        addressFamily: family,
        neighbor: runtime.configuration.address,
        routeId: candidate.routeId,
        reason: decision.reason,
      });
      return;
    }
    const advertised = decision.route;
    desired.set(this.prefixKey(network, 0), advertised);
    this.trace("bgp-default-originated", { neighbor: runtime.configuration.address, addressFamily: family, routeMap: routeMapId });
    if (JSON.stringify(previous.get(this.prefixKey(network, 0))) === JSON.stringify(advertised)) return;
    announcements.push({
      network,
      prefixLength: 0,
      routeId: advertised.routeId,
      path: {
        origin: advertised.origin,
        asPath: advertised.asPath,
        nextHop: advertised.nextHop,
        localPreference: peerIsIbgp ? advertised.localPreference : undefined,
        med: advertised.med,
        communities: policy.sendCommunityStandard && advertised.communities.length
          ? advertised.communities
          : undefined,
      },
    });
  }

  /**
   * Deterministic soft reconfiguration. The stored raw Adj-RIB-In is
   * re-evaluated and the outbound baseline is dropped so the current policy is
   * re-applied — all without touching the TCP session or the configuration.
   */
  softReset(address?: IpAddress, direction: "in" | "out" | "both" = "both"): void {
    if (!this.configuration) return;
    const selected = address === undefined ? [...this.neighbors.values()] : [this.requireNeighbor(address)];
    for (const runtime of selected) {
      this.trace("bgp-soft-reevaluation", { neighbor: runtime.configuration.address, direction });
      for (const family of UNICAST_FAMILIES) {
        if (direction !== "out") this.evaluateInboundRib(runtime, family);
        if (direction !== "in") this.unicast[family].adjOut.delete(runtime.configuration.address);
      }
    }
    for (const family of UNICAST_FAMILIES) this.recomputeLocRib(family);
    this.advertiseRoutes();
  }

  private traceListEvaluations(
    decision: { listEvaluations?: readonly import("../routing/route-policy").RoutePolicyListEvaluation[] },
    direction: "in" | "out",
    neighbor: IpAddress,
  ): void {
    for (const evaluation of decision.listEvaluations ?? []) {
      this.trace(evaluation.policyType === "community-list" ? "community-list-evaluated" : "as-path-list-evaluated", {
        direction,
        neighbor,
        policyId: evaluation.policyId,
        sequence: evaluation.sequence,
        result: evaluation.action,
      });
    }
  }

  private traceCommunityChanges(
    decision: { route: BgpRoute; communitiesAdded?: readonly string[]; communitiesRemoved?: readonly string[] },
    direction: "in" | "out",
    neighbor: IpAddress,
  ): void {
    const detail = { direction, neighbor, routeId: decision.route.routeId };
    if (decision.communitiesAdded?.length) {
      this.trace("bgp-community-added", { ...detail, communities: decision.communitiesAdded });
    }
    if (decision.communitiesRemoved?.length) {
      this.trace("bgp-community-removed", { ...detail, communities: decision.communitiesRemoved });
    }
  }

  /** Reflection cluster identity; an unconfigured cluster ID is the router ID. */
  get clusterIdentity(): Ipv4 {
    return this.configuration?.clusterId ?? this.configuration?.routerId ?? "0.0.0.0";
  }

  /** `true` when at least one neighbor is a reflector client in any family. */
  get routeReflector(): boolean {
    return [...this.neighbors.values()].some((runtime) => this.isReflectorClient(runtime.configuration));
  }

  routeReflectorClients(): IpAddress[] {
    return [...this.neighbors.values()]
      .filter((runtime) => this.isReflectorClient(runtime.configuration))
      .map((runtime) => runtime.configuration.address)
      .sort(compareBgpAddresses);
  }

  private isReflectorClient(neighbor: BgpNeighborConfiguration, family?: BgpUnicastAddressFamily): boolean {
    if (family === "ipv6-unicast") return neighbor.ipv6?.routeReflectorClient === true;
    if (family === "ipv4-unicast") return neighbor.routeReflectorClient === true;
    return neighbor.routeReflectorClient === true || neighbor.ipv6?.routeReflectorClient === true;
  }

  /**
   * The documented reflection rule set.
   *
   * A plain iBGP speaker never passes an iBGP-learned path on, which is the
   * pre-M10.12 split-horizon behaviour. A reflector adds exactly two
   * exceptions: a client's path may go to anyone, and a non-client's path may
   * go to a client. Everything else — including eBGP — is unchanged.
   */
  private reflectionDecision(
    route: Pick<BgpRoute, "source" | "neighborAddress">,
    runtime: NeighborRuntime,
    peerIsIbgp: boolean,
    family?: BgpUnicastAddressFamily,
  ): { advertise: boolean; reflect: boolean } {
    if (!peerIsIbgp || route.source !== "ibgp") return { advertise: true, reflect: false };
    const peerIsClient = this.isReflectorClient(runtime.configuration, family);
    const source = route.neighborAddress === undefined ? undefined : this.neighbors.get(route.neighborAddress);
    const learnedFromClient = source !== undefined && this.isReflectorClient(source.configuration, family);
    if (!learnedFromClient && !peerIsClient) return { advertise: false, reflect: false };
    return { advertise: true, reflect: true };
  }

  /**
   * ORIGINATOR_ID and CLUSTER_LIST for one advertisement, or `undefined` when
   * the cluster list would exceed its finite bound. Both attributes are iBGP
   * only, so an eBGP advertisement always drops them.
   */
  private reflectAttributes(
    route: Pick<BgpRoute, "originatorId" | "clusterList" | "neighborRouterId">,
    reflect: boolean,
    peerIsIbgp: boolean,
  ): { originatorId: Ipv4 | undefined; clusterList: readonly string[] } | undefined {
    if (!peerIsIbgp) return { originatorId: undefined, clusterList: [] };
    if (!reflect) return { originatorId: route.originatorId, clusterList: [...route.clusterList] };
    const clusterList = [this.clusterIdentity, ...route.clusterList];
    if (clusterList.length > DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpClusterListLength) return undefined;
    return { originatorId: route.originatorId ?? route.neighborRouterId, clusterList };
  }

  /** ORIGINATOR_ID/CLUSTER_LIST loop prevention for one received NLRI. */
  private rejectReflectionLoop(
    runtime: NeighborRuntime,
    routeId: string,
    path: BgpPathAttributes,
    family: BgpAddressFamily | "vpnv4" = "ipv4-unicast",
  ): boolean {
    const clusterList = path.clusterList ?? [];
    const detail = { neighbor: runtime.configuration.address, routeId, addressFamily: family, family };
    const routerId = this.configuration?.routerId;
    if (path.originatorId !== undefined && routerId !== undefined && path.originatorId === routerId) {
      this.trace("bgp-originator-loop-rejected", { ...detail, originatorId: path.originatorId });
      return true;
    }
    if (this.clusterIdentity !== "0.0.0.0" && clusterList.includes(this.clusterIdentity)) {
      this.trace("bgp-cluster-loop-rejected", { ...detail, clusterId: this.clusterIdentity, clusterList });
      return true;
    }
    if (clusterList.length > DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpClusterListLength) {
      this.trace("bgp-route-reflection-rejected", {
        ...detail,
        reason: `cluster list exceeds ${DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpClusterListLength} entries`,
      });
      return true;
    }
    return false;
  }

  private prefixKey(network: IpAddress, prefixLength: number): string {
    return `${network}/${prefixLength}`;
  }

  private vpnPrefixKey(routeDistinguisher: string, network: IpAddress, prefixLength: number): string {
    return `${routeDistinguisher}:${network}/${prefixLength}`;
  }

  private reevaluatePolicies(): void {
    if (!this.configuration) return;
    for (const family of UNICAST_FAMILIES) {
      for (const runtime of this.neighbors.values()) this.evaluateInboundRib(runtime, family);
      this.recomputeLocRib(family);
    }
    // Force comparison against the pre-change outbound policy result.
    this.advertiseRoutes();
  }

  private evaluateInboundRib(runtime: NeighborRuntime, family: BgpUnicastAddressFamily): void {
    if (!this.configuration) return;
    const ribs = this.unicast[family];
    const raw = ribs.raw.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
    const evaluated = new Map<string, BgpRoute>();
    const policy = this.familyPolicy(runtime.configuration, family);
    for (const [key, route] of raw) {
      const decision = this.routingPolicy.evaluate(route, this.inboundBinding(policy), this.configuration.localAs);
      this.trace(decision.action === "permit" ? "bgp-policy-permit" : "bgp-policy-deny", {
        direction: "in",
        addressFamily: family,
        neighbor: runtime.configuration.address,
        routeId: route.routeId,
        reason: decision.reason,
        matchedPrefixListSequence: decision.matchedPrefixListSequence,
        matchedRouteMapSequence: decision.matchedRouteMapSequence,
      });
      this.traceCommunityChanges(decision, "in", runtime.configuration.address);
      this.traceListEvaluations(decision, "in", runtime.configuration.address);
      if (decision.action === "permit") evaluated.set(key, decision.route);
    }
    ribs.adjIn.set(runtime.configuration.address, evaluated);
  }

  private inboundBinding(policy: BgpNeighborIpv6AddressFamily): RoutePolicyBinding {
    return { prefixListId: policy.prefixListIn, routeMapId: policy.routeMapIn };
  }

  private outboundBinding(policy: BgpNeighborIpv6AddressFamily): RoutePolicyBinding {
    return { prefixListId: policy.prefixListOut, routeMapId: policy.routeMapOut };
  }

  private trace(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.host.engine.trace({ time: this.host.engine.now(), type, device: this.host.id, detail });
  }
}
