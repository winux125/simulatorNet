import { EndHost, L2Switch, Layer3Switch, Router, type RemoteAccessState } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi, VtyLineContext } from "../types";
import type { RemoteSessionProtocol, RemoteSessionRequest } from "../session/remote";
import { CliSession } from "../session/session";
import { parseIpv4 } from "./helpers";

const EXEC_MODES = ["exec", "privileged"] as const;

function requireCliSession(session: SessionApi): CliSession {
  if (!(session instanceof CliSession)) {
    throw new InvalidModeError("Remote management requires an interactive session");
  }
  return session;
}

function openRemote(session: SessionApi, request: RemoteSessionRequest): string {
  if (!(session.device instanceof EndHost)) {
    throw new InvalidModeError("This command requires a PC, Laptop or Server");
  }
  return requireCliSession(session).openRemoteSession(request);
}

/** Remote-access configuration lives on Router, Firewall, L2 Switch and L3 Switch. */
function remoteAccessOf(session: SessionApi): RemoteAccessState {
  const device = session.device;
  if (device instanceof L2Switch || device instanceof Router) return device.remoteAccess;
  throw new InvalidModeError("This command requires a Router, Switch or Firewall");
}

/** The management SVI is an L2-switch feature; an L3 switch uses routed SVIs. */
function managementSwitch(session: SessionApi): L2Switch {
  const device = session.device;
  if (device instanceof Layer3Switch || !(device instanceof L2Switch)) {
    throw new InvalidModeError("A management SVI is configured on an L2 Switch");
  }
  return device;
}

function lineSelection(session: SessionApi): VtyLineContext {
  const context = session.lineCtx;
  if (!context) throw new InvalidModeError("Select a VTY range first with `line vty <first> <last>`");
  return context;
}

export const managementCommands: CommandSpec[] = [
  // --- host remote-CLI clients ---------------------------------------------
  {
    pattern: "telnet {target}",
    usage: "telnet <ip-or-hostname> [port]",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => openRemote(session, remote("telnet", params.target!)),
  },
  {
    pattern: "telnet {target} {port}",
    usage: "telnet <ip-or-hostname> [port]",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => openRemote(session, remote("telnet", params.target!, undefined, parsePort(params.port!))),
  },
  {
    pattern: "ssh {target}",
    usage: "ssh <username>@<ip-or-hostname>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => {
      const { username, target } = splitUserTarget(params.target!);
      return openRemote(session, remote("ssh", target, username));
    },
  },
  {
    pattern: "ssh -l {username} {target}",
    usage: "ssh -l <username> <ip-or-hostname>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => openRemote(session, remote("ssh", params.target!, params.username!)),
  },
  {
    pattern: "ssh -l {username} {target} {port}",
    usage: "ssh -l <username> <ip-or-hostname> [port]",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) =>
      openRemote(session, remote("ssh", params.target!, params.username!, parsePort(params.port!))),
  },

  // --- L2 management SVI ----------------------------------------------------
  // `interface vlan <id>` itself lives with the other interface-selection
  // commands; only the L2-specific default gateway is configured here.
  {
    pattern: "ip default-gateway {address}",
    usage: "ip default-gateway <ip>",
    modes: ["config"],
    device: "switch",
    run: (session, params) => {
      managementSwitch(session).setManagementDefaultGateway(parseIpv4(params.address!));
      return "";
    },
  },
  {
    pattern: "no ip default-gateway",
    modes: ["config"],
    device: "switch",
    run: (session) => {
      managementSwitch(session).setManagementDefaultGateway(undefined);
      return "";
    },
  },

  // --- simulated SSH server -------------------------------------------------
  {
    pattern: "ip domain-name {name}",
    usage: "ip domain-name <name>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      if (!/^[a-z0-9][a-z0-9.-]{0,127}$/iu.test(params.name!)) throw new ValidationError("Invalid domain name.");
      remoteAccessOf(session).setDomainName(params.name!);
      return "";
    },
  },
  {
    pattern: "no ip domain-name",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      remoteAccessOf(session).setDomainName(undefined);
      return "";
    },
  },
  {
    pattern: "ip ssh version {version}",
    usage: "ip ssh version 2",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      if (params.version !== "2") throw new ValidationError("Only simulated SSH version 2 is supported.");
      remoteAccessOf(session).setSshVersion(2);
      return "";
    },
  },
  {
    pattern: "crypto key generate rsa modulus {bits}",
    usage: "crypto key generate rsa modulus <360-4096>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => generateHostKey(session, Number(params.bits)),
  },
  {
    pattern: "crypto key generate rsa",
    modes: ["config"],
    device: "managed",
    run: (session) => generateHostKey(session, 1_024),
  },
  {
    pattern: "crypto key zeroize rsa",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      remoteAccessOf(session).clearHostKey();
      return "";
    },
  },

  // --- VTY lines ------------------------------------------------------------
  {
    pattern: "line vty {first} {last}",
    usage: "line vty <first> <last>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      const selection = { first: parseLineIndex(params.first!), last: parseLineIndex(params.last!) };
      if (selection.first > selection.last) throw new ValidationError("The first VTY line must not exceed the last.");
      remoteAccessOf(session).selectRange(selection);
      session.enter("config-line");
      session.lineCtx = selection;
      return "";
    },
  },
  {
    pattern: "login",
    modes: ["config-line"],
    device: "managed",
    run: (session) => {
      remoteAccessOf(session).setLogin(lineSelection(session), "password");
      return "";
    },
  },
  {
    pattern: "login local",
    modes: ["config-line"],
    device: "managed",
    run: (session) => {
      remoteAccessOf(session).setLogin(lineSelection(session), "local");
      return "";
    },
  },
  {
    pattern: "no login",
    modes: ["config-line"],
    device: "managed",
    run: (session) => {
      remoteAccessOf(session).setLogin(lineSelection(session), "none");
      return "";
    },
  },
  {
    pattern: "transport input {transports...}",
    usage: "transport input {telnet | ssh | all | none}",
    modes: ["config-line"],
    device: "managed",
    run: (session, params) => {
      remoteAccessOf(session).setTransports(lineSelection(session), parseTransports(params.transports!));
      return "";
    },
  },
  {
    pattern: "exec-timeout {minutes} {seconds}",
    usage: "exec-timeout <minutes> <seconds>",
    modes: ["config-line"],
    device: "managed",
    run: (session, params) => {
      remoteAccessOf(session).setExecTimeout(lineSelection(session), parseExecTimeout(params.minutes!, params.seconds!));
      return "";
    },
  },
  {
    pattern: "exec-timeout {minutes}",
    usage: "exec-timeout <minutes> [seconds]",
    modes: ["config-line"],
    device: "managed",
    run: (session, params) => {
      remoteAccessOf(session).setExecTimeout(lineSelection(session), parseExecTimeout(params.minutes!, "0"));
      return "";
    },
  },
];

function generateHostKey(session: SessionApi, bits: number): string {
  if (!Number.isInteger(bits) || bits < 360 || bits > 4_096) {
    throw new ValidationError("Modulus size must be an integer between 360 and 4096.");
  }
  const state = remoteAccessOf(session);
  let fingerprint: string;
  try {
    fingerprint = state.generateHostKey(bits);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message.replace(/^% /u, "") : "Host key generation failed");
  }
  return [
    `The name for the keys will be: ${session.device.name}.${state.sshConfig.domainName}`,
    `% Generating ${bits} bit simulated host key...`,
    `Fingerprint: ${fingerprint}`,
    "% This is an educational identity string, not a cryptographic key.",
  ].join("\n");
}

function remote(
  protocol: RemoteSessionProtocol,
  target: string,
  username?: string,
  port?: number,
): RemoteSessionRequest {
  if (target.trim().length === 0) throw new ValidationError("A destination host is required.");
  return { protocol, target: target.trim(), username, port };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ValidationError("Port must be an integer between 1 and 65535.");
  }
  return port;
}

/** `ssh admin@10.0.0.1` and `ssh -l admin 10.0.0.1` reach the same session. */
function splitUserTarget(value: string): { username: string; target: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    throw new ValidationError("Use ssh <username>@<host> or ssh -l <username> <host>.");
  }
  return { username: value.slice(0, at), target: value.slice(at + 1) };
}

function parseLineIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 15) {
    throw new ValidationError("VTY line numbers range from 0 to 15.");
  }
  return index;
}

function parseTransports(value: string): RemoteSessionProtocol[] {
  const tokens = value.trim().toLowerCase().split(/\s+/u).filter((token) => token.length > 0);
  if (tokens.length === 1 && tokens[0] === "all") return ["telnet", "ssh"];
  if (tokens.length === 1 && tokens[0] === "none") return [];
  const selected: RemoteSessionProtocol[] = [];
  for (const token of tokens) {
    if (token !== "telnet" && token !== "ssh") {
      throw new ValidationError("transport input accepts telnet, ssh, all or none.");
    }
    if (!selected.includes(token)) selected.push(token);
  }
  if (selected.length === 0) throw new ValidationError("transport input accepts telnet, ssh, all or none.");
  return selected;
}

function parseExecTimeout(minutes: string, seconds: string): number {
  const m = Number(minutes);
  const s = Number(seconds);
  if (!Number.isInteger(m) || !Number.isInteger(s) || m < 0 || s < 0 || s > 59) {
    throw new ValidationError("exec-timeout takes whole minutes and 0-59 seconds.");
  }
  const total = m * 60 + s;
  if (total > 3_600) throw new ValidationError("exec-timeout may not exceed 60 minutes.");
  return total;
}
