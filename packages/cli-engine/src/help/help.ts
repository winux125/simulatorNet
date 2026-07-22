import { allCommands } from "../commands";
import { deviceMatches } from "../commands/helpers";
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
  ipconfig: "Display or renew host IPv4 configuration",
  name: "Set VLAN name",
  no: "Negate a command",
  ping: "Send ICMP echo requests",
  show: "Display device information",
  shutdown: "Administratively disable an interface",
  switchport: "Configure Layer 2 interface settings",
  vlan: "Configure a VLAN",
};

const ARGUMENT_HELP: Record<string, string> = {
  ping: "<destination-ip>   IPv4 address to ping",
  interface: "<interface-name>   Interface to configure",
  "ip route": "<network> <mask> <next-hop>   Static route parameters",
};

function available(session: SessionApi): CommandSpec[] {
  return allCommands.filter((command) => command.modes.includes(session.mode)
    && deviceMatches(command.device, session.device)
    && (command.capabilities?.every((capability) => session.device.hasCapability(capability)) ?? true));
}

function patternParts(pattern: string): string[] {
  return pattern.split(" ");
}

function matchesPrefix(pattern: string, prefix: string[]): boolean {
  const parts = patternParts(pattern);
  return prefix.every((token, index) => {
    const part = parts[index];
    if (!part) return false;
    return part.startsWith("{") || part.toLowerCase() === token.toLowerCase();
  });
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

  const key = prefix.join(" ").toLowerCase();
  if (key === "interface") {
    const entries = [...session.device.interfaces.keys()].map((label) => ({ label }));
    if (session.device.hasCapability("svi")) entries.push({ label: "vlan <1-4094>" });
    return lines(entries);
  }
  const argument = ARGUMENT_HELP[key];
  if (argument) {
    const [label, ...description] = argument.split(/\s{3,}/);
    return lines([{ label: label!, description: description.join("   ") }]);
  }

  const seen = new Set<string>();
  const entries: Array<{ label: string }> = [];
  for (const command of commands) {
    if (!matchesPrefix(command.pattern, prefix)) continue;
    const remainder = patternParts(command.pattern).slice(prefix.length);
    if (remainder.length === 0) continue;
    const label = helpLabel(remainder);
    if (!seen.has(label)) {
      seen.add(label);
      entries.push({ label });
    }
  }
  return entries.length > 0 ? lines(entries) : "% No help available for this prefix.";
}
