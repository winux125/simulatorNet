import { type Device, EndHost, intToIp, Layer3Switch, Router } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
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
    device: "network",
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
    device: "network",
    run: (s) => showInterfaces(s.device),
  },
  {
    pattern: "show ip interface brief",
    modes: SHOW_MODES,
    device: "switch",
    run: (s) => showIpInterfaceBrief(s.device),
  },
  {
    pattern: "show ip interface brief",
    modes: SHOW_MODES,
    device: "router",
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
    device: "router",
    run: (s) => showArp(s.device),
  },
  {
    pattern: "ping {target}",
    usage: "ping <ip-or-hostname>",
    modes: SHOW_MODES,
    device: "host",
    run: (s, p) => {
      if (!isEndHost(s.device)) return "";
      return runPing(s.device, s.engine, resolveHostTarget(s.device, s.engine, p.target!));
    },
  },
  {
    pattern: "ping {target}",
    usage: "ping <destination-ip>",
    modes: SHOW_MODES,
    device: "router",
    run: (s, p) => runPing(s.device, s.engine, parseIpv4(p.target!)),
  },
  {
    pattern: "ipconfig",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["ipv4-host"],
    run: (s) => isEndHost(s.device) ? showIpconfig(s.device, false) : "",
  },
  {
    pattern: "ipconfig /all",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["ipv4-host"],
    run: (s) => isEndHost(s.device) ? showIpconfig(s.device, true) : "",
  },
  {
    pattern: "ipconfig /renew",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["dhcp-client"],
    run: (s) => {
      if (!isEndHost(s.device)) return "";
      s.device.requestDhcp();
      s.engine.runUntilIdle();
      return showIpconfig(s.device, false);
    },
  },
  {
    pattern: "ipconfig /release",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["dhcp-client"],
    run: (s) => {
      if (!isEndHost(s.device)) return "";
      s.device.setDhcpEnabled(true);
      return "Windows IP Configuration\n\nIP address successfully released.";
    },
  },
  {
    pattern: "arp -a",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["ipv4-host"],
    run: (s) => showArp(s.device),
  },
  {
    pattern: "tracert {target}",
    usage: "tracert <ip-or-hostname>",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["ipv4-host"],
    run: (s, p) => {
      if (!isEndHost(s.device)) return "";
      return runTracert(s.device, s.engine, resolveHostTarget(s.device, s.engine, p.target!));
    },
  },
  {
    pattern: "netstat",
    modes: SHOW_MODES,
    device: "host",
    capabilities: ["ipv4-host"],
    run: (s) => isEndHost(s.device) ? showNetstat(s.device) : "",
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
  try {
    for (let i = 0; i < PING_COUNT; i++) device.ping(target, baseSeq + i);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Ping could not be started.");
  }
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

function resolveHostTarget(device: EndHost, engine: { runUntilIdle(): number }, target: string): string {
  try {
    return parseIpv4(target);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  const requestId = device.applications.resolveDns(target);
  engine.runUntilIdle();
  const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
  if (result?.status === "success" && result.address) return result.address;
  throw new ValidationError(`Could not find host ${target}.`);
}

function showIpconfig(device: EndHost, all: boolean): string {
  const lines = [
    "Windows IP Configuration",
    "",
  ];
  if (all) {
    lines.push(
      `   Host Name . . . . . . . . . . . . : ${device.name}`,
      `   DHCP Enabled. . . . . . . . . . . : ${device.dhcpEnabled ? "Yes" : "No"}`,
      `   DNS Servers . . . . . . . . . . . : ${device.applications.dnsServer ?? ""}`,
      "",
    );
  }
  lines.push(
    `Ethernet adapter ${device.primary.name}:`,
    "",
    `   IPv4 Address. . . . . . . . . . . : ${device.ip ?? "0.0.0.0"}`,
    `   Subnet Mask . . . . . . . . . . . : ${intToIp(device.maskInt)}`,
    `   Default Gateway . . . . . . . . . : ${device.gateway ?? ""}`,
  );
  return lines.join("\n");
}

function runTracert(device: Device, engine: { runUntilIdle(): number }, target: string): string {
  if (!(device instanceof EndHost)) throw new InvalidModeError("tracert requires an end host");
  if (device.ip === undefined) throw new InvalidModeError("no IP address configured on this host");
  const sequence = device.pingResults.length;
  device.ping(target, sequence);
  engine.runUntilIdle();
  const success = device.pingResults.slice(sequence).some((result) => result.sequence === sequence && result.success);
  return [
    `Tracing route to ${target} over a maximum of 30 hops`,
    "",
    success ? `  1    <1 ms    <1 ms    <1 ms  ${target}` : "  1     *        *        *     Request timed out.",
    "",
    "Trace complete.",
  ].join("\n");
}

function showNetstat(device: EndHost): string {
  const rows = [
    ...device.transport.tcp.inspect().map((entry) =>
      `  TCP    ${entry.localAddress}:${entry.localPort}    ${entry.remotePort === 0 ? "*:*" : `${entry.remoteAddress}:${entry.remotePort}`}    ${entry.state}`),
    ...device.transport.udp.inspect().map((entry) =>
      `  UDP    ${entry.localAddress ?? "0.0.0.0"}:${entry.localPort}    *:*`),
  ];
  return ["Active Connections", "", "  Proto  Local Address          Foreign Address        State", ...rows].join("\n");
}
