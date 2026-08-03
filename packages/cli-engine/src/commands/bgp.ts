import {
  type AsPathList,
  type BgpConfiguration,
  type BgpNeighborConfiguration,
  type CommunityList,
  type Layer3Switch,
  type PrefixList,
  type RouteMap,
  type RouteMapSequence,
  type Router,
  ControlProtocolConfigurationError,
  formatAsPathMatcher,
  ipToInt,
  maskToInt,
  parseAsPathPattern,
  parseBgpCommunity,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import { table } from "../formatter/tables";
import type { CommandSpec, SessionApi } from "../types";
import { isOspfDevice, isRouter, parseIpv4 } from "./helpers";

function deviceOf(session: SessionApi): Router | Layer3Switch {
  if (!isOspfDevice(session.device)) throw new InvalidModeError("BGP requires a Router or an L3 Switch");
  return session.device;
}

function bgpOf(session: SessionApi): { device: Router | Layer3Switch; configuration: BgpConfiguration } {
  const device = deviceOf(session);
  const configuration = device.bgp.configurationSnapshot();
  if (!configuration || session.routerCtx?.family !== "bgp") throw new InvalidModeError("Enter 'router bgp <asn>' first");
  return { device, configuration };
}

function updateBgp(session: SessionApi, mutate: (configuration: BgpConfiguration) => BgpConfiguration): void {
  const { device, configuration } = bgpOf(session);
  device.bgp.configure(mutate(configuration));
}

function updateNeighbor(
  session: SessionApi,
  address: string,
  mutate: (neighbor: BgpNeighborConfiguration | undefined) => BgpNeighborConfiguration,
): void {
  updateBgp(session, (configuration) => {
    const parsed = parseIpv4(address);
    const existing = configuration.neighbors?.find((neighbor) => neighbor.address === parsed);
    const next = mutate(existing);
    return {
      ...configuration,
      neighbors: [...(configuration.neighbors ?? []).filter((neighbor) => neighbor.address !== parsed), next],
    };
  });
}

function prefixLength(mask: string): number {
  const value = maskToInt(parseIpv4(mask));
  let seenZero = false;
  let count = 0;
  for (let bit = 31; bit >= 0; bit--) {
    const one = ((value >>> bit) & 1) === 1;
    if (!one) seenZero = true;
    else if (seenZero) throw new ValidationError("Network mask must contain contiguous bits.");
    else count++;
  }
  return count;
}

function parsePrefix(value: string): { prefix: string; prefixLength: number } {
  const [address, length, extra] = value.split("/");
  const prefix = parseIpv4(address ?? "");
  const parsedLength = Number(length);
  if (extra !== undefined || !Number.isInteger(parsedLength) || parsedLength < 0 || parsedLength > 32) {
    throw new ValidationError("Prefix must use IPv4 CIDR notation, for example 10.0.0.0/8.");
  }
  const mask = maskToInt(parsedLength);
  if (((ipToInt(prefix) & mask) >>> 0) !== ipToInt(prefix)) throw new ValidationError("Prefix must use a network address.");
  return { prefix, prefixLength: parsedLength };
}

function updateRouteMap(session: SessionApi, mutate: (sequence: RouteMapSequence) => RouteMapSequence): void {
  const device = deviceOf(session);
  const context = session.routeMapCtx;
  if (!context) throw new InvalidModeError("No route-map sequence selected");
  const maps = device.bgp.routingPolicy.routeMapConfigurations();
  const existingMap = maps.find((map) => map.id === context.id);
  const existingSequence = existingMap?.sequences.find((sequence) => sequence.sequence === context.sequence)
    ?? { sequence: context.sequence, action: context.action };
  const updated: RouteMap = {
    id: context.id,
    sequences: [
      ...(existingMap?.sequences.filter((sequence) => sequence.sequence !== context.sequence) ?? []),
      mutate(existingSequence),
    ],
  };
  device.bgp.routingPolicy.setRouteMaps([...maps.filter((map) => map.id !== context.id), updated]);
}

function setPrefixListEntry(session: SessionApi, parameters: Readonly<Record<string, string | undefined>>): void {
  const action = parameters.action === "permit" || parameters.action === "deny" ? parameters.action : undefined;
  const sequence = Number(parameters.sequence);
  if (!action) throw new ValidationError("Prefix-list action must be permit or deny.");
  if (!Number.isInteger(sequence) || sequence < 1) throw new ValidationError("Prefix-list sequence must be positive.");
  const parsed = parsePrefix(parameters.prefix!);
  const ge = parameters.ge === undefined ? undefined : Number(parameters.ge);
  const le = parameters.le === undefined ? undefined : Number(parameters.le);
  const device = deviceOf(session);
  const lists = device.bgp.routingPolicy.prefixListConfigurations();
  const current = lists.find((list) => list.id === parameters.name);
  const updated: PrefixList = {
    id: parameters.name!,
    entries: [...(current?.entries.filter((entry) => entry.sequence !== sequence) ?? []), { sequence, action, ...parsed, ge, le }],
  };
  device.bgp.routingPolicy.setPrefixLists([...lists.filter((list) => list.id !== parameters.name), updated]);
}

/** Turn CLI text into the canonical community form, or fail with its rule. */
function parseCommunities(values: readonly string[]): string[] {
  return values.map((value) => {
    try {
      return parseBgpCommunity(value);
    } catch (error) {
      throw new ValidationError(error instanceof ControlProtocolConfigurationError ? error.message : `Invalid community '${value}'.`);
    }
  });
}

function requireNeighbor(neighbor: BgpNeighborConfiguration | undefined): BgpNeighborConfiguration {
  if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
  return neighbor;
}

function updateCommunityList(session: SessionApi, name: string, mutate: (list: CommunityList) => CommunityList): void {
  const device = deviceOf(session);
  const lists = device.bgp.routingPolicy.communityListConfigurations();
  const current = lists.find((list) => list.id === name) ?? { id: name, entries: [] };
  device.bgp.routingPolicy.setCommunityLists([...lists.filter((list) => list.id !== name), mutate(current)]);
}

function updateAsPathList(session: SessionApi, name: string, mutate: (list: AsPathList) => AsPathList): void {
  const device = deviceOf(session);
  const lists = device.bgp.routingPolicy.asPathListConfigurations();
  const current = lists.find((list) => list.id === name) ?? { id: name, entries: [] };
  device.bgp.routingPolicy.setAsPathLists([...lists.filter((list) => list.id !== name), mutate(current)]);
}

/** The next free sequence number, so repeated CLI lines append in order. */
function nextSequence(entries: readonly { sequence: number }[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) + 10;
}

function parseAction(value: string | undefined): "permit" | "deny" {
  if (value !== "permit" && value !== "deny") throw new ValidationError("Action must be permit or deny.");
  return value;
}

function routeText(route: { asPath: readonly number[]; origin: string; communities: readonly string[] }): string {
  const origin = route.origin === "igp" ? "i" : route.origin === "egp" ? "e" : "?";
  return `${route.asPath.join(" ")} ${origin}`.trim();
}

function showNeighborRib(session: SessionApi, neighbor: string, direction: "in" | "out"): string {
  const device = deviceOf(session);
  const address = parseIpv4(neighbor);
  if (!device.bgp.summaries().some((peer) => peer.address === address)) return `% BGP neighbor ${address} is not configured.`;
  const rows = direction === "out" ? device.bgp.adjRibOutEntries(address) : device.bgp.adjRibInEntries(address);
  if (!rows.length) return `% No ${direction === "out" ? "advertised" : "received"} routes for ${address}.`;
  return table(["Network", "Next Hop", "LocPrf", "Communities", "Originator", "Cluster list", "Path"], rows.map((route) => [
    `${route.network}/${route.prefixLength}`,
    route.nextHop,
    String(route.localPreference),
    route.communities.join(" ") || "—",
    route.originatorId ?? "—",
    route.clusterList.join(" ") || "—",
    routeText(route),
  ]));
}

function setAggregate(
  session: SessionApi,
  parameters: Readonly<Record<string, string | undefined>>,
  summaryOnly: boolean,
  asSet: boolean,
): void {
  const { device, configuration } = bgpOf(session);
  const prefix = parseIpv4(parameters.network!);
  const length = prefixLength(parameters.mask!);
  if (((ipToInt(prefix) & maskToInt(length)) >>> 0) !== ipToInt(prefix)) {
    throw new ValidationError("An aggregate must use a network address.");
  }
  device.bgp.configure({
    ...configuration,
    aggregates: [
      ...(configuration.aggregates ?? []).filter((entry) => entry.prefix !== prefix || entry.prefixLength !== length),
      { prefix, prefixLength: length, summaryOnly: summaryOnly || undefined, asSet: asSet || undefined },
    ],
  });
}

function showBgp(session: SessionApi): string {
  const device = deviceOf(session);
  const configuration = device.bgp.configurationSnapshot();
  if (!configuration) return "% BGP is not running.";
  const rows = device.bgp.routes();
  if (!rows.length) return `BGP table version 0, local router ID ${configuration.routerId ?? "unassigned"}`;
  return [
    `BGP table, local router ID ${configuration.routerId ?? "unassigned"}, local AS ${configuration.localAs}`,
    table(["Status", "Network", "Next Hop", "Weight", "LocPrf", "Communities", "Path"], rows.map((route) => [
      `${route.valid ? "*" : " "}${route.best ? ">" : " "}`,
      `${route.network}/${route.prefixLength}`,
      route.nextHop,
      String(route.weight),
      String(route.localPreference),
      route.communities.join(" ") || "—",
      routeText(route),
    ])),
  ].join("\n");
}

export const bgpCommands: CommandSpec[] = [
  {
    pattern: "address-family vpnv4", modes: ["config-router"], device: "router",
    run: (s) => {
      bgpOf(s);
      s.routerCtx!.addressFamily = "vpnv4-unicast";
      s.routerCtx!.vrfId = undefined;
    },
  },
  {
    pattern: "address-family ipv4 vrf {name}", modes: ["config-router"], device: "router",
    run: (s, p) => {
      bgpOf(s);
      if (!isRouter(s.device) || !s.device.vrfConfigurations().some((vrf) => vrf.id === p.name || vrf.name === p.name)) {
        throw new ValidationError(`VRF '${p.name}' is not defined.`);
      }
      const vrf = s.device.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name)!;
      s.routerCtx!.addressFamily = "ipv4-vrf";
      s.routerCtx!.vrfId = vrf.id;
    },
  },
  {
    pattern: "neighbor {address} activate", modes: ["config-router"], device: "router",
    run: (s, p) => {
      if (s.routerCtx?.addressFamily !== "vpnv4-unicast") throw new InvalidModeError("Enter 'address-family vpnv4' first");
      updateNeighbor(s, p.address!, (neighbor) => {
        if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
        return { ...neighbor, vpnv4Activated: true };
      });
    },
  },
  {
    pattern: "neighbor {address} send-community extended", modes: ["config-router"], device: "router",
    run: (s, p) => {
      if (s.routerCtx?.addressFamily !== "vpnv4-unicast") throw new InvalidModeError("Enter 'address-family vpnv4' first");
      updateNeighbor(s, p.address!, (neighbor) => {
        if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
        return { ...neighbor, sendCommunityExtended: true };
      });
    },
  },
  {
    pattern: "redistribute {source}", modes: ["config-router"], device: "router",
    run: (s, p) => {
      if (s.routerCtx?.addressFamily !== "ipv4-vrf" || !s.routerCtx.vrfId) throw new InvalidModeError("Enter 'address-family ipv4 vrf <name>' first");
      if (p.source !== "connected" && p.source !== "static") throw new ValidationError("Only connected and static VRF routes can be redistributed.");
      updateBgp(s, (configuration) => {
        const current = configuration.vrfAddressFamilies?.find((family) => family.vrfId === s.routerCtx!.vrfId);
        return {
          ...configuration,
          vrfAddressFamilies: [
            ...(configuration.vrfAddressFamilies ?? []).filter((family) => family.vrfId !== s.routerCtx!.vrfId),
            {
              vrfId: s.routerCtx!.vrfId!,
              redistributeConnected: p.source === "connected" ? true : current?.redistributeConnected,
              redistributeStatic: p.source === "static" ? true : current?.redistributeStatic,
            },
          ],
        };
      });
    },
  },
  {
    pattern: "bgp router-id {id}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateBgp(s, (configuration) => ({ ...configuration, routerId: parseIpv4(p.id!) })),
  },
  {
    pattern: "bgp cluster-id {id}", usage: "bgp cluster-id <A.B.C.D>",
    modes: ["config-router"], device: "ospf",
    run: (s, p) => updateBgp(s, (configuration) => ({ ...configuration, clusterId: parseIpv4(p.id!) })),
  },
  {
    pattern: "neighbor {address} route-reflector-client", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => ({ ...requireNeighbor(neighbor), routeReflectorClient: true })),
  },
  {
    pattern: "neighbor {address} send-community", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => ({ ...requireNeighbor(neighbor), sendCommunityStandard: true })),
  },
  {
    pattern: "neighbor {address} send-community both", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => ({
      ...requireNeighbor(neighbor), sendCommunityStandard: true, sendCommunityExtended: true,
    })),
  },
  {
    pattern: "neighbor {address} default-originate", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => ({ ...requireNeighbor(neighbor), defaultOriginate: true })),
  },
  {
    pattern: "neighbor {address} default-originate route-map {name}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => ({
      ...requireNeighbor(neighbor), defaultOriginate: true, defaultOriginateRouteMap: p.name,
    })),
  },
  {
    pattern: "aggregate-address {network} {mask}", usage: "aggregate-address <network> <mask> [summary-only [as-set]]",
    modes: ["config-router"], device: "ospf",
    run: (s, p) => setAggregate(s, p, false, false),
  },
  {
    pattern: "aggregate-address {network} {mask} summary-only", modes: ["config-router"], device: "ospf",
    run: (s, p) => setAggregate(s, p, true, false),
  },
  {
    pattern: "aggregate-address {network} {mask} summary-only as-set", modes: ["config-router"], device: "ospf",
    run: (s, p) => setAggregate(s, p, true, true),
  },
  {
    pattern: "aggregate-address {network} {mask} as-set", modes: ["config-router"], device: "ospf",
    run: (s, p) => setAggregate(s, p, false, true),
  },
  {
    pattern: "no aggregate-address {network} {mask}", modes: ["config-router"], device: "ospf",
    run: (s, p) => {
      const { device, configuration } = bgpOf(s);
      const network = parseIpv4(p.network!);
      const length = prefixLength(p.mask!);
      device.bgp.configure({
        ...configuration,
        aggregates: (configuration.aggregates ?? [])
          .filter((entry) => entry.prefix !== network || entry.prefixLength !== length),
      });
    },
  },
  {
    pattern: "ip community-list standard {name} {action} {communities...}",
    usage: "ip community-list standard <name> permit|deny <ASN:value|internet|no-export|no-advertise>...",
    modes: ["config"], device: "ospf",
    run: (s, p) => {
      const action = parseAction(p.action);
      const communities = parseCommunities(p.communities!.split(" ").filter(Boolean));
      updateCommunityList(s, p.name!, (list) => ({
        ...list,
        entries: [...list.entries, { sequence: nextSequence(list.entries), action, communities }],
      }));
    },
  },
  {
    pattern: "ip as-path access-list {name} {action} {pattern}",
    usage: "ip as-path access-list <name> permit|deny <^$|_<asn>_|^<asn>_|_<asn>$|^<asn> <asn>$>",
    modes: ["config"], device: "ospf",
    run: (s, p) => {
      const action = parseAction(p.action);
      let matcher;
      try {
        matcher = parseAsPathPattern(p.pattern!);
      } catch (error) {
        throw new ValidationError(error instanceof ControlProtocolConfigurationError ? error.message : "Unsupported AS-path pattern.");
      }
      updateAsPathList(s, p.name!, (list) => ({
        ...list,
        entries: [...list.entries, { sequence: nextSequence(list.entries), action, matcher }],
      }));
    },
  },
  {
    pattern: "neighbor {address} remote-as {asn}", usage: "neighbor <address> remote-as <1-4294967295>",
    modes: ["config-router"], device: "ospf",
    run: (s, p) => {
      const remoteAs = Number(p.asn);
      if (!Number.isInteger(remoteAs) || remoteAs < 1 || remoteAs > 4_294_967_295) throw new ValidationError("Remote AS must be between 1 and 4294967295.");
      updateNeighbor(s, p.address!, (neighbor) => ({ ...neighbor, address: parseIpv4(p.address!), remoteAs }));
    },
  },
  {
    pattern: "neighbor {address} description {description...}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      return { ...neighbor, description: p.description };
    }),
  },
  {
    pattern: "neighbor {address} update-source {interface}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      return { ...neighbor, updateSource: p.interface };
    }),
  },
  {
    pattern: "neighbor {address} ebgp-multihop {ttl}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      const ttl = Number(p.ttl);
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > 255) throw new ValidationError("eBGP multihop TTL must be between 1 and 255.");
      return { ...neighbor, ebgpMultihop: ttl };
    }),
  },
  {
    pattern: "neighbor {address} next-hop-self", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      return { ...neighbor, nextHopSelf: true };
    }),
  },
  {
    pattern: "neighbor {address} prefix-list {name} {direction}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      if (p.direction === "in") return { ...neighbor, prefixListIn: p.name };
      if (p.direction === "out") return { ...neighbor, prefixListOut: p.name };
      throw new ValidationError("Direction must be in or out.");
    }),
  },
  {
    pattern: "neighbor {address} route-map {name} {direction}", modes: ["config-router"], device: "ospf",
    run: (s, p) => updateNeighbor(s, p.address!, (neighbor) => {
      if (!neighbor) throw new ValidationError("Configure neighbor remote-as first.");
      if (p.direction === "in") return { ...neighbor, routeMapIn: p.name };
      if (p.direction === "out") return { ...neighbor, routeMapOut: p.name };
      throw new ValidationError("Direction must be in or out.");
    }),
  },
  {
    pattern: "network {network} mask {mask}", modes: ["config-router"], device: "ospf",
    run: (s, p) => {
      const { device, configuration } = bgpOf(s);
      const length = prefixLength(p.mask!);
      const network = parseIpv4(p.network!);
      if (((ipToInt(network) & maskToInt(length)) >>> 0) !== ipToInt(network)) throw new ValidationError("BGP network statement must use a network address.");
      device.bgp.setNetworks([...(configuration.networks ?? []).filter((entry) => entry.network !== network || entry.prefixLength !== length), { network, prefixLength: length }]);
    },
  },
  {
    pattern: "ip prefix-list {name} seq {sequence} {action} {prefix} ge {ge} le {le}", modes: ["config"], device: "ospf",
    run: setPrefixListEntry,
  },
  {
    pattern: "ip prefix-list {name} seq {sequence} {action} {prefix} le {le}", modes: ["config"], device: "ospf",
    run: setPrefixListEntry,
  },
  {
    pattern: "ip prefix-list {name} seq {sequence} {action} {prefix}", modes: ["config"], device: "ospf",
    run: setPrefixListEntry,
  },
  {
    pattern: "match neighbor {address}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, match: { ...sequence.match, neighbor: parseIpv4(p.address!) } })),
  },
  {
    pattern: "match as-path length {length}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, match: { ...sequence.match, maximumAsPathLength: Number(p.length) } })),
  },
  {
    pattern: "match route-source {source}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => {
      if (p.source !== "local" && p.source !== "ebgp" && p.source !== "ibgp") throw new ValidationError("Route source must be local, ebgp or ibgp.");
      updateRouteMap(s, (sequence) => ({ ...sequence, match: { ...sequence.match, source: p.source as "local" | "ebgp" | "ibgp" } }));
    },
  },
  {
    pattern: "match ip address prefix-list {name}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, match: { ...sequence.match, prefixListIds: [p.name!] } })),
  },
  {
    pattern: "match route-type {type}", usage: "match route-type local|ebgp|ibgp",
    modes: ["config-route-map"], device: "ospf",
    run: (s, p) => {
      if (p.type !== "local" && p.type !== "ebgp" && p.type !== "ibgp") throw new ValidationError("Route type must be local, ebgp or ibgp.");
      updateRouteMap(s, (sequence) => ({ ...sequence, match: { ...sequence.match, source: p.type as "local" | "ebgp" | "ibgp" } }));
    },
  },
  {
    // Several lists on one clause are OR-ed; `all` switches that clause to AND.
    pattern: "match community {lists...}", usage: "match community [all] <community-list>...",
    modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({
      ...sequence,
      match: { ...sequence.match, communityListIds: p.lists!.split(" ").filter(Boolean), communityMatchAll: undefined },
    })),
  },
  {
    pattern: "match community all {lists...}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({
      ...sequence,
      match: { ...sequence.match, communityListIds: p.lists!.split(" ").filter(Boolean), communityMatchAll: true },
    })),
  },
  {
    pattern: "match as-path {lists...}", usage: "match as-path <as-path-list>...",
    modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({
      ...sequence,
      match: { ...sequence.match, asPathListIds: p.lists!.split(" ").filter(Boolean) },
    })),
  },
  {
    pattern: "set community {values...}", usage: "set community <ASN:value|well-known>... [additive] | none",
    modes: ["config-route-map"], device: "ospf",
    run: (s, p) => {
      const tokens = p.values!.split(" ").filter(Boolean);
      if (tokens.length === 1 && tokens[0]!.toLowerCase() === "none") {
        updateRouteMap(s, (sequence) => ({
          ...sequence,
          set: { ...sequence.set, communityNone: true, communities: undefined, communityAdditive: undefined },
        }));
        return;
      }
      const additive = tokens.at(-1)?.toLowerCase() === "additive";
      const communities = parseCommunities(additive ? tokens.slice(0, -1) : tokens);
      if (!communities.length) throw new ValidationError("Specify at least one community.");
      updateRouteMap(s, (sequence) => ({
        ...sequence,
        set: { ...sequence.set, communities, communityAdditive: additive || undefined, communityNone: undefined },
      }));
    },
  },
  {
    pattern: "set local-preference {value}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, localPreference: Number(p.value) } })),
  },
  {
    pattern: "set metric {value}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, med: Number(p.value) } })),
  },
  {
    pattern: "set weight {value}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, weight: Number(p.value) } })),
  },
  {
    // Cisco-exact form: an explicit AS list, never a repeat count. Documents
    // written before M10.12 keep their `prependLocalAs` count.
    pattern: "set as-path prepend {asns...}", usage: "set as-path prepend <asn> [<asn>...]",
    modes: ["config-route-map"], device: "ospf",
    run: (s, p) => {
      const prependAsns = p.asns!.split(" ").filter(Boolean).map(Number);
      if (prependAsns.some((asn) => !Number.isInteger(asn) || asn < 1 || asn > 4_294_967_295)) {
        throw new ValidationError("Each prepended AS number must be between 1 and 4294967295.");
      }
      if (prependAsns.length > 10) throw new ValidationError("AS-path prepend accepts at most 10 AS numbers.");
      updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, prependAsns, prependLocalAs: undefined } }));
    },
  },
  {
    pattern: "set origin {origin}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => {
      if (p.origin !== "igp" && p.origin !== "incomplete") throw new ValidationError("Origin must be igp or incomplete.");
      updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, origin: p.origin as "igp" | "incomplete" } }));
    },
  },
  { pattern: "show ip bgp", modes: ["exec", "privileged"], device: "ospf", run: showBgp },
  {
    pattern: "show ip bgp summary", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => {
      const device = deviceOf(s);
      const config = device.bgp.configurationSnapshot();
      if (!config) return "% BGP is not running.";
      const clients = new Set(device.bgp.routeReflectorClients());
      return [
        `BGP router identifier ${config.routerId ?? "unassigned"}, local AS number ${config.localAs}`,
        device.bgp.routeReflector ? `Route reflector cluster ID ${device.bgp.clusterIdentity}` : "",
        table(["Neighbor", "V", "AS", "State/PfxRcd", "MsgRcvd", "MsgSent", "RRClient"], device.bgp.summaries().map((peer) => [
          peer.address, "4", String(peer.remoteAs), peer.state === "established" ? String(device.bgp.adjRibInEntries(peer.address).length) : peer.state,
          String(peer.messagesReceived), String(peer.messagesSent), clients.has(peer.address) ? "yes" : "no",
        ])),
      ].filter(Boolean).join("\n");
    },
  },
  {
    pattern: "show ip community-list", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.routingPolicy.communityListConfigurations().flatMap((list) => [
      `Standard community-list ${list.id}`,
      ...list.entries.map((entry) => `    ${entry.action} ${entry.communities.join(" ")}`),
    ]).join("\n") || "% No community-lists configured.",
  },
  {
    pattern: "show ip as-path-access-list", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.routingPolicy.asPathListConfigurations().flatMap((list) => [
      `AS path access list ${list.id}`,
      ...list.entries.map((entry) => `    ${entry.action} ${formatAsPathMatcher(entry.matcher)}`),
    ]).join("\n") || "% No AS-path access lists configured.",
  },
  {
    pattern: "show ip bgp community {value}", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => {
      const community = parseCommunities([p.value!])[0]!;
      const rows = deviceOf(s).bgp.routes().filter((route) => route.communities.includes(community));
      if (!rows.length) return `% No BGP routes carry community ${community}.`;
      return table(["Status", "Network", "Next Hop", "Communities", "Path"], rows.map((route) => [
        `${route.valid ? "*" : " "}${route.best ? ">" : " "}`,
        `${route.network}/${route.prefixLength}`,
        route.nextHop,
        route.communities.join(" "),
        routeText(route),
      ]));
    },
  },
  {
    pattern: "show ip bgp suppressed-paths", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => {
      const rows = deviceOf(s).bgp.suppressedRoutes();
      if (!rows.length) return "% No BGP routes are suppressed.";
      return table(["Network", "Suppressed by"], rows.map((row) => [`${row.network}/${row.prefixLength}`, row.aggregate]));
    },
  },
  {
    pattern: "show ip bgp neighbors {neighbor} advertised-routes", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => showNeighborRib(s, p.neighbor!, "out"),
  },
  {
    pattern: "show ip bgp neighbors {neighbor} received-routes", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => showNeighborRib(s, p.neighbor!, "in"),
  },
  {
    pattern: "show ip bgp neighbors", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => {
      const device = deviceOf(s);
      const configuration = device.bgp.configurationSnapshot();
      const clients = new Set(device.bgp.routeReflectorClients());
      return device.bgp.summaries().map((peer) => {
        const neighbor = configuration?.neighbors?.find((entry) => entry.address === peer.address);
        return [
          `BGP neighbor is ${peer.address}, remote AS ${peer.remoteAs}`,
          `  BGP state = ${peer.state}`,
          `  Local address ${peer.localAddress ?? "unassigned"}, hold time ${peer.negotiatedHoldTimeSeconds ?? 0}`,
          clients.has(peer.address) ? `  Route-Reflector Client, cluster ID ${device.bgp.clusterIdentity}` : "",
          `  Community attribute sent: ${[
            neighbor?.sendCommunityStandard ? "standard" : "",
            neighbor?.sendCommunityExtended ? "extended" : "",
          ].filter(Boolean).join(" and ") || "none"}`,
          neighbor?.defaultOriginate
            ? `  Default information originate${neighbor.defaultOriginateRouteMap ? `, route-map ${neighbor.defaultOriginateRouteMap}` : ""}`
            : "",
          `  Messages: sent ${peer.messagesSent}, received ${peer.messagesReceived}`,
          peer.lastError ? `  Last error: ${peer.lastError}` : "",
        ].filter(Boolean).join("\n");
      }).join("\n\n") || "% No BGP neighbors configured.";
    },
  },
  {
    pattern: "show ip bgp neighbors {neighbor}", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => {
      const address = parseIpv4(p.neighbor!);
      const peer = deviceOf(s).bgp.summaries().find((entry) => entry.address === address);
      if (!peer) return `% BGP neighbor ${address} is not configured.`;
      return [`BGP neighbor is ${peer.address}, remote AS ${peer.remoteAs}`, `  BGP state = ${peer.state}`, `  Messages: sent ${peer.messagesSent}, received ${peer.messagesReceived}`, peer.lastError ? `  Last error: ${peer.lastError}` : ""].filter(Boolean).join("\n");
    },
  },
  {
    pattern: "show ip bgp {prefix}", modes: ["exec", "privileged"], device: "ospf",
    run: (s, p) => {
      const prefix = parsePrefix(p.prefix!);
      const routes = deviceOf(s).bgp.routes().filter((entry) => entry.network === prefix.prefix && entry.prefixLength === prefix.prefixLength);
      if (!routes.length) return `% Network ${p.prefix} not in BGP table.`;
      return routes.map((route) => [
        `${route.best ? ">" : " "} ${route.nextHop} ${route.localPreference} ${route.weight} ${route.asPath.join(" ")} ${route.origin}`,
        route.communities.length ? `    Community: ${route.communities.join(" ")}` : "",
        route.originatorId ? `    Originator: ${route.originatorId}` : "",
        route.clusterList.length ? `    Cluster list: ${route.clusterList.join(" ")}` : "",
      ].filter(Boolean).join("\n")).join("\n");
    },
  },
  {
    pattern: "show ip route bgp", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).routingTable().filter((route) => route.kind === "bgp").map((route) =>
      `B    ${route.network}/${prefixLengthFromInt(route.maskInt)} [${route.administrativeDistance}/${route.metric}] via ${route.viaIp}, ${route.egressName}`).join("\n") || "% No BGP routes installed.",
  },
  {
    pattern: "show ip bgp rib-failure", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.ribFailureSummaries().map((row) => `${row.routeId}: ${row.reason}`).join("\n") || "% No BGP RIB failures.",
  },
  {
    pattern: "show ip prefix-list", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.routingPolicy.prefixListConfigurations().flatMap((list) => [
      `ip prefix-list ${list.id}: ${list.entries.length} entries`,
      ...list.entries.map((entry) => ` seq ${entry.sequence} ${entry.action} ${entry.prefix}/${entry.prefixLength}${entry.ge === undefined ? "" : ` ge ${entry.ge}`}${entry.le === undefined ? "" : ` le ${entry.le}`}`),
    ]).join("\n") || "% No prefix-lists configured.",
  },
  {
    pattern: "show route-map", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.routingPolicy.routeMapConfigurations().flatMap((map) => map.sequences.map((sequence) =>
      `route-map ${map.id}, ${sequence.action}, sequence ${sequence.sequence}`)).join("\n") || "% No route-maps configured.",
  },
  {
    pattern: "clear ip bgp *", modes: ["privileged"], device: "ospf",
    run: (s) => s.requestConfirmation("Reset all BGP sessions? [yes/no]: ", () => {
      deviceOf(s).bgp.restart();
      return "% BGP sessions reset; configuration is unchanged.";
    }),
  },
  {
    // Soft reconfiguration re-runs policy against the stored Adj-RIB-In and the
    // outbound baseline. No TCP session is touched, so no confirmation is asked.
    pattern: "clear ip bgp * soft", modes: ["privileged"], device: "ospf",
    run: (s) => {
      deviceOf(s).bgp.softReset(undefined, "both");
      return "% BGP policy reevaluated for all neighbors; sessions are unchanged.";
    },
  },
  {
    pattern: "clear ip bgp {neighbor} soft", usage: "clear ip bgp <address> soft [in|out]",
    modes: ["privileged"], device: "ospf",
    run: (s, p) => {
      deviceOf(s).bgp.softReset(parseIpv4(p.neighbor!), "both");
      return `% BGP policy reevaluated for ${p.neighbor}; the session is unchanged.`;
    },
  },
  {
    pattern: "clear ip bgp {neighbor} soft {direction}", modes: ["privileged"], device: "ospf",
    run: (s, p) => {
      if (p.direction !== "in" && p.direction !== "out") throw new ValidationError("Soft reconfiguration direction must be in or out.");
      deviceOf(s).bgp.softReset(parseIpv4(p.neighbor!), p.direction);
      return `% BGP ${p.direction}bound policy reevaluated for ${p.neighbor}; the session is unchanged.`;
    },
  },
  {
    pattern: "clear ip bgp {neighbor}", modes: ["privileged"], device: "ospf",
    run: (s, p) => s.requestConfirmation(`Reset BGP neighbor ${p.neighbor}? [yes/no]: `, () => {
      deviceOf(s).bgp.restart(parseIpv4(p.neighbor!));
      return `% BGP neighbor ${p.neighbor} reset.`;
    }),
  },
];

function prefixLengthFromInt(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) { value &= value - 1; count++; }
  return count;
}
