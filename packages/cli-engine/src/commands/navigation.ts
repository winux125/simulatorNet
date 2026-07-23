import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec } from "../types";
import { isLayer3Switch, isRouter, isRoutingDevice, isSwitch, parseIpv4, parseVlanId, resolveInterface } from "./helpers";

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
    modes: ["config-if", "config-vlan"],
    device: "network",
    run: (s) => s.enter("config"),
  },
  {
    pattern: "end",
    modes: ["config", "config-if", "config-vlan"],
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
      };
      s.enter("config-if");
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
