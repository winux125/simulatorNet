import { loopbackName, portChannelName, tunnelName } from "@sim/sim-core";
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
  parseIpv6,
  parseIpv6Prefix,
  parseVlanId,
  resolveInterface,
} from "./helpers";

/** A fresh `config-if` context with every logical selector cleared. */
function interfaceContext(
  physical: string,
  overrides: Partial<import("../types").InterfaceContext> = {},
): import("../types").InterfaceContext {
  return {
    physical,
    isSubinterface: false,
    label: physical,
    subVlan: undefined,
    subCreated: false,
    sviVlan: undefined,
    loopback: undefined,
    tunnel: undefined,
    range: undefined,
    ...overrides,
  };
}

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
    session.ifaceCtx = interfaceContext(loopbackName(id), { loopback: id });
    session.enter("config-if");
    return true;
  }
  // A GRE tunnel is logical too: it has no cable, so it is recognised here
  // rather than through the physical interface map.
  const tunnel = /^tu(?:nnel)?(\d+)$/i.exec(compact);
  if (tunnel && isRouter(session.device) && session.device.supportsTunnels()) {
    const id = Number(tunnel[1]);
    session.device.getOrCreateTunnel(id);
    session.ifaceCtx = interfaceContext(tunnelName(id), { tunnel: id });
    session.enter("config-if");
    return true;
  }
  const channel = /^po(?:rt-channel)?(\d+)$/i.exec(compact);
  if (channel && isSwitch(session.device)) {
    const id = Number(channel[1]);
    if (!session.device.etherChannel.hasChannel(id)) {
      throw new ValidationError(`Port-channel${id} does not exist; add a member with 'channel-group ${id} mode ...' first.`);
    }
    session.ifaceCtx = interfaceContext(portChannelName(id));
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
    modes: [
      "config-if", "config-vlan", "config-acl", "config-line", "config-aaa-server",
      "config-cmap", "config-pmap", "config-router", "config-route-map",
      "config-vrf", "config-nve", "config-vlan-config", "config-evpn", "config-evpn-es",
      "config-ikev2-proposal", "config-ikev2-peer", "config-ipsec-profile",
    ],
    device: "network",
    run: (s) => s.enter("config"),
  },
  // A VNI sub-mode exits back into the block that owns it, not to global config.
  {
    pattern: "exit",
    modes: ["config-nve-vni"],
    device: "network",
    run: (s) => s.enter("config-nve"),
  },
  {
    pattern: "exit",
    modes: ["config-evpn-vni"],
    device: "network",
    run: (s) => s.enter("config-evpn"),
  },
  {
    pattern: "exit-address-family",
    modes: ["config-router"],
    device: "router",
    run: (s) => {
      if (s.routerCtx?.family !== "bgp" || s.routerCtx.addressFamily === undefined) {
        throw new InvalidModeError("No BGP address-family is selected");
      }
      s.routerCtx.addressFamily = undefined;
      s.routerCtx.vrfId = undefined;
    },
  },
  // A policy-map class exits back into its policy map, not to global config.
  {
    pattern: "exit",
    modes: ["config-pmap-c"],
    device: "network",
    run: (s) => s.enter("config-pmap"),
  },
  {
    pattern: "end",
    modes: [
      "config", "config-if", "config-vlan", "config-acl", "config-line", "config-aaa-server",
      "config-cmap", "config-pmap", "config-pmap-c", "config-router", "config-route-map",
      "config-vrf", "config-nve", "config-nve-vni", "config-vlan-config",
      "config-evpn", "config-evpn-vni", "config-evpn-es",
      "config-ikev2-proposal", "config-ikev2-peer", "config-ipsec-profile",
    ],
    device: "network",
    run: (s) => s.enter("privileged"),
  },

  // --- global configuration ---
  {
    pattern: "vrf definition {name}",
    usage: "vrf definition <name>",
    modes: ["config"],
    device: "router",
    run: (s, p) => {
      if (!isRouter(s.device)) throw new InvalidModeError("VRF configuration is supported only on a Router");
      const existing = s.device.vrfConfigurations().find((vrf) => vrf.name === p.name || vrf.id === p.name);
      s.vrfCtx = {
        id: existing?.id ?? p.name!,
        name: existing?.name ?? p.name!,
        routeDistinguisher: existing?.routeDistinguisher,
      };
      s.enter("config-vrf");
    },
  },
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
    device: "switch",
    run: (s, p) => {
      const vlanId = parseVlanId(p.id!);
      // An L3 switch gets a routed SVI; an L2 switch gets its single
      // management interface, which terminates traffic but never routes it.
      if (isLayer3Switch(s.device)) s.device.defineSvi(vlanId);
      else if (isSwitch(s.device)) s.device.defineManagementSvi(vlanId);
      else return;
      s.ifaceCtx = interfaceContext(`Vlan${vlanId}`, { sviVlan: vlanId });
      s.enter("config-if");
    },
  },
  {
    pattern: "interface tunnel {id}",
    usage: "interface tunnel <0-2147483647>",
    modes: ["config"],
    device: "router",
    capabilities: ["vpn-tunnel"],
    run: (s, p) => {
      const id = Number(p.id!);
      if (!Number.isInteger(id) || id < 0) throw new ValidationError("Tunnel number must be a non-negative integer.");
      if (!isRouter(s.device) || !s.device.supportsTunnels()) {
        throw new InvalidModeError("GRE tunnels require a Router or a Firewall");
      }
      s.device.getOrCreateTunnel(id);
      s.ifaceCtx = interfaceContext(tunnelName(id), { tunnel: id });
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
      s.ifaceCtx = interfaceContext(loopbackName(id), { loopback: id });
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
      s.ifaceCtx = interfaceContext(ports[0]!, {
        label: `range ${ports[0]} - ${ports.at(-1)}`,
        range: ports,
      });
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
      s.ifaceCtx = interfaceContext(resolved.physical, {
        isSubinterface: isSub,
        label: resolved.subLabel,
      });
      s.enter("config-if");
    },
  },
  {
    pattern: "router bgp {asn}",
    usage: "router bgp <1-4294967295>",
    modes: ["config"],
    device: "ospf",
    capabilities: ["ipv4-routing"],
    run: (s, p) => {
      const asn = Number(p.asn!);
      if (!Number.isInteger(asn) || asn < 1 || asn > 4_294_967_295) {
        throw new ValidationError("BGP autonomous system number must be between 1 and 4294967295.");
      }
      if (!isOspfDevice(s.device)) throw new InvalidModeError("BGP requires a Router or an L3 Switch");
      if (isLayer3Switch(s.device) && !s.device.ipRoutingEnabled) {
        throw new ValidationError("Enable 'ip routing' before configuring BGP on an L3 Switch.");
      }
      const current = s.device.bgp.configurationSnapshot();
      s.device.bgp.configure({ ...(current ?? { neighbors: [], networks: [] }), localAs: asn });
      s.routerCtx = { processId: asn, family: "bgp" };
      s.enter("config-router");
    },
  },
  {
    pattern: "no router bgp {asn}",
    modes: ["config"],
    device: "ospf",
    run: (s) => { if (isOspfDevice(s.device)) s.device.bgp.disable(); },
  },
  {
    pattern: "route-map {name} {action} {sequence}",
    usage: "route-map <name> permit|deny <sequence>",
    modes: ["config"],
    device: "ospf",
    run: (s, p) => {
      const action = p.action?.toLowerCase();
      const sequence = Number(p.sequence);
      if (action !== "permit" && action !== "deny") throw new ValidationError("Route-map action must be permit or deny.");
      if (!Number.isInteger(sequence) || sequence < 1) throw new ValidationError("Route-map sequence must be a positive integer.");
      s.routeMapCtx = { id: p.name!, sequence, action };
      s.enter("config-route-map");
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
      s.routerCtx = { processId, family: "ipv4" };
      s.enter("config-router");
    },
  },
  {
    pattern: "ipv6 router ospf {process}",
    usage: "ipv6 router ospf <1-65535>",
    modes: ["config"],
    device: "ospf",
    run: (s, p) => {
      const processId = Number(p.process!);
      if (!Number.isInteger(processId) || processId < 1 || processId > 65_535) {
        throw new ValidationError("OSPFv3 process id must be between 1 and 65535.");
      }
      if (!isOspfDevice(s.device)) throw new InvalidModeError("OSPFv3 requires a Router or an L3 Switch");
      s.device.ospfv3.createProcess(processId);
      s.routerCtx = { processId, family: "ipv6" };
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
    pattern: "ipv6 unicast-routing",
    modes: ["config"],
    device: "router",
    run: (s) => {
      if (isLayer3Switch(s.device)) s.device.setIpv6Routing(true);
      else if (isRouter(s.device)) s.device.setIpv6ForwardingEnabled(true);
    },
  },
  {
    pattern: "no ipv6 unicast-routing",
    modes: ["config"],
    device: "router",
    run: (s) => {
      if (isLayer3Switch(s.device)) s.device.setIpv6Routing(false);
      else if (isRouter(s.device)) s.device.setIpv6ForwardingEnabled(false);
    },
  },
  {
    pattern: "ipv6 route {prefix} {nexthop}",
    usage: "ipv6 route <network>/<prefix-length> <next-hop>",
    modes: ["config"],
    device: "router",
    run: (s, p) => {
      const prefix = parseIpv6Prefix(p.prefix!);
      if (isRoutingDevice(s.device)) {
        s.device.addIpv6StaticRoute(prefix.network, prefix.prefixLength, parseIpv6(p.nexthop!));
      }
    },
  },
  {
    pattern: "no ip routing",
    modes: ["config"],
    device: "l3-switch",
    capabilities: ["ipv4-routing"],
    run: (s) => {
      if (!isLayer3Switch(s.device)) return;
      if (s.device.bgp.enabled) {
        throw new ValidationError("Remove the BGP process before disabling IP routing.");
      }
      s.device.setIpRouting(false);
    },
  },
];
