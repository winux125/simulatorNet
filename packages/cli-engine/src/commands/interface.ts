import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import { isRouter, isSwitch, parseIpv4, parseVlanId, parseVlanList } from "./helpers";

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
      s.device.getInterface(requireCtx(s).physical)?.shutdown();
    },
  },
  {
    pattern: "no shutdown",
    modes: ["config-if"],
    run: (s) => {
      s.device.getInterface(requireCtx(s).physical)?.noShutdown();
    },
  },
  {
    pattern: "description {text...}",
    modes: ["config-if"],
    run: (s, p) => {
      s.device.getInterface(requireCtx(s).physical)?.setDescription(p.text!);
    },
  },

  // --- switch access/trunk ---
  {
    pattern: "switchport mode access",
    modes: ["config-if"],
    device: "switch",
    run: (s) => {
      if (isSwitch(s.device)) s.device.setPortModeAccess(requireCtx(s).physical);
    },
  },
  {
    pattern: "switchport access vlan {id}",
    modes: ["config-if"],
    device: "switch",
    run: (s, p) => {
      if (isSwitch(s.device)) s.device.setAccessVlan(requireCtx(s).physical, parseVlanId(p.id!));
    },
  },
  {
    pattern: "switchport mode trunk",
    modes: ["config-if"],
    device: "switch",
    run: (s) => {
      if (isSwitch(s.device)) s.device.setPortModeTrunk(requireCtx(s).physical);
    },
  },
  {
    pattern: "switchport trunk native vlan {id}",
    modes: ["config-if"],
    device: "switch",
    run: (s, p) => {
      if (isSwitch(s.device)) s.device.setTrunkNativeVlan(requireCtx(s).physical, parseVlanId(p.id!));
    },
  },
  {
    pattern: "switchport trunk allowed vlan {list...}",
    modes: ["config-if"],
    device: "switch",
    run: (s, p) => {
      if (isSwitch(s.device)) s.device.setTrunkAllowedVlans(requireCtx(s).physical, parseVlanList(p.list!));
    },
  },

  // --- router L3 addressing + subinterface encapsulation ---
  {
    pattern: "encapsulation dot1Q {vlan}",
    modes: ["config-if"],
    device: "router",
    run: (s, p) => setEncapsulation(s, p.vlan!, false),
  },
  {
    pattern: "encapsulation dot1Q {vlan} native",
    modes: ["config-if"],
    device: "router",
    run: (s, p) => setEncapsulation(s, p.vlan!, true),
  },
  {
    pattern: "ip address {ip} {mask}",
    modes: ["config-if"],
    device: "router",
    run: (s, p) => {
      const ctx = requireCtx(s);
      const ip = parseIpv4(p.ip!);
      const mask = parseIpv4(p.mask!);
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
];

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
