import type { BgpRoute, BgpRouteSource } from "../protocols/bgp";
import type { BgpUnicastAddressFamily } from "../packets/bgp";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt, maskToInt } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import { ipv6InPrefix, ipv6Network, normalizeIpv6, validateIpv6PrefixLength } from "../util/ipv6";
import {
  ControlProtocolConfigurationError,
  DEFAULT_CONTROL_PROTOCOL_LIMITS,
  enforceStructuralLimit,
} from "../protocols/limits";
import { normalizeBgpCommunities } from "./bgp-community";
import {
  matchesAsPath,
  validateAsPathMatcher,
  validateAsPathPrepend,
  type AsPathMatcher,
} from "./bgp-as-path";

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

/**
 * `ipv6 prefix-list <name> seq <n> permit|deny <prefix>/<len> [ge] [le]`.
 * IPv6 has no wildcard-mask form, so the entry is deliberately prefix-only.
 */
export interface Ipv6PrefixListEntry {
  readonly sequence: number;
  readonly action: RoutePolicyAction;
  readonly prefix: Ipv6;
  readonly prefixLength: number;
  readonly ge?: number;
  readonly le?: number;
}

export interface Ipv6PrefixList {
  readonly id: string;
  readonly entries: readonly Ipv6PrefixListEntry[];
}

export interface CommunityListEntry {
  readonly sequence: number;
  readonly action: RoutePolicyAction;
  /** Every community listed here must be present for the entry to match. */
  readonly communities: readonly string[];
}

export interface CommunityList {
  readonly id: string;
  readonly entries: readonly CommunityListEntry[];
}

export interface AsPathListEntry {
  readonly sequence: number;
  readonly action: RoutePolicyAction;
  readonly matcher: AsPathMatcher;
}

export interface AsPathList {
  readonly id: string;
  readonly entries: readonly AsPathListEntry[];
}

export interface RouteMatch {
  /** `match ip address prefix-list`; only ever matches an IPv4 unicast route. */
  readonly prefixListIds?: readonly string[];
  /** `match ipv6 address prefix-list`; only ever matches an IPv6 unicast route. */
  readonly ipv6PrefixListIds?: readonly string[];
  readonly neighbor?: Ipv4;
  readonly maximumAsPathLength?: number;
  readonly source?: BgpRouteSource;
  /** `match community <list>...`; OR across lists unless `communityMatchAll`. */
  readonly communityListIds?: readonly string[];
  readonly communityMatchAll?: boolean;
  /** `match as-path <list>...`; OR across lists. */
  readonly asPathListIds?: readonly string[];
}

export interface RouteSetAction {
  readonly localPreference?: number;
  readonly med?: number;
  readonly weight?: number;
  /** `set as-path prepend <local-as> * n` kept for documents written before M10.12. */
  readonly prependLocalAs?: number;
  /** `set as-path prepend <asn>...`: an explicit, bounded AS list. */
  readonly prependAsns?: readonly number[];
  readonly origin?: BgpRoute["origin"];
  /** `set community <value>...`; replaces the set unless `communityAdditive`. */
  readonly communities?: readonly string[];
  readonly communityAdditive?: boolean;
  /** `set community none`: clears standard communities, never route targets. */
  readonly communityNone?: boolean;
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
  /**
   * Communities the matched sequence added and removed. The engine stays pure,
   * so the BGP process — which owns the engine clock — turns this into the
   * `bgp-community-added` / `bgp-community-removed` trace events.
   */
  readonly communitiesAdded?: readonly string[];
  readonly communitiesRemoved?: readonly string[];
  /** Community/AS-path list evaluations the BGP process turns into trace events. */
  readonly listEvaluations?: readonly RoutePolicyListEvaluation[];
}

export interface RoutePolicyListEvaluation {
  readonly policyType: "community-list" | "as-path-list";
  readonly policyId: string;
  readonly sequence?: number;
  readonly action: RoutePolicyAction;
}

export interface RoutePolicyCounter {
  readonly policyType: "prefix-list" | "route-map" | "community-list" | "as-path-list";
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

/** The same `ge`/`le` window rule, bounded by 128 instead of 32. */
function ipv6PrefixMatches(route: BgpRoute, entry: Ipv6PrefixListEntry): boolean {
  if (!ipv6InPrefix(route.network, entry.prefix, entry.prefixLength)) return false;
  const minimum = entry.ge ?? entry.prefixLength;
  const maximum = entry.le ?? (entry.ge === undefined ? entry.prefixLength : 128);
  return route.prefixLength >= minimum && route.prefixLength <= maximum;
}

/**
 * `set community` semantics. Without `additive` the standard community set is
 * replaced; with it the new values are merged, deduplicated and re-sorted into
 * the one canonical order. Route-target extended communities live in a
 * different attribute and are deliberately out of reach here.
 */
export function applyCommunitySet(
  current: readonly string[],
  set: Pick<RouteSetAction, "communities" | "communityAdditive" | "communityNone">,
): readonly string[] {
  if (set.communityNone) return [];
  if (!set.communities) return current;
  return normalizeBgpCommunities(set.communityAdditive ? [...current, ...set.communities] : set.communities);
}

/** Copy the named readonly arrays without ever adding an `undefined` key. */
function cloneArrayFields<T extends object>(value: T, fields: readonly (keyof T)[]): T {
  const clone = { ...value };
  for (const field of fields) {
    const entry = clone[field];
    if (Array.isArray(entry)) clone[field] = [...entry] as T[keyof T];
  }
  return clone;
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
  private readonly ipv6PrefixLists = new Map<string, Ipv6PrefixList>();
  private readonly routeMaps = new Map<string, RouteMap>();
  private readonly communityLists = new Map<string, CommunityList>();
  private readonly asPathLists = new Map<string, AsPathList>();
  private readonly counters = new Map<string, MutableCounter>();
  /** Collected during one `evaluate` call; drained into the decision. */
  private evaluations: RoutePolicyListEvaluation[] = [];

  constructor(private readonly onChanged: () => void = () => undefined) {}

  setCommunityLists(communityLists: readonly CommunityList[]): void {
    enforceStructuralLimit("maximumBgpCommunityListsPerDevice", communityLists.length);
    const next = new Map<string, CommunityList>();
    for (const list of communityLists) {
      if (!list.id.trim()) throw new ControlProtocolConfigurationError("Community-list name is required", "communityList.id");
      if (next.has(list.id)) throw new ControlProtocolConfigurationError(`Duplicate community-list ${list.id}`, "communityLists");
      enforceStructuralLimit("maximumBgpCommunityListEntriesPerList", list.entries.length);
      const seen = new Set<number>();
      const entries = [...list.entries]
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => {
          validateSequence(entry.sequence, "communityList.sequence");
          if (seen.has(entry.sequence)) {
            throw new ControlProtocolConfigurationError(`Duplicate community-list sequence ${entry.sequence}`, "communityList.sequence");
          }
          seen.add(entry.sequence);
          if (!entry.communities.length) {
            throw new ControlProtocolConfigurationError("A community-list entry needs at least one community", "communityList.communities");
          }
          return { ...entry, communities: normalizeBgpCommunities(entry.communities, "communityList.communities") };
        });
      next.set(list.id, { id: list.id, entries });
    }
    this.communityLists.clear();
    for (const [id, list] of next) this.communityLists.set(id, list);
    this.onChanged();
  }

  setAsPathLists(asPathLists: readonly AsPathList[]): void {
    enforceStructuralLimit("maximumBgpAsPathListsPerDevice", asPathLists.length);
    const next = new Map<string, AsPathList>();
    for (const list of asPathLists) {
      if (!list.id.trim()) throw new ControlProtocolConfigurationError("AS-path list name is required", "asPathList.id");
      if (next.has(list.id)) throw new ControlProtocolConfigurationError(`Duplicate AS-path list ${list.id}`, "asPathLists");
      enforceStructuralLimit("maximumBgpAsPathListEntriesPerList", list.entries.length);
      const seen = new Set<number>();
      const entries = [...list.entries].sort((a, b) => a.sequence - b.sequence);
      for (const entry of entries) {
        validateSequence(entry.sequence, "asPathList.sequence");
        if (seen.has(entry.sequence)) {
          throw new ControlProtocolConfigurationError(`Duplicate AS-path list sequence ${entry.sequence}`, "asPathList.sequence");
        }
        seen.add(entry.sequence);
        validateAsPathMatcher(entry.matcher);
      }
      next.set(list.id, { id: list.id, entries });
    }
    this.asPathLists.clear();
    for (const [id, list] of next) this.asPathLists.set(id, list);
    this.onChanged();
  }

  communityListConfigurations(): CommunityList[] {
    return [...this.communityLists.values()]
      .map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry, communities: [...entry.communities] })) }));
  }

  asPathListConfigurations(): AsPathList[] {
    return [...this.asPathLists.values()]
      .map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry, matcher: { ...entry.matcher } })) }));
  }

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

  setIpv6PrefixLists(prefixLists: readonly Ipv6PrefixList[]): void {
    const next = new Map<string, Ipv6PrefixList>();
    for (const list of prefixLists) {
      if (!list.id.trim()) throw new ControlProtocolConfigurationError("Prefix-list name is required", "ipv6PrefixList.id");
      if (next.has(list.id)) throw new ControlProtocolConfigurationError(`Duplicate prefix-list ${list.id}`, "ipv6PrefixLists");
      const seen = new Set<number>();
      const entries = [...list.entries]
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => {
          validateSequence(entry.sequence, "ipv6PrefixList.sequence");
          if (seen.has(entry.sequence)) {
            throw new ControlProtocolConfigurationError(`Duplicate prefix-list sequence ${entry.sequence}`, "ipv6PrefixList.sequence");
          }
          seen.add(entry.sequence);
          validateIpv6PrefixLength(entry.prefixLength);
          const prefix = normalizeIpv6(entry.prefix);
          if (ipv6Network(prefix, entry.prefixLength) !== prefix) {
            throw new ControlProtocolConfigurationError("Prefix-list entry must use a canonical network address", "ipv6PrefixList.prefix");
          }
          if (entry.ge !== undefined && (!Number.isInteger(entry.ge) || entry.ge < entry.prefixLength || entry.ge > 128)) {
            throw new ControlProtocolConfigurationError("Prefix-list ge must be between the prefix length and 128", "ipv6PrefixList.ge");
          }
          if (entry.le !== undefined && (!Number.isInteger(entry.le) || entry.le < (entry.ge ?? entry.prefixLength) || entry.le > 128)) {
            throw new ControlProtocolConfigurationError("Prefix-list le must be between ge/prefix length and 128", "ipv6PrefixList.le");
          }
          return { ...entry, prefix };
        });
      next.set(list.id, { id: list.id, entries });
    }
    this.ipv6PrefixLists.clear();
    for (const [id, list] of next) this.ipv6PrefixLists.set(id, list);
    this.onChanged();
  }

  ipv6PrefixListConfigurations(): Ipv6PrefixList[] {
    return [...this.ipv6PrefixLists.values()].map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry })) }));
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
        if (sequence.set?.prependAsns !== undefined) {
          validateAsPathPrepend(sequence.set.prependAsns, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumBgpAsPathPrependLength);
        }
        if (sequence.set?.communities !== undefined) normalizeBgpCommunities(sequence.set.communities, "routeMap.communities");
        if (sequence.set?.communityNone && sequence.set.communities?.length) {
          throw new ControlProtocolConfigurationError("'set community none' cannot be combined with community values", "routeMap.communityNone");
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
    this.evaluations = [];
    let current = route;
    let matchedPrefixListSequence: number | undefined;
    if (binding.prefixListId !== undefined) {
      // A neighbor binding is already per address family, so the list is looked
      // up in the store that matches the route being evaluated.
      const result = this.evaluatePrefixList(binding.prefixListId, current, current.addressFamily);
      matchedPrefixListSequence = result.sequence;
      if (result.action === "deny") {
        return { action: "deny", route: current, matchedPrefixListSequence, reason: result.reason };
      }
    }
    if (binding.routeMapId === undefined) {
      return { action: "permit", route: current, matchedPrefixListSequence, reason: "permitted", listEvaluations: this.evaluations };
    }
    const map = this.routeMaps.get(binding.routeMapId);
    if (!map) {
      return {
        action: "deny",
        route: current,
        matchedPrefixListSequence,
        reason: `route-map ${binding.routeMapId} is undefined`,
        listEvaluations: this.evaluations,
      };
    }
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
          listEvaluations: this.evaluations,
        };
      }
      const before = current.communities;
      current = this.applySet(current, sequence.set, localAs);
      return {
        action: "permit",
        route: current,
        matchedPrefixListSequence,
        matchedRouteMapSequence: sequence.sequence,
        reason: `route-map ${map.id} sequence ${sequence.sequence} permitted the route`,
        communitiesAdded: current.communities.filter((value) => !before.includes(value)),
        communitiesRemoved: before.filter((value) => !current.communities.includes(value)),
        listEvaluations: this.evaluations,
      };
    }
    return {
      action: "deny",
      route: current,
      matchedPrefixListSequence,
      reason: `route-map ${map.id} implicit deny`,
      listEvaluations: this.evaluations,
    };
  }

  prefixListConfigurations(): PrefixList[] {
    return [...this.prefixLists.values()].map((list) => ({ ...list, entries: list.entries.map((entry) => ({ ...entry })) }));
  }

  routeMapConfigurations(): RouteMap[] {
    return [...this.routeMaps.values()].map((map) => ({
      ...map,
      // Never introduce a key with an `undefined` value: a canonical
      // LabDocument is validated with strict schemas that count it as set.
      sequences: map.sequences.map((sequence) => ({
        ...sequence,
        match: sequence.match
          ? cloneArrayFields(sequence.match, ["prefixListIds", "ipv6PrefixListIds", "communityListIds", "asPathListIds"])
          : undefined,
        set: sequence.set ? cloneArrayFields(sequence.set, ["communities", "prependAsns"]) : undefined,
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

  /**
   * First match wins, then implicit deny. `listFamily` is the family the clause
   * names — `match ip address` versus `match ipv6 address` — so an IPv4 list can
   * never accidentally decide an IPv6 route.
   */
  private evaluatePrefixList(
    id: string,
    route: BgpRoute,
    listFamily: BgpUnicastAddressFamily,
  ): { action: RoutePolicyAction; sequence?: number; reason: string } {
    if (listFamily !== route.addressFamily) {
      return { action: "deny", reason: `prefix-list ${id} belongs to another address family` };
    }
    if (listFamily === "ipv6-unicast") {
      const list = this.ipv6PrefixLists.get(id);
      if (!list) return { action: "deny", reason: `prefix-list ${id} is undefined` };
      for (const entry of list.entries) {
        if (!ipv6PrefixMatches(route, entry)) continue;
        this.count("prefix-list", id, entry.sequence, entry.action);
        return { action: entry.action, sequence: entry.sequence, reason: `prefix-list ${id} sequence ${entry.sequence} ${entry.action}` };
      }
      return { action: "deny", reason: `prefix-list ${id} implicit deny` };
    }
    const list = this.prefixLists.get(id);
    if (!list) return { action: "deny", reason: `prefix-list ${id} is undefined` };
    for (const entry of list.entries) {
      if (!prefixMatches(route, entry)) continue;
      this.count("prefix-list", id, entry.sequence, entry.action);
      return { action: entry.action, sequence: entry.sequence, reason: `prefix-list ${id} sequence ${entry.sequence} ${entry.action}` };
    }
    return { action: "deny", reason: `prefix-list ${id} implicit deny` };
  }

  /** First match wins, then implicit deny — exactly like a prefix list. */
  private evaluateCommunityList(id: string, route: BgpRoute): { action: RoutePolicyAction; sequence?: number } {
    const list = this.communityLists.get(id);
    if (!list) {
      this.evaluations.push({ policyType: "community-list", policyId: id, action: "deny" });
      return { action: "deny" };
    }
    for (const entry of list.entries) {
      if (!entry.communities.every((community) => route.communities.includes(community))) continue;
      this.count("community-list", id, entry.sequence, entry.action);
      this.evaluations.push({ policyType: "community-list", policyId: id, sequence: entry.sequence, action: entry.action });
      return { action: entry.action, sequence: entry.sequence };
    }
    this.evaluations.push({ policyType: "community-list", policyId: id, action: "deny" });
    return { action: "deny" };
  }

  private evaluateAsPathList(id: string, route: BgpRoute): { action: RoutePolicyAction; sequence?: number } {
    const list = this.asPathLists.get(id);
    if (!list) {
      this.evaluations.push({ policyType: "as-path-list", policyId: id, action: "deny" });
      return { action: "deny" };
    }
    for (const entry of list.entries) {
      if (!matchesAsPath(route.asPath, entry.matcher)) continue;
      this.count("as-path-list", id, entry.sequence, entry.action);
      this.evaluations.push({ policyType: "as-path-list", policyId: id, sequence: entry.sequence, action: entry.action });
      return { action: entry.action, sequence: entry.sequence };
    }
    this.evaluations.push({ policyType: "as-path-list", policyId: id, action: "deny" });
    return { action: "deny" };
  }

  /**
   * Documented combination rule: several lists of the *same* category are OR-ed
   * (any permitting list matches), while different categories are AND-ed. A
   * `match community` clause may opt into AND with `communityMatchAll`.
   */
  private routeMapMatches(match: RouteMatch | undefined, route: BgpRoute): boolean {
    if (!match) return true;
    if (match.neighbor !== undefined && route.neighborAddress !== match.neighbor) return false;
    if (match.maximumAsPathLength !== undefined && route.asPath.length > match.maximumAsPathLength) return false;
    if (match.source !== undefined && route.source !== match.source) return false;
    if (match.prefixListIds?.length
      && !match.prefixListIds.some((id) => this.evaluatePrefixList(id, route, "ipv4-unicast").action === "permit")) return false;
    if (match.ipv6PrefixListIds?.length
      && !match.ipv6PrefixListIds.some((id) => this.evaluatePrefixList(id, route, "ipv6-unicast").action === "permit")) return false;
    if (match.communityListIds?.length) {
      const results = match.communityListIds.map((id) => this.evaluateCommunityList(id, route).action === "permit");
      if (match.communityMatchAll ? results.some((permitted) => !permitted) : !results.some(Boolean)) return false;
    }
    if (match.asPathListIds?.length
      && !match.asPathListIds.map((id) => this.evaluateAsPathList(id, route).action === "permit").some(Boolean)) return false;
    return true;
  }

  private applySet(route: BgpRoute, set: RouteSetAction | undefined, localAs: number): BgpRoute {
    if (!set) return route;
    // An explicit prepend list wins over the legacy local-AS repeat count so a
    // migrated document keeps working while new configuration stays exact.
    const prepend = set.prependAsns
      ?? (set.prependLocalAs === undefined ? undefined : Array.from({ length: set.prependLocalAs }, () => localAs));
    return {
      ...route,
      communities: applyCommunitySet(route.communities, set),
      localPreference: set.localPreference ?? route.localPreference,
      med: set.med ?? route.med,
      weight: set.weight ?? route.weight,
      origin: set.origin ?? route.origin,
      asPath: prepend === undefined ? route.asPath : [...prepend, ...route.asPath],
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
