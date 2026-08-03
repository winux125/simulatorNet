import type { BgpRoute, BgpRouteSource } from "../protocols/bgp";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt, maskToInt } from "../util/ipv4";
import { ControlProtocolConfigurationError } from "../protocols/limits";

export type RoutePolicyAction = "permit" | "deny";

export interface PrefixListEntry {
  readonly sequence: number;
  readonly action: RoutePolicyAction;
  readonly prefix: Ipv4;
  readonly prefixLength: number;
  readonly ge?: number;
  readonly le?: number;
}

export interface PrefixList {
  readonly id: string;
  readonly entries: readonly PrefixListEntry[];
}

export interface RouteMatch {
  readonly prefixListIds?: readonly string[];
  readonly neighbor?: Ipv4;
  readonly maximumAsPathLength?: number;
  readonly source?: BgpRouteSource;
}

export interface RouteSetAction {
  readonly localPreference?: number;
  readonly med?: number;
  readonly weight?: number;
  readonly prependLocalAs?: number;
  readonly origin?: BgpRoute["origin"];
}

export interface RouteMapSequence {
  readonly sequence: number;
  readonly action: RoutePolicyAction;
  readonly match?: RouteMatch;
  readonly set?: RouteSetAction;
}

export interface RouteMap {
  readonly id: string;
  readonly sequences: readonly RouteMapSequence[];
}

export interface RoutePolicyBinding {
  readonly prefixListId?: string;
  readonly routeMapId?: string;
}

export interface RoutePolicyDecision {
  readonly action: RoutePolicyAction;
  readonly route: BgpRoute;
  readonly matchedPrefixListSequence?: number;
  readonly matchedRouteMapSequence?: number;
  readonly reason: string;
}

export interface RoutePolicyCounter {
  readonly policyType: "prefix-list" | "route-map";
  readonly policyId: string;
  readonly sequence: number;
  readonly matches: number;
  readonly permits: number;
  readonly denies: number;
}

function validateSequence(sequence: number, field: string): void {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`${field} must be between 1 and 4294967295`, field);
  }
}

function validateUnsigned(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 4_294_967_295)) {
    throw new ControlProtocolConfigurationError(`${field} must be between 0 and 4294967295`, field);
  }
}

function prefixMatches(route: BgpRoute, entry: PrefixListEntry): boolean {
  const mask = maskToInt(entry.prefixLength);
  if (((ipToInt(route.network) & mask) >>> 0) !== ipToInt(entry.prefix)) return false;
  const minimum = entry.ge ?? entry.prefixLength;
  const maximum = entry.le ?? (entry.ge === undefined ? entry.prefixLength : 32);
  return route.prefixLength >= minimum && route.prefixLength <= maximum;
}

interface MutableCounter {
  policyType: RoutePolicyCounter["policyType"];
  policyId: string;
  sequence: number;
  matches: number;
  permits: number;
  denies: number;
}

/** Shared deterministic prefix-list/route-map evaluation engine. */
export class RoutingPolicyEngine {
  private readonly prefixLists = new Map<string, PrefixList>();
  private readonly routeMaps = new Map<string, RouteMap>();
  private readonly counters = new Map<string, MutableCounter>();

  constructor(private readonly onChanged: () => void = () => undefined) {}

  setPrefixLists(prefixLists: readonly PrefixList[]): void {
    const next = new Map<string, PrefixList>();
    for (const list of prefixLists) {
      if (!list.id.trim()) throw new ControlProtocolConfigurationError("Prefix-list name is required", "prefixList.id");
      if (next.has(list.id)) throw new ControlProtocolConfigurationError(`Duplicate prefix-list ${list.id}`, "prefixLists");
      const seen = new Set<number>();
      const entries = [...list.entries].sort((a, b) => a.sequence - b.sequence);
      for (const entry of entries) {
        validateSequence(entry.sequence, "prefixList.sequence");
        if (seen.has(entry.sequence)) throw new ControlProtocolConfigurationError(`Duplicate prefix-list sequence ${entry.sequence}`, "prefixList.sequence");
        seen.add(entry.sequence);
        if (entry.prefixLength < 0 || entry.prefixLength > 32 || !Number.isInteger(entry.prefixLength)) {
          throw new ControlProtocolConfigurationError("Prefix length must be between 0 and 32", "prefixList.prefixLength");
        }
        const mask = maskToInt(entry.prefixLength);
        if (((ipToInt(entry.prefix) & mask) >>> 0) !== ipToInt(entry.prefix)) {
          throw new ControlProtocolConfigurationError("Prefix-list entry must use a canonical network address", "prefixList.prefix");
        }
        if (entry.ge !== undefined && (!Number.isInteger(entry.ge) || entry.ge < entry.prefixLength || entry.ge > 32)) {
          throw new ControlProtocolConfigurationError("Prefix-list ge must be between the prefix length and 32", "prefixList.ge");
        }
        if (entry.le !== undefined && (!Number.isInteger(entry.le) || entry.le < (entry.ge ?? entry.prefixLength) || entry.le > 32)) {
          throw new ControlProtocolConfigurationError("Prefix-list le must be between ge/prefix length and 32", "prefixList.le");
        }
      }
      next.set(list.id, { id: list.id, entries });
    }
    this.prefixLists.clear();
    for (const [id, list] of next) this.prefixLists.set(id, list);
    this.onChanged();
  }

  setRouteMaps(routeMaps: readonly RouteMap[]): void {
    const next = new Map<string, RouteMap>();
    for (const map of routeMaps) {
      if (!map.id.trim()) throw new ControlProtocolConfigurationError("Route-map name is required", "routeMap.id");
      if (next.has(map.id)) throw new ControlProtocolConfigurationError(`Duplicate route-map ${map.id}`, "routeMaps");
      const seen = new Set<number>();
      const sequences = [...map.sequences].sort((a, b) => a.sequence - b.sequence);
      for (const sequence of sequences) {
        validateSequence(sequence.sequence, "routeMap.sequence");
        if (seen.has(sequence.sequence)) throw new ControlProtocolConfigurationError(`Duplicate route-map sequence ${sequence.sequence}`, "routeMap.sequence");
        seen.add(sequence.sequence);
        validateUnsigned(sequence.set?.localPreference, "routeMap.localPreference");
        validateUnsigned(sequence.set?.med, "routeMap.med");
        validateUnsigned(sequence.set?.weight, "routeMap.weight");
        const prepend = sequence.set?.prependLocalAs;
        if (prepend !== undefined && (!Number.isInteger(prepend) || prepend < 1 || prepend > 10)) {
          throw new ControlProtocolConfigurationError("AS prepend count must be between 1 and 10", "routeMap.prependLocalAs");
        }
        const maxPath = sequence.match?.maximumAsPathLength;
        if (maxPath !== undefined && (!Number.isInteger(maxPath) || maxPath < 0 || maxPath > 256)) {
          throw new ControlProtocolConfigurationError("AS path length match must be between 0 and 256", "routeMap.maximumAsPathLength");
        }
      }
      next.set(map.id, { id: map.id, sequences });
    }
    this.routeMaps.clear();
    for (const [id, map] of next) this.routeMaps.set(id, map);
    this.onChanged();
  }

  evaluate(route: BgpRoute, binding: RoutePolicyBinding, localAs: number): RoutePolicyDecision {
    let current = route;
    let matchedPrefixListSequence: number | undefined;
    if (binding.prefixListId !== undefined) {
      const result = this.evaluatePrefixList(binding.prefixListId, current);
      matchedPrefixListSequence = result.sequence;
      if (result.action === "deny") {
        return { action: "deny", route: current, matchedPrefixListSequence, reason: result.reason };
      }
    }
    if (binding.routeMapId === undefined) {
      return { action: "permit", route: current, matchedPrefixListSequence, reason: "permitted" };
    }
    const map = this.routeMaps.get(binding.routeMapId);
    if (!map) return { action: "deny", route: current, matchedPrefixListSequence, reason: `route-map ${binding.routeMapId} is undefined` };
    for (const sequence of map.sequences) {
      if (!this.routeMapMatches(sequence.match, current)) continue;
      this.count("route-map", map.id, sequence.sequence, sequence.action);
      if (sequence.action === "deny") {
        return {
          action: "deny",
          route: current,
          matchedPrefixListSequence,
          matchedRouteMapSequence: sequence.sequence,
          reason: `route-map ${map.id} sequence ${sequence.sequence} denied the route`,
        };
      }
      current = this.applySet(current, sequence.set, localAs);
      return {
        action: "permit",
        route: current,
        matchedPrefixListSequence,
        matchedRouteMapSequence: sequence.sequence,
        reason: `route-map ${map.id} sequence ${sequence.sequence} permitted the route`,
      };
    }
    return { action: "deny", route: current, matchedPrefixListSequence, reason: `route-map ${map.id} implicit deny` };
  }

  prefixListConfigurations(): PrefixList[] {
    return [...this.prefixLists.values()].map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry })) }));
  }

  routeMapConfigurations(): RouteMap[] {
    return [...this.routeMaps.values()].map((map) => ({
      ...map,
      sequences: map.sequences.map((sequence) => ({
        ...sequence,
        match: sequence.match ? { ...sequence.match, prefixListIds: sequence.match.prefixListIds ? [...sequence.match.prefixListIds] : undefined } : undefined,
        set: sequence.set ? { ...sequence.set } : undefined,
      })),
    }));
  }

  counterSummaries(): RoutePolicyCounter[] {
    return [...this.counters.values()].map((counter) => ({ ...counter }))
      .sort((a, b) => a.policyType.localeCompare(b.policyType) || a.policyId.localeCompare(b.policyId) || a.sequence - b.sequence);
  }

  resetCounters(): void {
    this.counters.clear();
  }

  private evaluatePrefixList(id: string, route: BgpRoute): { action: RoutePolicyAction; sequence?: number; reason: string } {
    const list = this.prefixLists.get(id);
    if (!list) return { action: "deny", reason: `prefix-list ${id} is undefined` };
    for (const entry of list.entries) {
      if (!prefixMatches(route, entry)) continue;
      this.count("prefix-list", id, entry.sequence, entry.action);
      return { action: entry.action, sequence: entry.sequence, reason: `prefix-list ${id} sequence ${entry.sequence} ${entry.action}` };
    }
    return { action: "deny", reason: `prefix-list ${id} implicit deny` };
  }

  private routeMapMatches(match: RouteMatch | undefined, route: BgpRoute): boolean {
    if (!match) return true;
    if (match.neighbor !== undefined && route.neighborAddress !== match.neighbor) return false;
    if (match.maximumAsPathLength !== undefined && route.asPath.length > match.maximumAsPathLength) return false;
    if (match.source !== undefined && route.source !== match.source) return false;
    if (match.prefixListIds?.length) {
      return match.prefixListIds.some((id) => this.evaluatePrefixList(id, route).action === "permit");
    }
    return true;
  }

  private applySet(route: BgpRoute, set: RouteSetAction | undefined, localAs: number): BgpRoute {
    if (!set) return route;
    return {
      ...route,
      localPreference: set.localPreference ?? route.localPreference,
      med: set.med ?? route.med,
      weight: set.weight ?? route.weight,
      origin: set.origin ?? route.origin,
      asPath: set.prependLocalAs === undefined
        ? route.asPath
        : [...Array.from({ length: set.prependLocalAs }, () => localAs), ...route.asPath],
    };
  }

  private count(type: RoutePolicyCounter["policyType"], id: string, sequence: number, action: RoutePolicyAction): void {
    const key = `${type}\u0000${id}\u0000${sequence}`;
    const counter = this.counters.get(key) ?? { policyType: type, policyId: id, sequence, matches: 0, permits: 0, denies: 0 };
    counter.matches++;
    if (action === "permit") counter.permits++;
    else counter.denies++;
    this.counters.set(key, counter);
  }
}
