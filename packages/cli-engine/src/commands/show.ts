import { EndHost, intToIp, Layer3Switch, Router } from "@sim/sim-core";
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
import type { CommandSpec, SessionApi } from "../types";
import { isBridge, isEndHost, isRoutingDevice, isSwitch, parseIpv4, parseIpv6 } from "./helpers";

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
    pattern: "show ipv6 interface brief",
    modes: SHOW_MODES,
    device: "router",
    run: (s) => {
      if (!isRoutingDevice(s.device)) return "";
      const rows = s.device.ipv6InterfaceSummaries();
      if (rows.length === 0) return "% No IPv6 interfaces.";
      return [
        "Interface       Status      IPv6 Address",
        ...rows.flatMap((row) => row.addresses.length === 0
          ? [`${row.name.padEnd(15)} ${(row.operUp ? "up" : "down").padEnd(11)} unassigned`]
          : row.addresses.map((address, index) =>
              `${(index === 0 ? row.name : "").padEnd(15)} ${(index === 0 ? (row.operUp ? "up" : "down") : "").padEnd(11)} ${address.address}/${address.prefixLength} (${address.source}, ${address.state})`)),
      ].join("\n");
    },
  },
  {
    pattern: "show ipv6 neighbors",
    modes: SHOW_MODES,
    device: "router",
    run: (s) => {
      if (!isRoutingDevice(s.device)) return "";
      const rows = s.device.ipv6NeighborEntries();
      if (rows.length === 0) return "% IPv6 neighbor table is empty.";
      return [
        "IPv6 Address                         MAC Address        Interface       State",
        ...rows.map((row) =>
          `${row.address.padEnd(36)} ${row.mac.padEnd(18)} ${row.interfaceName.padEnd(15)} ${row.state}`),
      ].join("\n");
    },
  },
  {
    pattern: "show ipv6 route",
    modes: SHOW_MODES,
    device: "router",
    run: (s) => {
      if (!isRoutingDevice(s.device)) return "";
      const rows = s.device.ipv6RoutingTable();
      if (rows.length === 0) return "% IPv6 routing table is empty.";
      return rows.map((row) => {
        const code = row.kind === "connected" ? "C" : row.kind === "static" ? "S" : "O";
        const via = row.viaIp ? ` via ${row.viaIp},` : "";
        return `${code}   ${row.network}/${row.prefixLength}${via} ${row.egressName}`;
      }).join("\n");
    },
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
      return runHostPing(s, p.target!);
    },
  },
  {
    pattern: "ping -6 {target}",
    usage: "ping -6 <ipv6-address-or-hostname>",
    modes: SHOW_MODES,
    device: "host",
    run: (s, p) => runHostPing6(s, p.target!),
  },
  {
    pattern: "ping -6 {target}",
    usage: "ping -6 <destination-ipv6>",
    modes: SHOW_MODES,
    device: "router",
    run: (s, p) => runPing6(s, parseIpv6(p.target!)),
  },
  {
    pattern: "ping {target}",
    usage: "ping <destination-ip>",
    modes: SHOW_MODES,
    device: "router",
    run: (s, p) => runPing(s, parseIpv4(p.target!)),
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
      const device = s.device;
      return s.runNetworkOperation(
        () => device.requestDhcp(),
        () => showIpconfig(device, false),
      );
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
      return runHostTracert(s, p.target!);
    },
  },
  {
    pattern: "tracert -6 {target}",
    usage: "tracert -6 <ipv6-address-or-hostname>",
    modes: SHOW_MODES,
    device: "host",
    run: (s, p) => runHostTracert6(s, p.target!),
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

function runPing(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost || device instanceof Router || device instanceof Layer3Switch)) {
    throw new InvalidModeError("ping is not supported by this device");
  }
  if (device instanceof EndHost && device.ip === undefined) {
    throw new InvalidModeError("no IP address configured on this host");
  }
  let baseSeq = device.pingResults.length;
  return session.runNetworkOperation(
    () => { baseSeq = schedulePings(device, target); },
    () => formatPing(device, target, baseSeq),
  );
}

function runHostPing(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost)) throw new InvalidModeError("ping requires an end host");
  let parsedTarget: string | undefined;
  try {
    parsedTarget = parseIpv4(target);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  if (parsedTarget) return runPing(session, parsedTarget);
  let requestId = -1;
  let resolvedAddress: string | undefined;
  let baseSeq = device.pingResults.length;
  return session.runNetworkOperation(
    () => { requestId = device.applications.resolveDns(target); },
    () => {
      if (!resolvedAddress) {
        const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
        if (result?.status !== "success" || !result.address) throw new ValidationError(`Could not find host ${target}.`);
        resolvedAddress = result.address;
        baseSeq = schedulePings(device, resolvedAddress);
        return undefined;
      }
      return formatPing(device, resolvedAddress, baseSeq);
    },
  );
}

function schedulePings(
  device: EndHost | Router | Layer3Switch,
  target: string,
): number {
  const baseSeq = device.pingResults.length;
  try {
    for (let i = 0; i < PING_COUNT; i++) device.ping(target, baseSeq + i);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : "Ping could not be started.");
  }
  return baseSeq;
}

function formatPing(
  device: EndHost | Router | Layer3Switch,
  target: string,
  baseSeq: number,
): string {
  const results = device.pingResults.slice(baseSeq, baseSeq + PING_COUNT);
  const marks = results.map((result) => (result.success ? "!" : ".")).join("");
  const ok = results.filter((result) => result.success).length;
  const rate = Math.round((ok / PING_COUNT) * 100);
  return [
    "Type escape sequence to abort.",
    `Sending ${PING_COUNT}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`,
    marks,
    `Success rate is ${rate} percent (${ok}/${PING_COUNT})`,
  ].join("\n");
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
  if (all) {
    const addresses = device.ipv6AddressSummaries();
    lines.push(
      "",
      `   IPv6 Mode. . . . . . . . . . . . : ${device.ipv6Mode.toUpperCase()}`,
      ...addresses.map((address) =>
        `   IPv6 Address. . . . . . . . . . . : ${address.address}/${address.prefixLength} (${address.source}, ${address.state})`),
      `   IPv6 Default Router. . . . . . . . : ${device.ipv6DefaultRouter ?? ""}`,
      `   IPv6 DNS Server . . . . . . . . . : ${device.ipv6DnsServer ?? ""}`,
      `   DHCPv6 State . . . . . . . . . . : ${device.dhcpv6State}`,
    );
  }
  return lines.join("\n");
}

function runPing6(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost || device instanceof Router || device instanceof Layer3Switch)) {
    throw new InvalidModeError("IPv6 ping is not supported by this device");
  }
  let baseSeq = device.ipv6PingResults.length;
  return session.runNetworkOperation(
    () => {
      baseSeq = device.ipv6PingResults.length;
      for (let index = 0; index < PING_COUNT; index++) device.ping6(target, baseSeq + index);
    },
    () => {
      const results = device.ipv6PingResults.slice(baseSeq, baseSeq + PING_COUNT);
      const ok = results.filter((result) => result.success).length;
      const marks = results.map((result) => result.success ? "!" : ".").join("");
      return [
        "Type escape sequence to abort.",
        `Sending ${PING_COUNT}, 100-byte ICMPv6 Echos to ${target}, timeout is 2 seconds:`,
        marks,
        `Success rate is ${Math.round((ok / PING_COUNT) * 100)} percent (${ok}/${PING_COUNT})`,
      ].join("\n");
    },
  );
}

function runHostPing6(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost)) throw new InvalidModeError("ping -6 requires an end host");
  try {
    return runPing6(session, parseIpv6(target));
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  let requestId = -1;
  let resolvedAddress: string | undefined;
  let baseSeq = device.ipv6PingResults.length;
  return session.runNetworkOperation(
    () => { requestId = device.applications.resolveDns(target); },
    () => {
      if (!resolvedAddress) {
        const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
        if (result?.status !== "success" || !result.address) throw new ValidationError(`Could not find host ${target}.`);
        resolvedAddress = parseIpv6(result.address);
        baseSeq = device.ipv6PingResults.length;
        for (let index = 0; index < PING_COUNT; index++) device.ping6(resolvedAddress, baseSeq + index);
        return undefined;
      }
      const results = device.ipv6PingResults.slice(baseSeq, baseSeq + PING_COUNT);
      const ok = results.filter((result) => result.success).length;
      return [
        "Type escape sequence to abort.",
        `Sending ${PING_COUNT}, 100-byte ICMPv6 Echos to ${resolvedAddress}, timeout is 2 seconds:`,
        results.map((result) => result.success ? "!" : ".").join(""),
        `Success rate is ${Math.round((ok / PING_COUNT) * 100)} percent (${ok}/${PING_COUNT})`,
      ].join("\n");
    },
  );
}

function runHostTracert6(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost)) throw new InvalidModeError("tracert -6 requires an end host");
  let destination: string | undefined;
  try {
    destination = parseIpv6(target);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  if (!destination) return runHostTracert6Hostname(session, device, target);
  return runTracert6(session, device, destination);
}

function runHostTracert6Hostname(session: SessionApi, device: EndHost, hostname: string): string {
  let requestId = -1;
  let destination: string | undefined;
  let sequence = device.ipv6PingResults.length;
  return session.runNetworkOperation(
    () => { requestId = device.applications.resolveDns(hostname); },
    () => {
      if (!destination) {
        const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
        if (result?.status !== "success" || !result.address) throw new ValidationError(`Could not find host ${hostname}.`);
        destination = parseIpv6(result.address);
        sequence = device.ipv6PingResults.length;
        device.ping6(destination, sequence);
        return undefined;
      }
      return formatTracert6(device, destination, sequence);
    },
  );
}

function runTracert6(session: SessionApi, device: EndHost, destination: string): string {
  let sequence = device.ipv6PingResults.length;
  return session.runNetworkOperation(
    () => {
      sequence = device.ipv6PingResults.length;
      device.ping6(destination, sequence);
    },
    () => formatTracert6(device, destination, sequence),
  );
}

function formatTracert6(device: EndHost, destination: string, sequence: number): string {
  const success = device.ipv6PingResults.some((result) => result.sequence === sequence && result.success);
  return [
    `Tracing route to ${destination} over a maximum of 30 hops`,
    "",
    success ? `  1    <1 ms    <1 ms    <1 ms  ${destination}` : "  1     *        *        *     Request timed out.",
    "",
    "Trace complete.",
  ].join("\n");
}

function runTracert(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost)) throw new InvalidModeError("tracert requires an end host");
  if (device.ip === undefined) throw new InvalidModeError("no IP address configured on this host");
  let sequence = device.pingResults.length;
  return session.runNetworkOperation(
    () => {
      sequence = device.pingResults.length;
      device.ping(target, sequence);
    },
    () => {
      const success = device.pingResults.slice(sequence).some((result) => result.sequence === sequence && result.success);
      return [
        `Tracing route to ${target} over a maximum of 30 hops`,
        "",
        success ? `  1    <1 ms    <1 ms    <1 ms  ${target}` : "  1     *        *        *     Request timed out.",
        "",
        "Trace complete.",
      ].join("\n");
    },
  );
}

function runHostTracert(session: SessionApi, target: string): string {
  const device = session.device;
  if (!(device instanceof EndHost)) throw new InvalidModeError("tracert requires an end host");
  let parsedTarget: string | undefined;
  try {
    parsedTarget = parseIpv4(target);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
  }
  if (parsedTarget) return runTracert(session, parsedTarget);
  let requestId = -1;
  let resolvedAddress: string | undefined;
  let sequence = device.pingResults.length;
  return session.runNetworkOperation(
    () => { requestId = device.applications.resolveDns(target); },
    () => {
      if (!resolvedAddress) {
        const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
        if (result?.status !== "success" || !result.address) throw new ValidationError(`Could not find host ${target}.`);
        resolvedAddress = result.address;
        sequence = device.pingResults.length;
        device.ping(resolvedAddress, sequence);
        return undefined;
      }
      return formatTracert(device, resolvedAddress, sequence);
    },
  );
}

function formatTracert(device: EndHost, target: string, sequence: number): string {
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
