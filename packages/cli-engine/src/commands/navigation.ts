import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec } from "../types";
import { isRouter, isSwitch, parseIpv4, parseVlanId, resolveInterface } from "./helpers";

/** Mode navigation, hostname, and entry into interface/VLAN configuration. */
export const navigationCommands: CommandSpec[] = [
  // --- EXEC / privileged transitions ---
  {
    pattern: "enable",
    modes: ["exec"],
    run: (s) => s.enter("privileged"),
  },
  {
    pattern: "disable",
    modes: ["privileged"],
    run: (s) => s.enter("exec"),
  },
  {
    pattern: "configure terminal",
    modes: ["privileged"],
    run: (s) => s.enter("config"),
  },
  {
    pattern: "exit",
    modes: ["privileged"],
    run: (s) => s.enter("exec"),
  },
  {
    pattern: "exit",
    modes: ["exec"],
    run: () => "",
  },

  // --- leaving configuration sub-modes ---
  {
    pattern: "exit",
    modes: ["config"],
    run: (s) => s.enter("privileged"),
  },
  {
    pattern: "exit",
    modes: ["config-if", "config-vlan"],
    run: (s) => s.enter("config"),
  },
  {
    pattern: "end",
    modes: ["config", "config-if", "config-vlan"],
    run: (s) => s.enter("privileged"),
  },

  // --- global configuration ---
  {
    pattern: "hostname {name}",
    modes: ["config"],
    run: (s, p) => s.device.rename(p.name!),
  },
  {
    pattern: "interface {spec...}",
    usage: "interface <interface-name>",
    modes: ["config"],
    run: (s, p) => {
      const resolved = resolveInterface(s.device, p.spec!);
      if (!resolved) throw new ValidationError(`Invalid interface ${p.spec}`);
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
      };
      s.enter("config-if");
    },
  },
  {
    pattern: "vlan {id}",
    modes: ["config"],
    device: "switch",
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
    run: (s, p) => {
      const network = parseIpv4(p.network!);
      const mask = parseIpv4(p.mask!);
      const nexthop = parseIpv4(p.nexthop!);
      if (isRouter(s.device)) s.device.addStaticRoute(network, mask, nexthop);
    },
  },
];
