import { type Device, EndHost, Layer3Switch, Router } from "@sim/sim-core";
import { InvalidModeError } from "../errors/errors";
import {
  showArp,
  showBridgeMacAddressTable,
  showInterfaces,
  showInterfacesTrunk,
  showIpInterfaceBrief,
  showIpRoute,
  showMacAddressTable,
  showRunningConfig,
  showVlanBrief,
} from "../formatter/show";
import type { CliMode } from "../session/mode";
import type { CommandSpec } from "../types";
import { isBridge, isEndHost, isRoutingDevice, isSwitch, parseIpv4 } from "./helpers";

const SHOW_MODES: CliMode[] = ["exec", "privileged"];

/** `show ...` commands and `ping`, valid in user/privileged EXEC. */
export const showCommands: CommandSpec[] = [
  {
    pattern: "show running-config",
    modes: SHOW_MODES,
    run: (s) => showRunningConfig(s.device),
  },
  {
    pattern: "show interfaces trunk",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["dot1q-trunk"],
    run: (s) => (isSwitch(s.device) ? showInterfacesTrunk(s.device) : ""),
  },
  {
    pattern: "show interfaces",
    modes: SHOW_MODES,
    run: (s) => showInterfaces(s.device),
  },
  {
    pattern: "show ip interface brief",
    modes: SHOW_MODES,
    run: (s) => showIpInterfaceBrief(s.device),
  },
  {
    pattern: "show ip route",
    modes: SHOW_MODES,
    device: "router",
    capabilities: ["ipv4-routing"],
    run: (s) => (isRoutingDevice(s.device) ? showIpRoute(s.device) : ""),
  },
  {
    pattern: "show vlan brief",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["vlan"],
    run: (s) => (isSwitch(s.device) ? showVlanBrief(s.device) : ""),
  },
  {
    pattern: "show mac address-table",
    modes: SHOW_MODES,
    device: "switch",
    capabilities: ["layer2-switching"],
    run: (s) => (isSwitch(s.device) ? showMacAddressTable(s.device) : ""),
  },
  {
    pattern: "show mac address-table",
    modes: SHOW_MODES,
    device: "bridge",
    capabilities: ["ethernet-bridge"],
    run: (s) => (isBridge(s.device) ? showBridgeMacAddressTable(s.device) : ""),
  },
  {
    pattern: "show arp",
    modes: SHOW_MODES,
    run: (s) => showArp(s.device),
  },
  {
    pattern: "ping {target}",
    usage: "ping <destination-ip>",
    modes: SHOW_MODES,
    run: (s, p) => runPing(s.device, s.engine, parseIpv4(p.target!)),
  },
  {
    pattern: "ipconfig",
    modes: SHOW_MODES,
    capabilities: ["ipv4-host"],
    run: (s) => showIpInterfaceBrief(s.device),
  },
  {
    pattern: "ipconfig /renew",
    modes: SHOW_MODES,
    capabilities: ["dhcp-client"],
    run: (s) => {
      if (!isEndHost(s.device)) return "";
      s.device.requestDhcp();
      s.engine.runUntilIdle();
      return showIpInterfaceBrief(s.device);
    },
  },
];

const PING_COUNT = 5;

function runPing(device: Device, engine: { runUntilIdle(): number }, target: string): string {
  if (!(device instanceof EndHost || device instanceof Router || device instanceof Layer3Switch)) {
    throw new InvalidModeError("ping is not supported by this device");
  }
  if (device instanceof EndHost && device.ip === undefined) {
    throw new InvalidModeError("no IP address configured on this host");
  }
  const baseSeq = device.pingResults.length;
  for (let i = 0; i < PING_COUNT; i++) device.ping(target, baseSeq + i);
  engine.runUntilIdle();

  const results = device.pingResults.slice(baseSeq, baseSeq + PING_COUNT);
  const marks = results.map((r) => (r.success ? "!" : ".")).join("");
  const ok = results.filter((r) => r.success).length;
  const rate = Math.round((ok / PING_COUNT) * 100);
  return [
    `Type escape sequence to abort.`,
    `Sending ${PING_COUNT}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
    marks,
    `Success rate is ${rate} percent (${ok}/${PING_COUNT})`,
  ].join("\n");
}
