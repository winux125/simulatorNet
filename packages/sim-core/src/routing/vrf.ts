import type { Ipv4 } from "../util/ipv4";
import { intToIp, ipToInt, maskToInt } from "../util/ipv4";

export type RoutingContext = { readonly type: "global" } | { readonly type: "vrf"; readonly vrfId: string };

export interface VrfConfiguration {
  readonly id: string;
  readonly name: string;
  readonly routeDistinguisher: string;
  readonly importRouteTargets: readonly string[];
  readonly exportRouteTargets: readonly string[];
  readonly redistributeConnected?: boolean;
  readonly redistributeStatic?: boolean;
}

export interface VrfRoute {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly source: "connected" | "static" | "bgp-vpn";
  readonly nextHop?: Ipv4;
  readonly outgoingInterfaceId?: string;
  readonly remotePe?: Ipv4;
  readonly vpnLabel?: number;
  readonly routeDistinguisher?: string;
  readonly routeTargets?: readonly string[];
  readonly administrativeDistance: number;
  readonly metric: number;
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

  vpnLabel(vrfId: string): number {
    const ids = [...this.configurations.keys()].sort((a, b) => a.localeCompare(b));
    const index = ids.indexOf(vrfId);
    if (index < 0) throw new VrfConfigurationError(`Unknown VRF '${vrfId}'.`, "vrfId");
    return VPN_LABEL_BASE + index;
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

  routes(vrfId: string, connected: readonly VrfRoute[]): readonly VrfRoute[] {
    this.require(vrfId);
    return [
      ...connected.filter((entry) => entry.source === "connected").map(cloneRoute),
      ...(this.staticRoutes.get(vrfId) ?? []).map(cloneRoute),
      ...(this.importedRoutes.get(vrfId) ?? []).map(cloneRoute),
    ].sort(compareRoutes);
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

  private require(vrfId: string): VrfConfiguration {
    const value = this.configurations.get(vrfId);
    if (!value) throw new VrfConfigurationError(`Unknown VRF '${vrfId}'.`, "vrfId");
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

function compareRoutes(a: VrfRoute, b: VrfRoute): number {
  return ipToInt(a.network) - ipToInt(b.network)
    || b.prefixLength - a.prefixLength
    || a.source.localeCompare(b.source)
    || (a.nextHop ?? "").localeCompare(b.nextHop ?? "");
}
