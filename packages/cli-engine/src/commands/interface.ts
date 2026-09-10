import { loopbackName, parsePortChannelName, tunnelName } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import {
  isLayer3Switch,
  isRouter,
  isRoutingDevice,
  isSwitch,
  parseIpv4,
  parseIpv6Prefix,
  parseVlanId,
  parseVlanList,
} from "./helpers";

function requireCtx(s: SessionApi) {
  if (!s.ifaceCtx) throw new InvalidModeError("No interface selected");
  return s.ifaceCtx;
}

/** Interface configuration mode (`config-if`), for switches and routers. */
export const interfaceCommands: CommandSpec[] = [
  // --- common to every device ---
  {
    pattern: "shutdown",
    modes: ["config-if"],
    run: (s) => {
      const ctx = requireCtx(s);
      if (ctx.sviVlan !== undefined && isLayer3Switch(s.device)) s.device.setSviAdminState(ctx.sviVlan, false);
      else if (ctx.sviVlan !== undefined && isSwitch(s.device)) s.device.setManagementSviAdminState(ctx.sviVlan, false);
      else s.device.getInterface(ctx.physical)?.shutdown();
    },
  },
  {
    negated: true, pattern: "shutdown",
    modes: ["config-if"],
    run: (s) => {
      const ctx = requireCtx(s);
      if (ctx.sviVlan !== undefined && isLayer3Switch(s.device)) s.device.setSviAdminState(ctx.sviVlan, true);
      else if (ctx.sviVlan !== undefined && isSwitch(s.device)) s.device.setManagementSviAdminState(ctx.sviVlan, true);
      else s.device.getInterface(ctx.physical)?.noShutdown();
    },
  },
  {
    pattern: "description {text...}",
    modes: ["config-if"],
    run: (s, p) => {
      const ctx = requireCtx(s);
      if (ctx.sviVlan !== undefined && isLayer3Switch(s.device)) s.device.setSviDescription(ctx.sviVlan, p.text!);
      else if (ctx.sviVlan !== undefined && isSwitch(s.device)) s.device.setManagementSviDescription(ctx.sviVlan, p.text!);
      else {
        // A Port-channel has no cable, so it is not in the physical interface
        // map: its description lives on the bundle itself and is pure metadata.
        const channelId = isSwitch(s.device) ? parsePortChannelName(ctx.physical) : undefined;
        if (channelId !== undefined && isSwitch(s.device)) s.device.etherChannel.setDescription(channelId, p.text!);
        else s.device.getInterface(ctx.physical)?.setDescription(p.text!);
      }
    },
  },
  {
    /** The L2 management SVI is addressable, but the switch never routes. */
    pattern: "ip address {ip} {mask}",
    modes: ["config-if"],
    device: "l2-switch",
    run: (s, p) => {
      const ctx = requireCtx(s);
      if (!isSwitch(s.device)) return;
      if (ctx.sviVlan === undefined) {
        throw new InvalidModeError("An L2 Switch is addressable only through its management VLAN interface");
      }
      s.device.setManagementSviIp(ctx.sviVlan, parseIpv4(p.ip!), parseIpv4(p.mask!));
    },
  },

  {
    negated: true, pattern: "description", modes: ["config-if"],
    run: (s) => interfaceCommands.find((c) => c.pattern === "description {text...}")!.run(s, { text: "" }),
  },
  {
    negated: true, pattern: "ip address", modes: ["config-if"], device: "managed",
    run: (s) => {
      const ctx = requireCtx(s);
      if (isSwitch(s.device) && !isLayer3Switch(s.device)) {
        if (ctx.sviVlan === undefined) throw new InvalidModeError("An L2 Switch is addressable only through its management VLAN interface");
        s.device.clearManagementSviIp(ctx.sviVlan);
      } else if (isRoutingDevice(s.device)) s.device.clearInterfaceIp(routedInterfaceName(s));
    },
  },
  {
    negated: true, pattern: "ipv6 address", modes: ["config-if"], device: "router",
    run: (s) => { if (isRoutingDevice(s.device)) s.device.clearInterfaceIpv6(routedInterfaceName(s)); },
  },
  {
    negated: true, pattern: "switchport access vlan", modes: ["config-if"], device: "switch",
    capabilities: ["vlan"],
    run: (s) => { const port = requireSwitchport(s); if (isSwitch(s.device)) s.device.setAccessVlan(port, 1); },
  },
  {
    negated: true, pattern: "switchport trunk native vlan", modes: ["config-if"], device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s) => { const port = requireSwitchport(s); if (isSwitch(s.device)) s.device.setTrunkNativeVlan(port, 1); },
  },
  ...(["add", "remove"] as const).map((modifier): CommandSpec => ({
    pattern: `switchport trunk allowed vlan ${modifier} {list...}`, modes: ["config-if"], device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s, p) => {
      const port = requireSwitchport(s);
      const requested = parseVlanList(p.list!);
      if (!isSwitch(s.device)) return;
      const vlans = new Set(s.device.portConfigOf(port).allowedVlans ?? Array.from({ length: 4094 }, (_, i) => i + 1));
      for (const vlan of requested) { if (modifier === "add") vlans.add(vlan); else vlans.delete(vlan); }
      s.device.setTrunkAllowedVlans(port, vlans);
    },
  })),

  // --- switch access/trunk ---
  {
    pattern: "switchport mode access",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => {
      const port = requireSwitchport(s);
      if (isSwitch(s.device)) s.device.setPortModeAccess(port);
    },
  },
  {
    pattern: "switchport access vlan {id}",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["vlan"],
    run: (s, p) => {
      const port = requireSwitchport(s);
      if (isSwitch(s.device)) s.device.setAccessVlan(port, parseVlanId(p.id!));
    },
  },
  {
    pattern: "switchport mode trunk",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s) => {
      const port = requireSwitchport(s);
      if (isSwitch(s.device)) s.device.setPortModeTrunk(port);
    },
  },
  {
    pattern: "switchport trunk native vlan {id}",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s, p) => {
      const port = requireSwitchport(s);
      if (isSwitch(s.device)) s.device.setTrunkNativeVlan(port, parseVlanId(p.id!));
    },
  },
  {
    pattern: "switchport trunk allowed vlan {list...}",
    modes: ["config-if"],
    device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s, p) => {
      const port = requireSwitchport(s);
      if (isSwitch(s.device)) s.device.setTrunkAllowedVlans(port, parseVlanList(p.list!));
    },
  },
  {
    negated: true, pattern: "switchport",
    modes: ["config-if"],
    device: "l3-switch",
    run: (s) => {
      const ctx = requireCtx(s);
      if (ctx.sviVlan !== undefined) throw new InvalidModeError("no switchport is only valid on a physical interface");
      if (isLayer3Switch(s.device)) s.device.setPortRouted(ctx.physical, true);
    },
  },
  {
    pattern: "switchport",
    modes: ["config-if"],
    device: "l3-switch",
    run: (s) => {
      const ctx = requireCtx(s);
      if (ctx.sviVlan !== undefined) throw new InvalidModeError("switchport is only valid on a physical interface");
      if (isLayer3Switch(s.device)) s.device.setPortRouted(ctx.physical, false);
    },
  },

  // --- router L3 addressing + subinterface encapsulation ---
  {
    pattern: "encapsulation dot1Q {vlan}",
    modes: ["config-if"],
    device: "router",
    capabilities: ["router-subinterfaces"],
    run: (s, p) => setEncapsulation(s, p.vlan!, false),
  },
  {
    pattern: "encapsulation dot1Q {vlan} native",
    modes: ["config-if"],
    device: "router",
    capabilities: ["router-subinterfaces"],
    run: (s, p) => setEncapsulation(s, p.vlan!, true),
  },
  {
    pattern: "ip address {ip} {mask}",
    modes: ["config-if"],
    device: "router",
    capabilities: ["ipv4-routing"],
    run: (s, p) => {
      const ctx = requireCtx(s);
      const ip = parseIpv4(p.ip!);
      const mask = parseIpv4(p.mask!);
      if (isLayer3Switch(s.device)) {
        if (ctx.sviVlan !== undefined) s.device.setSviIp(ctx.sviVlan, ip, mask);
        else {
          if (!s.device.isRoutedPort(ctx.physical)) throw new InvalidModeError("Use 'no switchport' before assigning an IP address");
          s.device.configureRoutedInterface(ctx.physical, ip, mask);
        }
        return;
      }
      if (!isRouter(s.device)) return;
      if (ctx.isSubinterface) {
        if (!ctx.subCreated || ctx.subVlan === undefined) {
          throw new ValidationError("Configure 'encapsulation dot1Q' before an IP address");
        }
        s.device.setInterfaceIp(`${ctx.physical}.${ctx.subVlan}`, ip, mask);
      } else {
        s.device.setInterfaceIp(ctx.physical, ip, mask);
      }
    },
  },
  {
    pattern: "ipv6 enable",
    modes: ["config-if"],
    device: "router",
    run: (s) => {
      if (isRoutingDevice(s.device)) s.device.enableInterfaceIpv6(routedInterfaceName(s));
    },
  },
  {
    pattern: "ipv6 address {prefix}",
    usage: "ipv6 address <address>/<prefix-length>",
    modes: ["config-if"],
    device: "router",
    run: (s, p) => {
      const address = parseIpv6Prefix(p.prefix!);
      if (isRoutingDevice(s.device)) {
        s.device.setInterfaceIpv6(routedInterfaceName(s), address.network, address.prefixLength);
      }
    },
  },
];

function routedInterfaceName(s: SessionApi): string {
  const ctx = requireCtx(s);
  if (ctx.loopback !== undefined) return loopbackName(ctx.loopback);
  if (ctx.tunnel !== undefined) return tunnelName(ctx.tunnel);
  if (ctx.sviVlan !== undefined) return `Vlan${ctx.sviVlan}`;
  if (ctx.isSubinterface) {
    if (!ctx.subCreated || ctx.subVlan === undefined) {
      throw new ValidationError("Configure 'encapsulation dot1Q' before IPv6 addressing");
    }
    return `${ctx.physical}.${ctx.subVlan}`;
  }
  if (isLayer3Switch(s.device) && !s.device.isRoutedPort(ctx.physical)) {
    throw new InvalidModeError("Use 'no switchport' before assigning an IPv6 address");
  }
  return ctx.physical;
}

function requireSwitchport(s: SessionApi): string {
  const ctx = requireCtx(s);
  if (ctx.sviVlan !== undefined) throw new InvalidModeError("switchport commands are not valid on an SVI");
  if (isLayer3Switch(s.device) && s.device.isRoutedPort(ctx.physical)) {
    throw new InvalidModeError("This interface is a routed port; use 'switchport' first");
  }
  return ctx.physical;
}

function setEncapsulation(s: SessionApi, vlanToken: string, native: boolean): void {
  const ctx = requireCtx(s);
  if (!ctx.isSubinterface) {
    throw new InvalidModeError("encapsulation is only valid on a subinterface");
  }
  const vlan = parseVlanId(vlanToken);
  if (isRouter(s.device)) s.device.getOrCreateSubinterface(ctx.physical, vlan, native);
  ctx.subVlan = vlan;
  ctx.subCreated = true;
  ctx.label = `${ctx.physical}.${vlan}`;
}
