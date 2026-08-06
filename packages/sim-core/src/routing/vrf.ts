import type { Ipv4 } from "../util/ipv4";
import { intToIp, ipToInt, maskToInt } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import { ipv6InPrefix, ipv6Network, ipv6ToBigInt, normalizeIpv6, validateIpv6PrefixLength } from "../util/ipv6";

export type RoutingContext = { readonly type: "global" } | { readonly type: "vrf"; readonly vrfId: string };

/**
 * The address families a VRF may carry. IPv4 is always present — it is what a
 * `vrf definition` has meant since M10.11 — while IPv6 is opt-in through
 * `address-family ipv6`, so a document written before M10.13 opens unchanged.
 */
export type VrfAddressFamily = "ipv4" | "ipv6";

export interface VrfConfiguration {
  readonly id: string;
  readonly name: string;
  readonly routeDistinguisher: string;
  readonly importRouteTargets: readonly string[];
  readonly exportRouteTargets: readonly string[];
  readonly redistributeConnected?: boolean;
  readonly redistributeStatic?: boolean;
  /** `address-family ipv6` inside `vrf definition`; absent means IPv4 only. */
  readonly addressFamilyIpv6?: boolean;
  /**
   * `address-family ipv4 vrf <name>` → `advertise l2vpn evpn`.
   *
   * Origination into EVPN is always explicit: without this flag a tenant's
   * connected and static routes stay local, so no redistribution is ever hidden.
   */
  readonly advertiseEvpn?: boolean;
}

export interface VrfRoute {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly source: "connected" | "static" | "bgp-vpn" | "evpn-type5";
  readonly nextHop?: Ipv4;
  readonly outgoingInterfaceId?: string;
  readonly remotePe?: Ipv4;
  readonly vpnLabel?: number;
  readonly routeDistinguisher?: string;
  readonly routeTargets?: readonly string[];
  /** Type 5 only: the VTEP that advertised the prefix and the transit L3VNI. */
  readonly remoteVtep?: Ipv4;
  readonly l3Vni?: number;
  readonly administrativeDistance: number;
  readonly metric: number;
}

/** One EVPN Type 5 prefix offered to the VRF tables, before RT filtering. */
export interface ImportedEvpnPrefixRoute {
  readonly routeDistinguisher: string;
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly l3Vni: number;
  readonly nextHopVtep: Ipv4;
  readonly metric?: number;
}

export interface ImportedVpnRoute {
  readonly routeDistinguisher: string;
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly vpnLabel: number;
  readonly nextHop: Ipv4;
  readonly metric?: number;
}

/** The IPv6 sibling of `VrfRoute`. The remote PE is still an IPv4 loopback. */
export interface VrfIpv6Route {
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly source: "connected" | "static" | "bgp-vpn";
  readonly nextHop?: Ipv6;
  readonly outgoingInterfaceId?: string;
  /** IPv4 transport next hop of the advertising PE. */
  readonly remotePe?: Ipv4;
  readonly vpnLabel?: number;
  readonly routeDistinguisher?: string;
  readonly routeTargets?: readonly string[];
  readonly administrativeDistance: number;
  readonly metric: number;
}

export interface ImportedVpnIpv6Route {
  readonly routeDistinguisher: string;
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly vpnLabel: number;
  /** IPv4 PE loopback resolved through the global OSPF/LDP core. */
  readonly nextHop: Ipv4;
  readonly metric?: number;
}

export class VrfConfigurationError extends Error {
  readonly code = "vrf-configuration";

  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "VrfConfigurationError";
  }
}

const VPN_LABEL_BASE = 100_000;
const MAXIMUM_VRFS_PER_ROUTER = 256;
const MAXIMUM_ROUTES_PER_VRF = 4_096;

/** Persistent VRF definitions plus isolated runtime route tables. */
export class VrfRoutingTable {
  private readonly configurations = new Map<string, VrfConfiguration>();
  private readonly staticRoutes = new Map<string, VrfRoute[]>();
  private readonly importedRoutes = new Map<string, VrfRoute[]>();
  private readonly ipv6StaticRoutes = new Map<string, VrfIpv6Route[]>();
  private readonly importedIpv6Routes = new Map<string, VrfIpv6Route[]>();
  /** EVPN Type 5 prefixes this VTEP imported by route target. Runtime only. */
  private readonly importedEvpnRoutes = new Map<string, VrfRoute[]>();

  define(configuration: VrfConfiguration): void {
    validateVrf(configuration);
    if (!this.configurations.has(configuration.id) && this.configurations.size >= MAXIMUM_VRFS_PER_ROUTER) {
      throw new VrfConfigurationError(`A Router supports at most ${MAXIMUM_VRFS_PER_ROUTER} VRFs.`, "vrfs");
    }
    for (const existing of this.configurations.values()) {
      if (existing.id !== configuration.id && existing.name.toLowerCase() === configuration.name.toLowerCase()) {
        throw new VrfConfigurationError(`VRF name '${configuration.name}' is already configured.`, "name");
      }
    }
    this.configurations.set(configuration.id, cloneConfiguration(configuration));
  }

  remove(vrfId: string): void {
    this.configurations.delete(vrfId);
    this.staticRoutes.delete(vrfId);
    this.importedRoutes.delete(vrfId);
    this.ipv6StaticRoutes.delete(vrfId);
    this.importedIpv6Routes.delete(vrfId);
    this.importedEvpnRoutes.delete(vrfId);
  }

  configuration(vrfId: string): VrfConfiguration | undefined {
    const value = this.configurations.get(vrfId);
    return value ? cloneConfiguration(value) : undefined;
  }

  configurationsSnapshot(): readonly VrfConfiguration[] {
    return [...this.configurations.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneConfiguration);
  }

  /**
   * One deterministic VPN label **per VRF and address family**, so an IPv4 and
   * an IPv6 delivery are never confused with each other on the egress PE. The
   * IPv4 label of the first VRF keeps its pre-M10.13 value.
   */
  vpnLabel(vrfId: string, family: VrfAddressFamily = "ipv4"): number {
    const ids = [...this.configurations.keys()].sort((a, b) => a.localeCompare(b));
    const index = ids.indexOf(vrfId);
    if (index < 0) throw new VrfConfigurationError(`Unknown VRF '${vrfId}'.`, "vrfId");
    return VPN_LABEL_BASE + (index * 2) + (family === "ipv6" ? 1 : 0);
  }

  /** The VRF and family a VPN label delivers into, or `undefined`. */
  vpnLabelBinding(label: number): { vrfId: string; family: VrfAddressFamily } | undefined {
    const offset = label - VPN_LABEL_BASE;
    if (!Number.isInteger(offset) || offset < 0) return undefined;
    const ids = [...this.configurations.keys()].sort((a, b) => a.localeCompare(b));
    const vrfId = ids[Math.floor(offset / 2)];
    return vrfId === undefined ? undefined : { vrfId, family: offset % 2 === 1 ? "ipv6" : "ipv4" };
  }

  addStaticRoute(vrfId: string, network: Ipv4, prefixLength: number, nextHop: Ipv4): void {
    this.require(vrfId);
    validatePrefix(network, prefixLength);
    ipToInt(nextHop);
    const routes = this.staticRoutes.get(vrfId) ?? [];
    const canonical = intToIp((ipToInt(network) & maskToInt(prefixLength)) >>> 0);
    const next = routes.filter((entry) => !(entry.network === canonical && entry.prefixLength === prefixLength));
    next.push({
      network: canonical,
      prefixLength,
      source: "static",
      nextHop,
      administrativeDistance: 1,
      metric: 0,
    });
    if (next.length > MAXIMUM_ROUTES_PER_VRF) {
      throw new VrfConfigurationError(`VRF '${vrfId}' exceeds ${MAXIMUM_ROUTES_PER_VRF} static routes.`, "routes");
    }
    this.staticRoutes.set(vrfId, next);
  }

  staticRouteConfigurations(vrfId: string): readonly VrfRoute[] {
    return [...(this.staticRoutes.get(vrfId) ?? [])].map(cloneRoute).sort(compareRoutes);
  }

  addIpv6StaticRoute(vrfId: string, network: Ipv6, prefixLength: number, nextHop: Ipv6): void {
    this.requireIpv6(vrfId);
    validateIpv6PrefixLength(prefixLength);
    const canonical = ipv6Network(network, prefixLength);
    if (canonical !== normalizeIpv6(network)) {
      throw new VrfConfigurationError(`VRF route '${network}/${prefixLength}' is not canonical.`, "network");
    }
    const hop = normalizeIpv6(nextHop);
    const routes = this.ipv6StaticRoutes.get(vrfId) ?? [];
    const next = routes.filter((entry) => !(entry.network === canonical && entry.prefixLength === prefixLength));
    next.push({
      network: canonical,
      prefixLength,
      source: "static",
      nextHop: hop,
      administrativeDistance: 1,
      metric: 0,
    });
    if (next.length > MAXIMUM_ROUTES_PER_VRF) {
      throw new VrfConfigurationError(`VRF '${vrfId}' exceeds ${MAXIMUM_ROUTES_PER_VRF} static routes.`, "routes");
    }
    this.ipv6StaticRoutes.set(vrfId, next);
  }

  ipv6StaticRouteConfigurations(vrfId: string): readonly VrfIpv6Route[] {
    return [...(this.ipv6StaticRoutes.get(vrfId) ?? [])].map(cloneIpv6Route).sort(compareIpv6Routes);
  }

  replaceImported(routes: readonly ImportedVpnRoute[]): void {
    this.importedRoutes.clear();
    for (const configuration of this.configurations.values()) {
      const imported = routes
        .filter((route) => route.routeTargets.some((target) => configuration.importRouteTargets.includes(target)))
        .map((route): VrfRoute => ({
          network: route.network,
          prefixLength: route.prefixLength,
          source: "bgp-vpn",
          nextHop: route.nextHop,
          remotePe: route.nextHop,
          vpnLabel: route.vpnLabel,
          routeDistinguisher: route.routeDistinguisher,
          routeTargets: [...route.routeTargets],
          administrativeDistance: 200,
          metric: route.metric ?? 0,
        }))
        .sort(compareRoutes);
      if (imported.length > MAXIMUM_ROUTES_PER_VRF) {
        throw new VrfConfigurationError(`VRF '${configuration.id}' exceeds ${MAXIMUM_ROUTES_PER_VRF} imported routes.`, "routes");
      }
      this.importedRoutes.set(configuration.id, imported);
    }
  }

  replaceImportedIpv6(routes: readonly ImportedVpnIpv6Route[]): void {
    this.importedIpv6Routes.clear();
    for (const configuration of this.configurations.values()) {
      const imported = routes
        .filter((route) => route.routeTargets.some((target) => configuration.importRouteTargets.includes(target)))
        .map((route): VrfIpv6Route => ({
          network: normalizeIpv6(route.network),
          prefixLength: route.prefixLength,
          source: "bgp-vpn",
          remotePe: route.nextHop,
          vpnLabel: route.vpnLabel,
          routeDistinguisher: route.routeDistinguisher,
          routeTargets: [...route.routeTargets],
          administrativeDistance: 200,
          metric: route.metric ?? 0,
        }))
        .sort(compareIpv6Routes);
      if (imported.length > MAXIMUM_ROUTES_PER_VRF) {
        throw new VrfConfigurationError(`VRF '${configuration.id}' exceeds ${MAXIMUM_ROUTES_PER_VRF} imported routes.`, "routes");
      }
      this.importedIpv6Routes.set(configuration.id, imported);
    }
  }

  /**
   * Install the EVPN Type 5 prefixes whose route targets intersect each VRF's
   * import list. A prefix with no matching target is simply not installed — it
   * stays in the EVPN RIB, which is what keeps two tenants isolated even when
   * they advertise the very same network.
   */
  replaceImportedEvpn(routes: readonly ImportedEvpnPrefixRoute[]): void {
    this.importedEvpnRoutes.clear();
    for (const configuration of this.configurations.values()) {
      const imported = routes
        .filter((route) => route.routeTargets.some((target) => configuration.importRouteTargets.includes(target)))
        .map((route): VrfRoute => ({
          network: route.network,
          prefixLength: route.prefixLength,
          source: "evpn-type5",
          remoteVtep: route.nextHopVtep,
          l3Vni: route.l3Vni,
          routeDistinguisher: route.routeDistinguisher,
          routeTargets: [...route.routeTargets],
          administrativeDistance: 200,
          metric: route.metric ?? 0,
        }))
        .sort(compareRoutes);
      if (imported.length > MAXIMUM_ROUTES_PER_VRF) {
        throw new VrfConfigurationError(`VRF '${configuration.id}' exceeds ${MAXIMUM_ROUTES_PER_VRF} imported routes.`, "routes");
      }
      this.importedEvpnRoutes.set(configuration.id, imported);
    }
  }

  /** The Type 5 prefixes one VRF actually installed, in canonical order. */
  importedEvpnRouteConfigurations(vrfId: string): readonly VrfRoute[] {
    return [...(this.importedEvpnRoutes.get(vrfId) ?? [])].map(cloneRoute).sort(compareRoutes);
  }

  routes(vrfId: string, connected: readonly VrfRoute[]): readonly VrfRoute[] {
    this.require(vrfId);
    return [
      ...connected.filter((entry) => entry.source === "connected").map(cloneRoute),
      ...(this.staticRoutes.get(vrfId) ?? []).map(cloneRoute),
      ...(this.importedRoutes.get(vrfId) ?? []).map(cloneRoute),
      ...(this.importedEvpnRoutes.get(vrfId) ?? []).map(cloneRoute),
    ].sort(compareRoutes);
  }

  ipv6Routes(vrfId: string, connected: readonly VrfIpv6Route[]): readonly VrfIpv6Route[] {
    this.require(vrfId);
    return [
      ...connected.filter((entry) => entry.source === "connected").map(cloneIpv6Route),
      ...(this.ipv6StaticRoutes.get(vrfId) ?? []).map(cloneIpv6Route),
      ...(this.importedIpv6Routes.get(vrfId) ?? []).map(cloneIpv6Route),
    ].sort(compareIpv6Routes);
  }

  lookup(vrfId: string, destination: Ipv4, connected: readonly VrfRoute[]): VrfRoute | undefined {
    const destinationInt = ipToInt(destination);
    return this.routes(vrfId, connected)
      .filter((route) => ((destinationInt & maskToInt(route.prefixLength)) >>> 0) === ipToInt(route.network))
      .sort((a, b) =>
        b.prefixLength - a.prefixLength
        || a.administrativeDistance - b.administrativeDistance
        || a.metric - b.metric
        || (a.nextHop ?? "").localeCompare(b.nextHop ?? "")
        || (a.outgoingInterfaceId ?? "").localeCompare(b.outgoingInterfaceId ?? ""))[0];
  }

  /**
   * Longest-prefix match inside one VRF. There is deliberately no fallback to
   * the global IPv6 table: a missing VRF route is unreachable, not global.
   */
  lookupIpv6(vrfId: string, destination: Ipv6, connected: readonly VrfIpv6Route[]): VrfIpv6Route | undefined {
    const target = normalizeIpv6(destination);
    return this.ipv6Routes(vrfId, connected)
      .filter((route) => ipv6InPrefix(target, route.network, route.prefixLength))
      .sort((a, b) =>
        b.prefixLength - a.prefixLength
        || a.administrativeDistance - b.administrativeDistance
        || a.metric - b.metric
        || (a.nextHop ?? "").localeCompare(b.nextHop ?? "")
        || (a.outgoingInterfaceId ?? "").localeCompare(b.outgoingInterfaceId ?? ""))[0];
  }

  private require(vrfId: string): VrfConfiguration {
    const value = this.configurations.get(vrfId);
    if (!value) throw new VrfConfigurationError(`Unknown VRF '${vrfId}'.`, "vrfId");
    return value;
  }

  private requireIpv6(vrfId: string): VrfConfiguration {
    const value = this.require(vrfId);
    if (!value.addressFamilyIpv6) {
      throw new VrfConfigurationError(`VRF '${value.name}' has no IPv6 address family.`, "addressFamilyIpv6");
    }
    return value;
  }
}

export function validateRouteDistinguisher(value: string): void {
  validateAdministratorNumber(value, "route distinguisher");
}

export function validateRouteTarget(value: string): void {
  validateAdministratorNumber(value, "route target");
}

function validateVrf(configuration: VrfConfiguration): void {
  if (!configuration.id.trim() || configuration.id.length > 64) throw new VrfConfigurationError("VRF ID must contain 1-64 characters.", "id");
  if (!configuration.name.trim() || configuration.name.length > 64) throw new VrfConfigurationError("VRF name must contain 1-64 characters.", "name");
  validateRouteDistinguisher(configuration.routeDistinguisher);
  for (const target of configuration.importRouteTargets) validateRouteTarget(target);
  for (const target of configuration.exportRouteTargets) validateRouteTarget(target);
}

function validateAdministratorNumber(value: string, field: string): void {
  const match = /^([^:]+):(\d+)$/.exec(value);
  if (!match) throw new VrfConfigurationError(`Invalid ${field} '${value}'.`, field);
  const [administrator, assignedText] = [match[1]!, match[2]!];
  const assigned = Number(assignedText);
  if (!Number.isInteger(assigned) || assigned < 0 || assigned > 4_294_967_295) {
    throw new VrfConfigurationError(`Invalid ${field} '${value}'.`, field);
  }
  if (/^\d+$/.test(administrator)) {
    const asn = Number(administrator);
    if (!Number.isInteger(asn) || asn < 1 || asn > 4_294_967_295) throw new VrfConfigurationError(`Invalid ${field} '${value}'.`, field);
  } else {
    ipToInt(administrator);
  }
}

function validatePrefix(network: Ipv4, prefixLength: number): void {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new VrfConfigurationError("IPv4 prefix length must be between 0 and 32.", "prefixLength");
  }
  if (((ipToInt(network) & maskToInt(prefixLength)) >>> 0) !== ipToInt(network)) {
    throw new VrfConfigurationError(`VRF route '${network}/${prefixLength}' is not canonical.`, "network");
  }
}

function cloneConfiguration(value: VrfConfiguration): VrfConfiguration {
  return { ...value, importRouteTargets: [...value.importRouteTargets], exportRouteTargets: [...value.exportRouteTargets] };
}

function cloneRoute(value: VrfRoute): VrfRoute {
  return { ...value, routeTargets: value.routeTargets ? [...value.routeTargets] : undefined };
}

function cloneIpv6Route(value: VrfIpv6Route): VrfIpv6Route {
  return { ...value, routeTargets: value.routeTargets ? [...value.routeTargets] : undefined };
}

function compareRoutes(a: VrfRoute, b: VrfRoute): number {
  return ipToInt(a.network) - ipToInt(b.network)
    || b.prefixLength - a.prefixLength
    || a.source.localeCompare(b.source)
    || (a.nextHop ?? "").localeCompare(b.nextHop ?? "");
}

function compareIpv6Routes(a: VrfIpv6Route, b: VrfIpv6Route): number {
  const left = ipv6ToBigInt(a.network);
  const right = ipv6ToBigInt(b.network);
  if (left !== right) return left < right ? -1 : 1;
  return b.prefixLength - a.prefixLength
    || a.source.localeCompare(b.source)
    || (a.nextHop ?? "").localeCompare(b.nextHop ?? "");
}
