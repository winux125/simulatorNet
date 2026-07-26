import { loopbackName, portChannelName } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import {
  expandInterfaceRange,
  isLayer3Switch,
  isOspfDevice,
  isRouter,
  isRoutingDevice,
  isSwitch,
  parseIpv4,
  parseVlanId,
  resolveInterface,
} from "./helpers";

/**
 * Select a logical interface — `Loopback0` or `Port-channel1` — which exists
 * inside the device rather than on the canvas. Returns true when it handled the
 * name, so the caller can fall through to the physical lookup otherwise.
 */
function selectLogicalInterface(session: SessionApi, spec: string): boolean {
  const compact = spec.replace(/\s+/gu, "");
  const loopback = /^lo(?:opback)?(\d+)$/i.exec(compact);
  if (loopback && isOspfDevice(session.device)) {
    const id = Number(loopback[1]);
    session.device.getOrCreateLoopback(id);
    session.ifaceCtx = {
      physical: loopbackName(id),
      isSubinterface: false,
      label: loopbackName(id),
      subVlan: undefined,
      subCreated: false,
      sviVlan: undefined,
      loopback: id,
      range: undefined,
    };
    session.enter("config-if");
    return true;
  }
  const channel = /^po(?:rt-channel)?(\d+)$/i.exec(compact);
  if (channel && isSwitch(session.device)) {
    const id = Number(channel[1]);
    if (!session.device.etherChannel.hasChannel(id)) {
      throw new ValidationError(`Port-channel${id} does not exist; add a member with 'channel-group ${id} mode ...' first.`);
    }
    const name = portChannelName(id);
    session.ifaceCtx = {
      physical: name,
      isSubinterface: false,
      label: name,
      subVlan: undefined,
      subCreated: false,
      sviVlan: undefined,
      loopback: undefined,
      range: undefined,
    };
    session.enter("config-if");
    return true;
  }
  return false;
}

/** Mode navigation, hostname, and entry into interface/VLAN configuration. */
export const navigationCommands: CommandSpec[] = [
  // --- EXEC / privileged transitions ---
  {
    pattern: "enable",
    modes: ["exec"],
    device: "network",
    run: (s) => s.enter("privileged"),
  },
  {
    pattern: "disable",
    modes: ["privileged"],
    device: "network",
    run: (s) => s.enter("exec"),
  },
  {
    pattern: "configure terminal",
    modes: ["privileged"],
    device: "network",
    run: (s) => s.enter("config"),
  },
  {
    pattern: "exit",
    modes: ["privileged"],
    device: "network",
    run: (s) => s.enter("exec"),
  },
  {
    pattern: "exit",
    modes: ["exec"],
    device: "network",
    run: () => "",
  },

  // --- leaving configuration sub-modes ---
  {
    pattern: "exit",
    modes: ["config"],
    device: "network",
    run: (s) => s.enter("privileged"),
  },
  {
    pattern: "exit",
    modes: ["config-if", "config-vlan", "config-acl", "config-router"],
    device: "network",
    run: (s) => s.enter("config"),
  },
  {
    pattern: "end",
    modes: ["config", "config-if", "config-vlan", "config-acl", "config-router"],
    device: "network",
    run: (s) => s.enter("privileged"),
  },

  // --- global configuration ---
  {
    pattern: "hostname {name}",
    modes: ["config"],
    device: "network",
    run: (s, p) => s.device.rename(p.name!),
  },
  {
    pattern: "interface vlan {id}",
    usage: "interface vlan <1-4094>",
    modes: ["config"],
    device: "l3-switch",
    capabilities: ["svi"],
    run: (s, p) => {
      const vlanId = parseVlanId(p.id!);
      if (!isLayer3Switch(s.device)) return;
      s.device.defineSvi(vlanId);
      s.ifaceCtx = {
        physical: `Vlan${vlanId}`,
        isSubinterface: false,
        label: `Vlan${vlanId}`,
        subVlan: undefined,
        subCreated: false,
        sviVlan: vlanId,
        loopback: undefined,
        range: undefined,
      };
      s.enter("config-if");
    },
  },
  {
    pattern: "interface loopback {id}",
    usage: "interface loopback <0-2147483647>",
    modes: ["config"],
    device: "ospf",
    run: (s, p) => {
      const id = Number(p.id!);
      if (!Number.isInteger(id) || id < 0) throw new ValidationError("Loopback number must be a non-negative integer.");
      if (!isOspfDevice(s.device)) throw new InvalidModeError("Loopbacks require a Router or an L3 Switch");
      s.device.getOrCreateLoopback(id);
      s.ifaceCtx = {
        physical: loopbackName(id),
        isSubinterface: false,
        label: loopbackName(id),
        subVlan: undefined,
        subCreated: false,
        sviVlan: undefined,
        loopback: id,
        range: undefined,
      };
      s.enter("config-if");
    },
  },
  {
    pattern: "interface range {spec...}",
    usage: "interface range <first> - <last>",
    modes: ["config"],
    device: "network",
    run: (s, p) => {
      // Expand and validate the whole range before anything is configured.
      const ports = expandInterfaceRange(s.device, p.spec!);
      s.ifaceCtx = {
        physical: ports[0]!,
        isSubinterface: false,
        label: `range ${ports[0]} - ${ports.at(-1)}`,
        subVlan: undefined,
        subCreated: false,
        sviVlan: undefined,
        loopback: undefined,
        range: ports,
      };
      s.enter("config-if");
    },
  },
  {
    pattern: "interface {spec...}",
    usage: "interface <interface-name>",
    modes: ["config"],
    device: "network",
    run: (s, p) => {
      // Logical interfaces have no cable and are not in the physical map, so
      // they are recognised before the physical lookup.
      const logical = selectLogicalInterface(s, p.spec!);
      if (logical) return;
      const resolved = resolveInterface(s.device, p.spec!);
      if (!resolved) throw new ValidationError("Interface not found.");
      const isSub = resolved.subNumber !== undefined;
      if (isSub && !isRouter(s.device)) {
        throw new InvalidModeError("Subinterfaces are only supported on a router");
      }
      if (isRouter(s.device) && !isSub) s.device.getOrCreateInterface(resolved.physical);
      s.ifaceCtx = {
        physical: resolved.physical,
        isSubinterface: isSub,
        label: resolved.subLabel,
        subVlan: undefined,
        subCreated: false,
        sviVlan: undefined,
        loopback: undefined,
        range: undefined,
      };
      s.enter("config-if");
    },
  },
  {
    pattern: "router ospf {process}",
    usage: "router ospf <1-65535>",
    modes: ["config"],
    device: "ospf",
    capabilities: ["ipv4-routing"],
    run: (s, p) => {
      const processId = Number(p.process!);
      if (!Number.isInteger(processId) || processId < 1 || processId > 65_535) {
        throw new ValidationError("OSPF process id must be between 1 and 65535.");
      }
      if (!isOspfDevice(s.device)) throw new InvalidModeError("OSPF requires a Router or an L3 Switch");
      s.device.ospf.createProcess(processId);
      s.routerCtx = { processId };
      s.enter("config-router");
    },
  },
  {
    pattern: "no router ospf {process}",
    modes: ["config"],
    device: "ospf",
    capabilities: ["ipv4-routing"],
    run: (s) => {
      if (isOspfDevice(s.device)) s.device.ospf.removeProcess();
    },
  },
  {
    pattern: "vlan {id}",
    modes: ["config"],
    device: "switch",
    capabilities: ["vlan"],
    run: (s, p) => {
      const id = parseVlanId(p.id!);
      if (isSwitch(s.device)) s.device.defineVlan(id);
      s.vlanId = id;
      s.enter("config-vlan");
    },
  },
  {
    pattern: "ip route {network} {mask} {nexthop}",
    usage: "ip route <network> <mask> <next-hop>",
    modes: ["config"],
    device: "router",
    capabilities: ["static-routing"],
    run: (s, p) => {
      const network = parseIpv4(p.network!);
      const mask = parseIpv4(p.mask!);
      const nexthop = parseIpv4(p.nexthop!);
      if (isRoutingDevice(s.device)) s.device.addStaticRoute(network, mask, nexthop);
    },
  },
  {
    pattern: "ip routing",
    modes: ["config"],
    device: "l3-switch",
    capabilities: ["ipv4-routing"],
    run: (s) => { if (isLayer3Switch(s.device)) s.device.setIpRouting(true); },
  },
  {
    pattern: "no ip routing",
    modes: ["config"],
    device: "l3-switch",
    capabilities: ["ipv4-routing"],
    run: (s) => { if (isLayer3Switch(s.device)) s.device.setIpRouting(false); },
  },
];
