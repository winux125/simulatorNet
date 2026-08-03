import {
  type EtherChannelMode,
  type Layer3Switch,
  loopbackName,
  type Router,
  type SpanningTreeMode,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import {
  showCdpInterface,
  showCdpNeighbors,
  showEtherChannelSummary,
  showEtherChannelPortChannel,
  showInterfacesPortChannel,
  showLacpNeighbor,
  showLldpInterface,
  showLldpNeighbors,
  showOspfDatabase,
  showOspfInterface,
  showOspfInterfaceBrief,
  showOspfNeighbor,
  showOspfOverview,
  showPagpNeighbor,
  showSpanningTree,
  showSpanningTreeInterface,
  showSpanningTreeSummary,
  showSpanningTreeVlan,
} from "../formatter/protocols";
import type { CliMode } from "../session/mode";
import type { CommandSpec, SessionApi } from "../types";
import {
  contextPorts,
  isLayer3Switch,
  isOspfDevice,
  isSwitch,
  parseIpv4,
  parseVlanId,
} from "./helpers";

const SHOW_MODES: CliMode[] = ["exec", "privileged"];

function requireCtx(session: SessionApi) {
  if (!session.ifaceCtx) throw new InvalidModeError("No interface selected");
  return session.ifaceCtx;
}

function requireSwitch(session: SessionApi) {
  if (!isSwitch(session.device)) throw new InvalidModeError("This command requires a switch");
  return session.device;
}

function requireOspfDevice(session: SessionApi): Router | Layer3Switch {
  if (!isOspfDevice(session.device)) throw new InvalidModeError("OSPF requires a Router or an L3 Switch");
  return session.device;
}

function integer(token: string, low: number, high: number, label: string): number {
  const value = Number(token);
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new ValidationError(`${label} must be between ${low} and ${high}.`);
  }
  return value;
}

/**
 * Apply a change to every port a range selected. The callback runs only after
 * every port has been validated, so a range is never left half configured.
 */
function forEachRangePort(session: SessionApi, apply: (port: string) => void): void {
  const ctx = requireCtx(session);
  if (ctx.sviVlan !== undefined || ctx.loopback !== undefined) {
    throw new InvalidModeError("This command is only valid on a physical interface");
  }
  const ports = contextPorts(ctx);
  for (const port of ports) {
    if (!session.device.getInterface(port)) throw new ValidationError(`Interface ${port} not found.`);
  }
  for (const port of ports) apply(port);
}

/** `spanning-tree`, `channel-group`, `cdp`, `lldp`, `router ospf` and their shows. */
export const protocolCommands: CommandSpec[] = [
  // --- spanning tree: global ---------------------------------------------
  {
    pattern: "spanning-tree mode pvst",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => { requireSwitch(s).setSpanningTreeMode("stp" satisfies SpanningTreeMode); },
  },
  {
    pattern: "spanning-tree mode rapid-pvst",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => { requireSwitch(s).setSpanningTreeMode("rstp" satisfies SpanningTreeMode); },
  },
  {
    pattern: "no spanning-tree mode",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => { requireSwitch(s).setSpanningTreeMode("disabled"); },
  },
  {
    pattern: "spanning-tree vlan {vlan} priority {priority}",
    usage: "spanning-tree vlan <1-4094> priority <0-61440 in steps of 4096>",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      const vlan = parseVlanId(p.vlan!);
      const priority = integer(p.priority!, 0, 61_440, "Bridge priority");
      requireSwitch(s).spanningTree.setBridgePriority(vlan, priority);
    },
  },
  {
    pattern: "spanning-tree vlan {vlan} root primary",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      // A deterministic helper, not full Cisco automation: it simply sets a
      // priority low enough to win the election on a default network.
      requireSwitch(s).spanningTree.setBridgePriority(parseVlanId(p.vlan!), 24_576);
    },
  },
  {
    pattern: "spanning-tree vlan {vlan} root secondary",
    modes: ["config"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      requireSwitch(s).spanningTree.setBridgePriority(parseVlanId(p.vlan!), 28_672);
    },
  },

  // --- spanning tree: per interface ---------------------------------------
  {
    pattern: "spanning-tree cost {cost}",
    usage: "spanning-tree cost <1-200000000>",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      const cost = integer(p.cost!, 1, 200_000_000, "Port cost");
      forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setPortCost(port, cost));
    },
  },
  {
    pattern: "spanning-tree port-priority {priority}",
    usage: "spanning-tree port-priority <0-240 in steps of 16>",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      const priority = integer(p.priority!, 0, 240, "Port priority");
      forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setPortPriority(port, priority));
    },
  },
  {
    pattern: "spanning-tree portfast",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setPortFast(port, true)),
  },
  {
    pattern: "no spanning-tree portfast",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setPortFast(port, false)),
  },
  {
    pattern: "spanning-tree bpduguard enable",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setBpduGuard(port, true)),
  },
  {
    pattern: "spanning-tree bpduguard disable",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => forEachRangePort(s, (port) => requireSwitch(s).spanningTree.setBpduGuard(port, false)),
  },

  // --- EtherChannel --------------------------------------------------------
  {
    pattern: "channel-group {id} mode {mode}",
    usage: "channel-group <1-64> mode on|active|passive|desirable|auto",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s, p) => {
      const channelId = integer(p.id!, 1, 64, "Channel group");
      const mode = p.mode!.toLowerCase();
      if (!["on", "active", "passive", "desirable", "auto"].includes(mode)) {
        throw new ValidationError(`Unsupported EtherChannel mode '${p.mode}'.`);
      }
      forEachRangePort(s, (port) => {
        requireSwitch(s).addChannelGroupMember(channelId, port, mode as EtherChannelMode);
      });
    },
  },
  {
    pattern: "no channel-group",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => forEachRangePort(s, (port) => requireSwitch(s).removeChannelGroupMember(port)),
  },

  // --- CDP -----------------------------------------------------------------
  {
    pattern: "cdp run",
    modes: ["config"],
    device: "cdp",
    run: (s) => { discoveryOf(s).setCdpEnabled(true); },
  },
  {
    pattern: "no cdp run",
    modes: ["config"],
    device: "cdp",
    run: (s) => { discoveryOf(s).setCdpEnabled(false); },
  },
  {
    pattern: "cdp enable",
    modes: ["config-if"],
    device: "cdp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceCdpEnabled(port, true)),
  },
  {
    pattern: "no cdp enable",
    modes: ["config-if"],
    device: "cdp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceCdpEnabled(port, false)),
  },

  // --- LLDP ----------------------------------------------------------------
  {
    pattern: "lldp run",
    modes: ["config"],
    device: "lldp",
    run: (s) => { discoveryOf(s).setLldpEnabled(true); },
  },
  {
    pattern: "no lldp run",
    modes: ["config"],
    device: "lldp",
    run: (s) => { discoveryOf(s).setLldpEnabled(false); },
  },
  {
    pattern: "lldp transmit",
    modes: ["config-if"],
    device: "lldp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceLldpTransmit(port, true)),
  },
  {
    pattern: "no lldp transmit",
    modes: ["config-if"],
    device: "lldp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceLldpTransmit(port, false)),
  },
  {
    pattern: "lldp receive",
    modes: ["config-if"],
    device: "lldp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceLldpReceive(port, true)),
  },
  {
    pattern: "no lldp receive",
    modes: ["config-if"],
    device: "lldp",
    run: (s) => forEachRangePort(s, (port) => discoveryOf(s).setInterfaceLldpReceive(port, false)),
  },

  // --- OSPF: process configuration ----------------------------------------
  {
    pattern: "router-id {id}",
    usage: "router-id <a.b.c.d>",
    modes: ["config-router"],
    device: "ospf",
    run: (s, p) => {
      const device = requireOspfDevice(s);
      const routerId = parseIpv4(p.id!);
      if (s.routerCtx?.family === "bgp") {
        const configuration = device.bgp.configurationSnapshot();
        if (!configuration) throw new InvalidModeError("BGP is not running");
        device.bgp.configure({ ...configuration, routerId });
      } else if (s.routerCtx?.family === "ipv6") device.ospfv3.setRouterId(routerId);
      else device.ospf.setRouterId(routerId);
    },
  },
  {
    pattern: "network {network} {wildcard} area {area}",
    usage: "network <address> <wildcard> area 0",
    modes: ["config-router"],
    device: "ospf",
    run: (s, p) => {
      if (s.routerCtx?.family === "ipv6") {
        throw new InvalidModeError("OSPFv3 advertises enabled IPv6 interfaces; network statements are not used");
      }
      const area = integer(p.area!, 0, 4_294_967_295, "OSPF area");
      requireOspfDevice(s).ospf.addNetwork(parseIpv4(p.network!), parseIpv4(p.wildcard!), area);
    },
  },
  {
    pattern: "no network {network} {wildcard} area {area}",
    modes: ["config-router"],
    device: "ospf",
    run: (s, p) => {
      if (s.routerCtx?.family === "ipv6") {
        throw new InvalidModeError("OSPFv3 does not use network statements");
      }
      requireOspfDevice(s).ospf.removeNetwork(parseIpv4(p.network!), parseIpv4(p.wildcard!));
    },
  },
  {
    pattern: "passive-interface {name}",
    usage: "passive-interface <interface-name>",
    modes: ["config-router"],
    device: "ospf",
    run: (s, p) => {
      const device = requireOspfDevice(s);
      const name = resolveL3Name(s, p.name!);
      if (s.routerCtx?.family === "ipv6") device.ospfv3.setPassiveInterface(name, true);
      else device.ospf.setPassiveInterface(name, true);
    },
  },
  {
    pattern: "no passive-interface {name}",
    modes: ["config-router"],
    device: "ospf",
    run: (s, p) => {
      const device = requireOspfDevice(s);
      const name = resolveL3Name(s, p.name!);
      if (s.routerCtx?.family === "ipv6") device.ospfv3.setPassiveInterface(name, false);
      else device.ospf.setPassiveInterface(name, false);
    },
  },

  // --- OSPF: per interface -------------------------------------------------
  {
    pattern: "ip ospf {process} area {area}",
    usage: "ip ospf <process-id> area 0",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const device = requireOspfDevice(s);
      const area = integer(p.area!, 0, 4_294_967_295, "OSPF area");
      device.ospf.createProcess(integer(p.process!, 1, 65_535, "OSPF process id"));
      forEachL3Port(s, (name) => device.ospf.configureInterface(name, { area, enabled: true }));
    },
  },
  {
    pattern: "ip ospf cost {cost}",
    usage: "ip ospf cost <1-65535>",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const cost = integer(p.cost!, 1, 65_535, "OSPF cost");
      forEachL3Port(s, (name) => requireOspfDevice(s).ospf.configureInterface(name, { cost }));
    },
  },
  {
    pattern: "ipv6 ospf {process} area {area}",
    usage: "ipv6 ospf <process-id> area 0",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const device = requireOspfDevice(s);
      const area = integer(p.area!, 0, 0, "OSPFv3 area");
      device.ospfv3.createProcess(integer(p.process!, 1, 65_535, "OSPFv3 process id"));
      forEachL3Port(s, (name) => device.ospfv3.configureInterface(name, { area, enabled: true }));
    },
  },
  {
    pattern: "ipv6 ospf cost {cost}",
    usage: "ipv6 ospf cost <1-65535>",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const cost = integer(p.cost!, 1, 65_535, "OSPFv3 cost");
      forEachL3Port(s, (name) => requireOspfDevice(s).ospfv3.configureInterface(name, { cost }));
    },
  },
  {
    pattern: "ip ospf priority {priority}",
    usage: "ip ospf priority <0-255>",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const priority = integer(p.priority!, 0, 255, "OSPF priority");
      forEachL3Port(s, (name) => requireOspfDevice(s).ospf.configureInterface(name, { priority }));
    },
  },
  {
    pattern: "ip ospf network point-to-point",
    modes: ["config-if"],
    device: "ospf",
    run: (s) => forEachL3Port(s, (name) =>
      requireOspfDevice(s).ospf.configureInterface(name, { networkType: "point-to-point" })),
  },
  {
    pattern: "ip ospf network broadcast",
    modes: ["config-if"],
    device: "ospf",
    run: (s) => forEachL3Port(s, (name) =>
      requireOspfDevice(s).ospf.configureInterface(name, { networkType: "broadcast" })),
  },
  {
    pattern: "ip ospf hello-interval {seconds}",
    usage: "ip ospf hello-interval <1-65535>",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const seconds = integer(p.seconds!, 1, 65_535, "Hello interval");
      forEachL3Port(s, (name) => requireOspfDevice(s).ospf.configureInterface(name, {
        helloIntervalNs: seconds * 1_000_000_000,
      }));
    },
  },
  {
    pattern: "ip ospf dead-interval {seconds}",
    usage: "ip ospf dead-interval <1-65535>",
    modes: ["config-if"],
    device: "ospf",
    run: (s, p) => {
      const seconds = integer(p.seconds!, 1, 65_535, "Dead interval");
      forEachL3Port(s, (name) => requireOspfDevice(s).ospf.configureInterface(name, {
        deadIntervalNs: seconds * 1_000_000_000,
      }));
    },
  },

  // --- show ----------------------------------------------------------------
  {
    pattern: "show spanning-tree",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => showSpanningTree(requireSwitch(s)),
  },
  {
    pattern: "show spanning-tree summary",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s) => showSpanningTreeSummary(requireSwitch(s)),
  },
  {
    pattern: "show spanning-tree vlan {vlan}",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => showSpanningTreeVlan(requireSwitch(s), parseVlanId(p.vlan!)),
  },
  {
    pattern: "show spanning-tree interface {name}",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => showSpanningTreeInterface(requireSwitch(s), p.name!),
  },
  {
    pattern: "show etherchannel summary",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => showEtherChannelSummary(requireSwitch(s)),
  },
  {
    pattern: "show etherchannel port-channel",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => showEtherChannelPortChannel(requireSwitch(s)),
  },
  {
    pattern: "show interfaces port-channel",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => showInterfacesPortChannel(requireSwitch(s)),
  },
  {
    pattern: "show lacp neighbor",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => showLacpNeighbor(requireSwitch(s)),
  },
  {
    pattern: "show pagp neighbor",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => showPagpNeighbor(requireSwitch(s)),
  },
  {
    pattern: "show cdp neighbors",
    modes: SHOW_MODES,
    device: "cdp",
    run: (s) => showCdpNeighbors(discoveryOf(s), false),
  },
  {
    pattern: "show cdp neighbors detail",
    modes: SHOW_MODES,
    device: "cdp",
    run: (s) => showCdpNeighbors(discoveryOf(s), true),
  },
  {
    pattern: "show cdp interface",
    modes: SHOW_MODES,
    device: "cdp",
    run: (s) => showCdpInterface(discoveryOf(s)),
  },
  {
    pattern: "show lldp neighbors",
    modes: SHOW_MODES,
    device: "lldp",
    run: (s) => showLldpNeighbors(discoveryOf(s), false),
  },
  {
    pattern: "show lldp neighbors detail",
    modes: SHOW_MODES,
    device: "lldp",
    run: (s) => showLldpNeighbors(discoveryOf(s), true),
  },
  {
    pattern: "show lldp interface",
    modes: SHOW_MODES,
    device: "lldp",
    run: (s) => showLldpInterface(discoveryOf(s)),
  },
  {
    pattern: "show ip ospf",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfOverview(requireOspfDevice(s)),
  },
  {
    pattern: "show ip ospf neighbor",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfNeighbor(requireOspfDevice(s), false),
  },
  {
    pattern: "show ip ospf neighbor detail",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfNeighbor(requireOspfDevice(s), true),
  },
  {
    pattern: "show ip ospf interface",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfInterface(requireOspfDevice(s)),
  },
  {
    pattern: "show ip ospf interface brief",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfInterfaceBrief(requireOspfDevice(s)),
  },
  {
    pattern: "show ip ospf database",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => showOspfDatabase(requireOspfDevice(s)),
  },
  {
    pattern: "show ip route ospf",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => {
      const device = requireOspfDevice(s);
      const rows = device.routingTable().filter((route) => route.kind === "ospf");
      if (rows.length === 0) return "% No OSPF routes have been learned.";
      return rows
        .map((route) => `O    ${route.network}/${maskLength(route.maskInt)} [${route.administrativeDistance}/${route.metric}] via ${route.viaIp ?? "-"}, ${route.egressName}`)
        .join("\n");
    },
  },
  {
    pattern: "show ipv6 ospf",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => {
      const overview = requireOspfDevice(s).ospfv3.overview();
      if (!overview.enabled) return "% OSPFv3 is not running. Use 'ipv6 router ospf <process-id>' to start it.";
      return [
        `OSPFv3 process ${overview.processId}, Router ID ${overview.routerId ?? "not configured"}`,
        `Neighbors: ${overview.fullNeighbors}/${overview.neighbors} Full`,
        `LSAs: ${overview.lsas}, Routes: ${overview.routes}, SPF runs: ${overview.spfRuns}`,
      ].join("\n");
    },
  },
  {
    pattern: "show ipv6 ospf neighbor",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => {
      const rows = requireOspfDevice(s).ospfv3.neighborSummaries();
      if (rows.length === 0) return "% No OSPFv3 neighbors.";
      return [
        "Neighbor ID      State       Interface       Address",
        ...rows.map((row) =>
          `${row.neighborRouterId.padEnd(16)} ${row.state.toUpperCase().padEnd(11)} ${row.interfaceId.padEnd(15)} ${row.address}`),
      ].join("\n");
    },
  },
  {
    pattern: "show ipv6 ospf database",
    modes: SHOW_MODES,
    device: "ospf",
    run: (s) => {
      const rows = requireOspfDevice(s).ospfv3.database();
      if (rows.length === 0) return "% OSPFv3 link-state database is empty.";
      return [
        "Advertising Router  Sequence    Checksum  Prefixes  Links",
        ...rows.map((row) =>
          `${row.advertisingRouter.padEnd(19)} ${row.sequence.toString(16).padStart(8, "0")}  ${row.checksum.toString(16).padStart(8, "0")}  ${String(row.prefixCount).padEnd(8)}  ${row.linkCount}`),
      ].join("\n");
    },
  },

  // --- runtime actions -----------------------------------------------------
  {
    pattern: "clear ip ospf process",
    modes: ["privileged"],
    device: "ospf",
    run: (s) => {
      // A destructive runtime action, so it asks first, exactly like IOS.
      requireOspfDevice(s);
      return s.requestConfirmation(
        "Reset ALL OSPF processes? [yes/no]: ",
        () => {
          requireOspfDevice(s).ospf.restart();
          return "% Clearing the OSPF process; configuration is unchanged.";
        },
      );
    },
  },
  {
    pattern: "clear cdp table",
    modes: ["privileged"],
    device: "cdp",
    run: (s) => {
      const cleared = discoveryOf(s).clearNeighbors("cdp");
      return `% Cleared ${cleared} CDP neighbour entr${cleared === 1 ? "y" : "ies"}.`;
    },
  },
  {
    pattern: "clear lldp table",
    modes: ["privileged"],
    device: "lldp",
    run: (s) => {
      const cleared = discoveryOf(s).clearNeighbors("lldp");
      return `% Cleared ${cleared} LLDP neighbour entr${cleared === 1 ? "y" : "ies"}.`;
    },
  },
  {
    pattern: "errdisable recovery {name}",
    usage: "errdisable recovery <interface-name>",
    modes: ["privileged"],
    device: "switch",
    capabilities: ["spanning-tree"],
    run: (s, p) => {
      const device = requireSwitch(s);
      const reset = device.spanningTree.resetErrorDisabled(p.name!);
      return reset
        ? `% ${p.name} recovered from error-disabled state.`
        : `% ${p.name} is not error-disabled.`;
    },
  },
];

function discoveryOf(session: SessionApi) {
  const device = session.device as { discovery?: Router["discovery"] };
  if (!device.discovery) throw new InvalidModeError("This device does not support neighbour discovery");
  return device.discovery;
}

/** Interface OSPF commands accept a routed port, an SVI or a loopback. */
function forEachL3Port(session: SessionApi, apply: (name: string) => void): void {
  const ctx = requireCtx(session);
  if (ctx.loopback !== undefined) {
    apply(loopbackName(ctx.loopback));
    return;
  }
  if (ctx.sviVlan !== undefined) {
    apply(`Vlan${ctx.sviVlan}`);
    return;
  }
  const ports = contextPorts(ctx);
  for (const port of ports) {
    if (!session.device.getInterface(port)) throw new ValidationError(`Interface ${port} not found.`);
  }
  for (const port of ports) apply(port);
}

function resolveL3Name(session: SessionApi, typed: string): string {
  const direct = session.device.getInterface(typed);
  if (direct) return direct.name;
  if (/^loopback\d+$/i.test(typed)) return loopbackName(Number(typed.slice("Loopback".length)));
  if (/^vlan\d+$/i.test(typed) && isLayer3Switch(session.device)) return `Vlan${typed.slice(4)}`;
  return typed;
}

function maskLength(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}
