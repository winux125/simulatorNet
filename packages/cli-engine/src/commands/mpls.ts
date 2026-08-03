import { type Router, ipToInt, maskToInt } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import { table } from "../formatter/tables";
import type { CommandSpec, SessionApi } from "../types";
import { isRouter, parseIpv4, parseIpv6, parseIpv6Prefix } from "./helpers";

function routerOf(session: SessionApi): Router {
  if (!isRouter(session.device)) throw new InvalidModeError("MPLS, LDP and VRF are supported only on a Router");
  return session.device;
}

function interfaceName(session: SessionApi): string {
  const context = session.ifaceCtx;
  if (!context) throw new InvalidModeError("No interface selected");
  return context.isSubinterface ? context.label : context.physical;
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

function updateVrf(session: SessionApi, mutate: (current: ReturnType<Router["vrfConfigurations"]>[number] | undefined) => {
  id: string;
  name: string;
  routeDistinguisher: string;
  importRouteTargets: readonly string[];
  exportRouteTargets: readonly string[];
  addressFamilyIpv6?: boolean;
}): void {
  const router = routerOf(session);
  const context = session.vrfCtx;
  if (!context) throw new InvalidModeError("Enter 'vrf definition <name>' first");
  const current = router.vrfConfigurations().find((vrf) => vrf.id === context.id);
  const next = mutate(current);
  router.defineVrf(next);
  context.routeDistinguisher = next.routeDistinguisher;
}

/** Carry every setting the caller is not changing through `defineVrf`. */
function vrfBase(session: SessionApi, current: ReturnType<Router["vrfConfigurations"]>[number] | undefined) {
  return {
    id: session.vrfCtx!.id,
    name: session.vrfCtx!.name,
    routeDistinguisher: current?.routeDistinguisher ?? session.vrfCtx!.routeDistinguisher!,
    importRouteTargets: current?.importRouteTargets ?? [],
    exportRouteTargets: current?.exportRouteTargets ?? [],
    addressFamilyIpv6: current?.addressFamilyIpv6,
  };
}

function showMplsForwarding(session: SessionApi, label?: number): string {
  const entries = routerOf(session).mpls.forwardingTable().filter((entry) => label === undefined || entry.incomingLabel === label);
  if (!entries.length) return "% MPLS forwarding table is empty.";
  return table(["Local", "FEC", "Operation", "Next Hop", "Interface", "Source"], entries.map((entry) => [
    String(entry.incomingLabel),
    entry.fec,
    entry.operation.type === "swap" ? `swap ${entry.operation.outgoingLabel}`
      : entry.operation.type === "push" ? `push ${entry.operation.labels.join("/")}`
      : entry.operation.type === "deliver" ? `deliver${entry.operation.vrfId ? ` ${entry.operation.vrfId}` : ""}`
      : entry.operation.type,
    entry.nextHop ?? "-",
    entry.outgoingInterfaceId ?? "-",
    entry.source,
  ]));
}

function showVpnv4(session: SessionApi, vrfId?: string): string {
  const router = routerOf(session);
  const allowedRds = vrfId === undefined
    ? undefined
    : new Set(router.vrfConfigurations().filter((vrf) => vrf.id === vrfId || vrf.name === vrfId).map((vrf) => vrf.routeDistinguisher));
  const routes = router.bgp.vpnv4Routes().filter((route) => allowedRds === undefined || allowedRds.has(route.routeDistinguisher));
  if (!routes.length) return "% VPNv4 table is empty.";
  // Originator/cluster list expose VPNv4 route reflection through the same
  // table, so a reflected VPN path is visible without a second command.
  return table(["Status", "RD", "Prefix", "Next Hop", "VPN Label", "Route Targets", "Originator", "Cluster list"], routes.map((route) => [
    route.best ? "*>" : "*",
    route.routeDistinguisher,
    `${route.network}/${route.prefixLength}`,
    route.nextHop,
    String(route.vpnLabel),
    route.routeTargets.join(","),
    route.originatorId ?? "—",
    route.clusterList.join(" ") || "—",
  ]));
}

function showVpnv4Neighbors(session: SessionApi): string {
  const router = routerOf(session);
  const configuration = router.bgp.configurationSnapshot();
  const summaries = new Map(router.bgp.summaries().map((summary) => [summary.address, summary]));
  const neighbors = (configuration?.neighbors ?? []).filter((neighbor) => neighbor.vpnv4Activated);
  if (!neighbors.length) return "% No VPNv4 neighbors configured.";
  return table(["Neighbor", "State", "Remote AS", "Extended community"], neighbors.map((neighbor) => [
    neighbor.address,
    summaries.get(neighbor.address)?.state ?? "idle",
    String(neighbor.remoteAs),
    neighbor.sendCommunityExtended ? "sent" : "disabled",
  ]));
}

export const mplsCommands: CommandSpec[] = [
  {
    pattern: "mpls label protocol ldp", modes: ["config"], device: "router",
    run: (s) => { routerOf(s).ldp.arm(); },
  },
  {
    pattern: "mpls ldp router-id {interface} force", modes: ["config"], device: "router",
    run: (s, p) => routerOf(s).configureLdpRouterId(p.interface!),
  },
  {
    pattern: "mpls ip", modes: ["config-if"], device: "router",
    run: (s) => routerOf(s).setMplsEnabled(interfaceName(s), true),
  },
  {
    pattern: "no mpls ip", modes: ["config-if"], device: "router",
    run: (s) => routerOf(s).setMplsEnabled(interfaceName(s), false),
  },
  {
    pattern: "vrf forwarding {name}", modes: ["config-if"], device: "router",
    run: (s, p) => {
      const router = routerOf(s);
      const vrf = router.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name);
      if (!vrf) throw new ValidationError(`VRF '${p.name}' is not defined.`);
      router.assignInterfaceVrf(interfaceName(s), vrf.id);
    },
  },
  {
    pattern: "no vrf forwarding", modes: ["config-if"], device: "router",
    run: (s) => routerOf(s).assignInterfaceVrf(interfaceName(s), undefined),
  },
  {
    pattern: "rd {value}", usage: "rd <asn:number|ipv4:number>", modes: ["config-vrf"], device: "router",
    run: (s, p) => updateVrf(s, (current) => ({ ...vrfBase(s, current), routeDistinguisher: p.value! })),
  },
  {
    pattern: "route-target {direction} {value}", usage: "route-target import|export <asn:number|ipv4:number>",
    modes: ["config-vrf"], device: "router",
    run: (s, p) => updateVrf(s, (current) => {
      if (!current && !s.vrfCtx?.routeDistinguisher) throw new ValidationError("Configure the route distinguisher first.");
      if (p.direction !== "import" && p.direction !== "export") throw new ValidationError("Route-target direction must be import or export.");
      const imports = [...(current?.importRouteTargets ?? [])];
      const exports = [...(current?.exportRouteTargets ?? [])];
      const list = p.direction === "import" ? imports : exports;
      if (!list.includes(p.value!)) list.push(p.value!);
      return { ...vrfBase(s, current), importRouteTargets: imports, exportRouteTargets: exports };
    }),
  },
  {
    // `address-family ipv6` inside a VRF adds a second, separate route table.
    // IPv4 has always been implicit here, so it needs no counterpart command.
    pattern: "address-family ipv6", modes: ["config-vrf"], device: "router",
    run: (s) => updateVrf(s, (current) => {
      if (!current && !s.vrfCtx?.routeDistinguisher) throw new ValidationError("Configure the route distinguisher first.");
      return { ...vrfBase(s, current), addressFamilyIpv6: true };
    }),
  },
  {
    pattern: "exit-address-family", modes: ["config-vrf"], device: "router",
    run: () => undefined,
  },
  {
    pattern: "ip route vrf {vrf} {network} {mask} {nextHop}", modes: ["config"], device: "router",
    run: (s, p) => {
      const router = routerOf(s);
      const vrf = router.vrfConfigurations().find((entry) => entry.id === p.vrf || entry.name === p.vrf);
      if (!vrf) throw new ValidationError(`VRF '${p.vrf}' is not defined.`);
      const network = parseIpv4(p.network!);
      const length = prefixLength(p.mask!);
      if (((ipToInt(network) & maskToInt(length)) >>> 0) !== ipToInt(network)) throw new ValidationError("Static route must use a network address.");
      try {
        router.addVrfStaticRoute(vrf.id, network, length, parseIpv4(p.nextHop!));
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "Invalid VRF static route.");
      }
    },
  },
  {
    pattern: "ipv6 route vrf {vrf} {prefix} {nextHop}",
    usage: "ipv6 route vrf <name> <prefix>/<length> <next-hop>",
    modes: ["config"], device: "router",
    run: (s, p) => {
      const router = routerOf(s);
      const vrf = router.vrfConfigurations().find((entry) => entry.id === p.vrf || entry.name === p.vrf);
      if (!vrf) throw new ValidationError(`VRF '${p.vrf}' is not defined.`);
      const { network, prefixLength } = parseIpv6Prefix(p.prefix!);
      try {
        router.addVrfIpv6StaticRoute(vrf.id, network, prefixLength, parseIpv6(p.nextHop!));
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "Invalid VRF IPv6 static route.");
      }
    },
  },
  {
    pattern: "show ipv6 route vrf {name}", modes: ["exec", "privileged"], device: "router",
    run: (s, p) => {
      const router = routerOf(s);
      const vrf = router.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name);
      if (!vrf) return `% VRF ${p.name} is not configured.`;
      if (!vrf.addressFamilyIpv6) return `% VRF ${vrf.name} has no IPv6 address family.`;
      const rows = router.vrfIpv6RoutingTable(vrf.id);
      return rows.length
        ? table(["Source", "Prefix", "Next Hop", "Interface", "VPN Label"], rows.map((route) => [
            route.source,
            `${route.network}/${route.prefixLength}`,
            route.nextHop ?? route.remotePe ?? "direct",
            route.outgoingInterfaceId ?? "-",
            route.vpnLabel === undefined ? "-" : String(route.vpnLabel),
          ]))
        : `% VRF ${vrf.name} IPv6 routing table is empty.`;
    },
  },
  {
    pattern: "show mpls interfaces", modes: ["exec", "privileged"], device: "router",
    run: (s) => table(["Interface", "MPLS", "Operational"], routerOf(s).mplsInterfaceSummaries().map((row) => [row.interfaceId, "enabled", row.operational ? "up" : "down"])),
  },
  {
    pattern: "show mpls ldp neighbor", modes: ["exec", "privileged"], device: "router",
    run: (s) => {
      const rows = routerOf(s).ldp.neighborSummaries();
      return rows.length ? table(["Peer", "State", "Local", "Remote", "Transport"], rows.map((row) => [row.routerId, row.state, row.localInterfaceId, row.remoteInterfaceId, row.remoteTransportAddress])) : "% No LDP neighbors.";
    },
  },
  {
    pattern: "show mpls ldp bindings", modes: ["exec", "privileged"], device: "router",
    run: (s) => {
      const rows = routerOf(s).ldp.labelBindings();
      return rows.length ? table(["FEC", "Local", "Remote labels", "Implicit null"], rows.map((row) => [row.fec, String(row.localLabel), Object.entries(row.remoteLabels).map(([id, label]) => `${id}:${label}`).join(",") || "-", row.implicitNullNeighborIds.join(",") || "-"])) : "% No LDP bindings.";
    },
  },
  { pattern: "show mpls forwarding-table", modes: ["exec", "privileged"], device: "router", run: (s) => showMplsForwarding(s) },
  { pattern: "show mpls forwarding-table labels {label}", modes: ["exec", "privileged"], device: "router", run: (s, p) => showMplsForwarding(s, Number(p.label)) },
  {
    pattern: "show vrf", modes: ["exec", "privileged"], device: "router",
    run: (s) => {
      const rows = routerOf(s).vrfConfigurations();
      return rows.length ? table(["Name", "RD", "Import RT", "Export RT"], rows.map((vrf) => [vrf.name, vrf.routeDistinguisher, vrf.importRouteTargets.join(","), vrf.exportRouteTargets.join(",")])) : "% No VRFs configured.";
    },
  },
  {
    pattern: "show vrf detail", modes: ["exec", "privileged"], device: "router",
    run: (s) => routerOf(s).vrfConfigurations().map((vrf) => [`VRF ${vrf.name} (${vrf.id})`, `  RD ${vrf.routeDistinguisher}`, `  Import RT ${vrf.importRouteTargets.join(", ") || "none"}`, `  Export RT ${vrf.exportRouteTargets.join(", ") || "none"}`].join("\n")).join("\n\n") || "% No VRFs configured.",
  },
  {
    pattern: "show ip route vrf {name}", modes: ["exec", "privileged"], device: "router",
    run: (s, p) => {
      const router = routerOf(s);
      const vrf = router.vrfConfigurations().find((entry) => entry.id === p.name || entry.name === p.name);
      if (!vrf) return `% VRF ${p.name} is not configured.`;
      const rows = router.vrfRoutingTable(vrf.id);
      return rows.length ? table(["Source", "Prefix", "Next Hop", "Interface", "VPN Label"], rows.map((route) => [route.source, `${route.network}/${route.prefixLength}`, route.nextHop ?? "direct", route.outgoingInterfaceId ?? "-", route.vpnLabel === undefined ? "-" : String(route.vpnLabel)])) : `% VRF ${vrf.name} routing table is empty.`;
    },
  },
  {
    pattern: "show ip interface brief vrf all", modes: ["exec", "privileged"], device: "router",
    run: (s) => {
      const router = routerOf(s);
      return table(["Interface", "VRF", "IPv4", "Status"], router.interfaceSummaries().map((iface) => [
        iface.name,
        router.interfaceVrf(iface.name) ?? "global",
        iface.ip ?? "unassigned",
        iface.operUp ? "up" : "down",
      ]));
    },
  },
  { pattern: "show bgp vpnv4 unicast all", modes: ["exec", "privileged"], device: "router", run: (s) => showVpnv4(s) },
  { pattern: "show ip bgp vpnv4 all", modes: ["exec", "privileged"], device: "router", run: (s) => showVpnv4(s) },
  { pattern: "show bgp vpnv4 unicast vrf {name}", modes: ["exec", "privileged"], device: "router", run: (s, p) => showVpnv4(s, p.name) },
  { pattern: "show bgp vpnv4 unicast neighbors", modes: ["exec", "privileged"], device: "router", run: showVpnv4Neighbors },
  {
    pattern: "clear mpls ldp neighbor *", modes: ["privileged"], device: "router",
    run: (s) => s.requestConfirmation("Restart all LDP sessions? [yes/no]: ", () => {
      const router = routerOf(s);
      router.ldp.resetRuntime();
      router.ldp.arm();
      return "% LDP sessions restarted; configuration is unchanged.";
    }),
  },
];
