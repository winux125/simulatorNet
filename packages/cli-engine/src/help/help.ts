import { nextTokens, resolveTokens } from "../parser/resolver";
import { commandsForMode } from "../commands/available";
import { isEndHost } from "../commands/helpers";
import type { CommandSpec, SessionApi } from "../types";

const ROOT_DESCRIPTIONS: Record<string, string> = {
  configure: "Enter configuration mode",
  description: "Set interface description",
  disable: "Return to user EXEC mode",
  enable: "Enter privileged EXEC mode",
  encapsulation: "Configure subinterface encapsulation",
  end: "Return to privileged EXEC mode",
  exit: "Exit the current mode",
  help: "Display available commands",
  hostname: "Set device hostname",
  interface: "Select an interface",
  ip: "Configure IP parameters",
  ipv6: "Configure IPv6 parameters",
  ipconfig: "Display or manage host IP configuration",
  arp: "Display the host ARP cache",
  netstat: "Display host transport connections",
  name: "Set VLAN name",
  nslookup: "Resolve a DNS hostname",
  no: "Negate a command",
  ping: "Send ICMP echo requests",
  sim: "SimulatorNet extensions (non-IOS)",
  show: "Display device information",
  shutdown: "Administratively disable an interface",
  switchport: "Configure Layer 2 interface settings",
  tracert: "Trace a route to an IP destination",
  vlan: "Configure a VLAN",
  "spanning-tree": "Configure PVST / Rapid-PVST spanning tree",
  "channel-group": "Add the interface to an EtherChannel",
  cdp: "Configure Cisco Discovery Protocol",
  lldp: "Configure Link Layer Discovery Protocol",
  router: "Enable an IP routing process",
  "router-id": "Set the OSPF router id",
  network: "Advertise a network into OSPF",
  "passive-interface": "Advertise the interface but send no hellos",
  clear: "Reset protocol runtime state",
  errdisable: "Recover an error-disabled interface",
  "class-map": "Define a QoS traffic class",
  "policy-map": "Define a QoS policy",
  class: "Select a class inside a policy map",
  match: "Add a class-map match rule",
  set: "Mark a packet field",
  priority: "Reserve strict-priority bandwidth",
  bandwidth: "Reserve a weighted bandwidth share",
  police: "Rate-limit a class with a token bucket",
  shape: "Delay a class to an average rate",
  "queue-limit": "Set the class tail-drop depth",
  "service-policy": "Attach a policy map to this interface",
};

const ARGUMENT_HELP: Record<string, string> = {
  ping: "<destination-ip>   IPv4 address to ping",
  "ping -6": "<ipv6-address-or-hostname>   IPv6 address or DNS hostname to ping",
  tracert: "<destination-ip>   IPv4 address to trace",
  "tracert -6": "<ipv6-address-or-hostname>   IPv6 address or DNS hostname to trace",
  interface: "<interface-name>   Interface to configure",
  "ip route": "<network> <mask> <next-hop>   Static route parameters",
  "ipv6 route": "<prefix>/<length> <next-hop>   Static IPv6 route parameters",
  "ipv6 router ospf": "<1-65535>   OSPFv3 process id (one process per device)",
  "ipv6 access-list": "<name>   Named IPv6 access list",
  nslookup: "<hostname> [dns-server]   Resolve an IPv4 A record",
  "sim http get": "<url>   HTTP URL with an IPv4 host",
  "sim tftp get": "<server-ip> <filename>   Download a file",
  "sim ntp query": "<server-ip>   Query virtual server time",
  "sim syslog send": "<server-ip> <severity> <message>   Send a structured log message",
  "router ospf": "<1-65535>   OSPF process id (one process per device)",
  "router-id": "<a.b.c.d>   OSPF router id",
  "passive-interface": "<interface-name>   Interface to advertise without hellos",
  "interface range": "<first> - <last>   Configure several interfaces at once",
  "interface loopback": "<0-2147483647>   Logical interface with no cable",
  "channel-group": "<1-64> mode on|active|passive|desirable|auto",
};

function available(session: SessionApi): CommandSpec[] {
  return commandsForMode(session, session.mode);
}

function patternParts(pattern: string): string[] {
  return pattern.split(" ");
}

function helpLabel(parts: string[]): string {
  return parts.join(" ").replace(/\{([^}.]+)(?:\.\.\.)?\}/g, "<$1>");
}

function lines(entries: Array<{ label: string; description?: string }>): string {
  const width = Math.max(...entries.map((entry) => entry.label.length), 0) + 3;
  return entries.map((entry) => `  ${entry.label.padEnd(width)}${entry.description ?? ""}`.trimEnd()).join("\n");
}

export function renderHelp(session: SessionApi, prefix: string[]): string {
  const commands = available(session);
  if (prefix.length === 0) {
    const roots = new Set(commands.map((command) => patternParts(command.pattern)[0]!));
    roots.add("help");
    return lines([...roots].map((label) => ({ label, description: ROOT_DESCRIPTIONS[label] })));
  }

  const resolved = resolveTokens(commands, prefix);
  if (resolved.error === "ambiguous") return `% Ambiguous command: "${prefix.join(" ")}"`;
  if (resolved.error === "invalid") return "% Invalid input detected at '^' marker.";
  const canonical = resolved.tokens;
  const key = canonical.join(" ");
  if (isEndHost(session.device) && key === "ping") {
    return lines([{ label: "<ip-or-hostname>", description: "IPv4 address or DNS hostname to ping" }]);
  }
  if (isEndHost(session.device) && key === "tracert") {
    return lines([{ label: "<ip-or-hostname>", description: "IPv4 address or DNS hostname to trace" }]);
  }
  if (key === "interface") {
    const entries = [...session.device.interfaces.keys()].map((label) => ({ label }));
    for (const token of nextTokens(resolved)) {
      if (!token.startsWith("{") && token !== "<cr>") entries.push({ label: token === "vlan" ? "vlan <1-4094>" : token });
    }
    return lines(entries);
  }
  const argument = ARGUMENT_HELP[key];
  if (argument) {
    const [label, ...description] = argument.split(/\s{3,}/);
    return lines([{ label: label!, description: description.join("   ") }]);
  }

  return lines(nextTokens(resolved).map((part) => ({ label: helpLabel([part]) })));
}
