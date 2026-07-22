import { Pc } from "@sim/sim-core";
import { InvalidModeError } from "../errors/errors";
import {
  showArp,
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
import { isRouter, isSwitch, parseIpv4 } from "./helpers";

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
    run: (s) => (isRouter(s.device) ? showIpRoute(s.device) : ""),
  },
  {
    pattern: "show vlan brief",
    modes: SHOW_MODES,
    device: "switch",
    run: (s) => (isSwitch(s.device) ? showVlanBrief(s.device) : ""),
  },
  {
    pattern: "show mac address-table",
    modes: SHOW_MODES,
    device: "switch",
    run: (s) => (isSwitch(s.device) ? showMacAddressTable(s.device) : ""),
  },
  {
    pattern: "show arp",
    modes: SHOW_MODES,
    run: (s) => showArp(s.device),
  },
  {
    pattern: "ping {target}",
    modes: SHOW_MODES,
    run: (s, p) => runPing(s.device, s.engine, parseIpv4(p.target!)),
  },
];

const PING_COUNT = 5;

function runPing(device: Pc | unknown, engine: { runUntilIdle(): number }, target: string): string {
  if (!(device instanceof Pc)) {
    throw new InvalidModeError("ping is only supported from a PC in this build");
  }
  if (device.ip === undefined) {
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
