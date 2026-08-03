import {
  type BgpConfiguration,
  type BgpNeighborConfiguration,
  type Layer3Switch,
  type PrefixList,
  type RouteMap,
  type RouteMapSequence,
  type Router,
  ipToInt,
  maskToInt,
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

function showBgp(session: SessionApi): string {
  const device = deviceOf(session);
  const configuration = device.bgp.configurationSnapshot();
  if (!configuration) return "% BGP is not running.";
  const rows = device.bgp.routes();
  if (!rows.length) return `BGP table version 0, local router ID ${configuration.routerId ?? "unassigned"}`;
  return [
    `BGP table, local router ID ${configuration.routerId ?? "unassigned"}, local AS ${configuration.localAs}`,
    table(["Status", "Network", "Next Hop", "Weight", "LocPrf", "Path"], rows.map((route) => [
      `${route.valid ? "*" : " "}${route.best ? ">" : " "}`,
      `${route.network}/${route.prefixLength}`,
      route.nextHop,
      String(route.weight),
      String(route.localPreference),
      `${route.asPath.join(" ")} ${route.origin === "igp" ? "i" : route.origin === "egp" ? "e" : "?"}`.trim(),
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
    pattern: "set as-path prepend {count}", modes: ["config-route-map"], device: "ospf",
    run: (s, p) => updateRouteMap(s, (sequence) => ({ ...sequence, set: { ...sequence.set, prependLocalAs: Number(p.count) } })),
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
      return table(["Neighbor", "V", "AS", "State/PfxRcd", "MsgRcvd", "MsgSent"], device.bgp.summaries().map((peer) => [
        peer.address, "4", String(peer.remoteAs), peer.state === "established" ? String(device.bgp.adjRibInEntries(peer.address).length) : peer.state,
        String(peer.messagesReceived), String(peer.messagesSent),
      ]));
    },
  },
  {
    pattern: "show ip bgp neighbors", modes: ["exec", "privileged"], device: "ospf",
    run: (s) => deviceOf(s).bgp.summaries().map((peer) => [
      `BGP neighbor is ${peer.address}, remote AS ${peer.remoteAs}`,
      `  BGP state = ${peer.state}`,
      `  Local address ${peer.localAddress ?? "unassigned"}, hold time ${peer.negotiatedHoldTimeSeconds ?? 0}`,
      `  Messages: sent ${peer.messagesSent}, received ${peer.messagesReceived}`,
      peer.lastError ? `  Last error: ${peer.lastError}` : "",
    ].filter(Boolean).join("\n")).join("\n\n") || "% No BGP neighbors configured.",
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
      return routes.map((route) => `${route.best ? ">" : " "} ${route.nextHop} ${route.localPreference} ${route.weight} ${route.asPath.join(" ")} ${route.origin}`).join("\n");
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
