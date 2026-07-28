import {
  AAA_LIMITS,
  RADIUS_ACCOUNTING_PORT,
  RADIUS_AUTHENTICATION_PORT,
  TACACS_PORT,
  type AaaAccountingMode,
  type AaaMethod,
  type AaaServerConfig,
  type AaaServerProtocol,
} from "@sim/contracts";
import {
  EndHost,
  L2Switch,
  Layer3Switch,
  Router,
  type AaaState,
  type RemoteAccessState,
  type SnmpAgent,
} from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi, VtyLineContext } from "../types";
import type { RemoteSessionProtocol, RemoteSessionRequest } from "../session/remote";
import { CliSession } from "../session/session";
import { parseIpv4, parseIpv6 } from "./helpers";

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
  {
    pattern: "login authentication {list}",
    usage: "login authentication <list-name>",
    modes: ["config-line"],
    device: "managed",
    run: (session, params) => {
      remoteAccessOf(session).setAuthenticationList(lineSelection(session), listName(params.list!));
      return "";
    },
  },
  {
    pattern: "authorization exec {list}",
    usage: "authorization exec <list-name>",
    modes: ["config-line"],
    device: "managed",
    run: (session, params) => {
      remoteAccessOf(session).setAuthorizationList(lineSelection(session), listName(params.list!));
      return "";
    },
  },

  // --- AAA method lists -----------------------------------------------------
  {
    pattern: "aaa new-model",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      aaaOf(session).setEnabled(true);
      return "";
    },
  },
  {
    pattern: "no aaa new-model",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      aaaOf(session).setEnabled(false);
      return "";
    },
  },
  {
    pattern: "aaa authentication login {list} {methods...}",
    usage: "aaa authentication login {default | <list>} <method> [method ...]",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      requireAaa(session);
      aaaOf(session).setAuthenticationLogin({ name: listName(params.list!), methods: parseMethods(params.methods!) });
      return "";
    },
  },
  {
    pattern: "aaa authorization exec {list} {methods...}",
    usage: "aaa authorization exec {default | <list>} <method> [method ...]",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      requireAaa(session);
      aaaOf(session).setAuthorizationExec({ name: listName(params.list!), methods: parseMethods(params.methods!) });
      return "";
    },
  },
  {
    pattern: "aaa authorization commands {level} {list} {methods...}",
    usage: "aaa authorization commands <0-15> {default | <list>} <method> [method ...]",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      requireAaa(session);
      aaaOf(session).setAuthorizationCommands({
        name: listName(params.list!),
        privilegeLevel: parsePrivilegeLevel(params.level!),
        methods: parseMethods(params.methods!),
      });
      return "";
    },
  },
  {
    pattern: "aaa accounting exec {list} {mode} {methods...}",
    usage: "aaa accounting exec {default | <list>} {start-stop | stop-only | none} <method>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      requireAaa(session);
      aaaOf(session).setAccountingExec({
        name: listName(params.list!),
        mode: parseAccountingMode(params.mode!),
        methods: parseMethods(params.methods!),
      });
      return "";
    },
  },
  {
    pattern: "aaa accounting commands {level} {list} {mode} {methods...}",
    usage: "aaa accounting commands <0-15> {default | <list>} {start-stop | stop-only | none} <method>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      requireAaa(session);
      aaaOf(session).setAccountingCommands({
        name: listName(params.list!),
        privilegeLevel: parsePrivilegeLevel(params.level!),
        mode: parseAccountingMode(params.mode!),
        methods: parseMethods(params.methods!),
      });
      return "";
    },
  },

  // --- AAA servers ----------------------------------------------------------
  {
    pattern: "radius server {name}",
    usage: "radius server <name>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => enterServer(session, "radius", params.name!),
  },
  {
    pattern: "tacacs server {name}",
    usage: "tacacs server <name>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => enterServer(session, "tacacs+", params.name!),
  },
  {
    pattern: "no radius server {name}",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      aaaOf(session).removeServer(params.name!);
      return "";
    },
  },
  {
    pattern: "no tacacs server {name}",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      aaaOf(session).removeServer(params.name!);
      return "";
    },
  },
  {
    pattern: "address ipv4 {address} auth-port {authPort} acct-port {acctPort}",
    usage: "address ipv4 <ip> auth-port <port> acct-port <port>",
    modes: ["config-aaa-server"],
    device: "managed",
    run: (session, params) => updateServer(session, {
      address: parseIpv4(params.address!),
      authenticationPort: parsePort(params.authPort!),
      accountingPort: parsePort(params.acctPort!),
    }),
  },
  {
    pattern: "address ipv4 {address}",
    usage: "address ipv4 <ip>",
    modes: ["config-aaa-server"],
    device: "managed",
    run: (session, params) => updateServer(session, { address: parseIpv4(params.address!) }),
  },
  {
    pattern: "address ipv6 {address}",
    usage: "address ipv6 <ipv6-address>",
    modes: ["config-aaa-server"],
    device: "managed",
    run: (session, params) => updateServer(session, { address: parseIpv6(params.address!) }),
  },
  {
    pattern: "timeout {seconds}",
    usage: "timeout <1-30>",
    modes: ["config-aaa-server"],
    device: "managed",
    run: (session, params) => updateServer(session, { timeoutSeconds: parseTimeout(params.seconds!) }),
  },

  // --- operational / inspection ---------------------------------------------
  {
    pattern: "clear line vty {index}",
    usage: "clear line vty <line>",
    modes: ["privileged"],
    device: "managed",
    run: (session, params) => {
      const runtime = session instanceof CliSession ? session.managementRuntime() : undefined;
      const cleared = runtime?.clearLine?.(session.device.id, parseLineIndex(params.index!)) ?? false;
      return cleared ? "" : "% No session on that line.";
    },
  },
  {
    pattern: "show users",
    modes: ["privileged"],
    device: "managed",
    run: (session) => {
      const runtime = session instanceof CliSession ? session.managementRuntime() : undefined;
      const sessions = runtime?.sessionsOf?.(session.device.id) ?? [];
      return table(
        ["Line", "User", "Host(s)", "Protocol", "Idle"],
        sessions.map((entry) => [
          `vty ${entry.line}`,
          entry.username ?? "-",
          `${entry.clientHostname} (${entry.peerAddress})`,
          entry.protocol,
          formatSeconds(entry.idleForNs),
        ]),
        "No remote sessions.",
      );
    },
  },
  {
    pattern: "show line",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const runtime = session instanceof CliSession ? session.managementRuntime() : undefined;
      const lines = runtime?.linesOf?.(session.device.id) ?? [];
      return table(
        ["Line", "State", "Login", "Transport", "Timeout", "User"],
        lines.map((line) => [
          `vty ${line.index}`,
          line.state,
          line.loginMode,
          line.transports.length === 0 ? "none" : line.transports.join(" "),
          `${line.execTimeoutSeconds}s`,
          line.username ?? "-",
        ]),
        "No VTY lines are configured.",
      );
    },
  },
  {
    pattern: "show ip ssh",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const ssh = remoteAccessOf(session).sshConfig;
      if (!ssh.enabled || !ssh.hostKeyFingerprint) return "SSH Disabled - simulated host key has not been generated.";
      return [
        `SSH Enabled - version ${ssh.version}.0 (simulated)`,
        `Domain name: ${ssh.domainName ?? "not configured"}`,
        `Host key fingerprint: ${ssh.hostKeyFingerprint}`,
        `Modulus size: ${ssh.modulusBits ?? 1_024} bits (educational)`,
        "This is a simulated SSH service: no encryption or key exchange is performed.",
      ].join("\n");
    },
  },
  {
    pattern: "show ssh",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const runtime = session instanceof CliSession ? session.managementRuntime() : undefined;
      const sessions = (runtime?.sessionsOf?.(session.device.id) ?? []).filter((entry) => entry.protocol === "ssh");
      return table(
        ["Connection", "Version", "State", "Username"],
        sessions.map((entry) => [String(entry.line), "2.0", "Session started", entry.username ?? "-"]),
        "%No SSH server connections running.",
      );
    },
  },
  {
    pattern: "show aaa servers",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const state = aaaOf(session);
      return table(
        ["Name", "Protocol", "Address", "Auth", "Acct", "Timeout", "Key"],
        state.servers.map((server) => [
          server.name,
          server.protocol,
          server.address,
          String(server.authenticationPort ?? (server.protocol === "radius" ? RADIUS_AUTHENTICATION_PORT : TACACS_PORT)),
          String(server.accountingPort ?? (server.protocol === "radius" ? RADIUS_ACCOUNTING_PORT : TACACS_PORT)),
          `${server.timeoutSeconds}s`,
          // Never render key material, not even its fingerprint.
          server.sharedKeyFingerprint ? "configured" : "not set",
        ]),
        "No AAA servers are configured.",
      );
    },
  },
  {
    pattern: "show aaa method-lists",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const config = aaaOf(session).snapshot();
      if (!config.enabled) return "AAA is not enabled (aaa new-model).";
      const rows: string[][] = [
        ...config.authenticationLogin.map((list) => ["authentication login", list.name, list.methods.join(", ")]),
        ...config.authorizationExec.map((list) => ["authorization exec", list.name, list.methods.join(", ")]),
        ...config.authorizationCommands.map((list) => [
          `authorization commands ${list.privilegeLevel}`,
          list.name,
          list.methods.join(", "),
        ]),
        ...config.accountingExec.map((list) => [`accounting exec (${list.mode})`, list.name, list.methods.join(", ")]),
        ...config.accountingCommands.map((list) => [
          `accounting commands ${list.privilegeLevel ?? "*"} (${list.mode})`,
          list.name,
          list.methods.join(", "),
        ]),
      ];
      return table(["Type", "List", "Methods"], rows, "No AAA method lists are configured.");
    },
  },

  // --- SNMP agent -----------------------------------------------------------
  {
    pattern: "snmp-server location {text...}",
    usage: "snmp-server location <text>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      snmpOf(session).setLocation(params.text!.slice(0, 255));
      return "";
    },
  },
  {
    pattern: "snmp-server contact {text...}",
    usage: "snmp-server contact <text>",
    modes: ["config"],
    device: "managed",
    run: (session, params) => {
      snmpOf(session).setContact(params.text!.slice(0, 255));
      return "";
    },
  },
  {
    pattern: "snmp-server enable traps",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      snmpOf(session).setTrapsEnabled(true);
      return "";
    },
  },
  {
    pattern: "no snmp-server enable traps",
    modes: ["config"],
    device: "managed",
    run: (session) => {
      snmpOf(session).setTrapsEnabled(false);
      return "";
    },
  },
  {
    pattern: "show snmp",
    modes: ["exec", "privileged"],
    device: "managed",
    run: (session) => {
      const snmp = snmpOf(session).snapshot();
      if (!snmp.enabled) return "SNMP agent not enabled.";
      return [
        `Chassis: ${session.device.name}`,
        `Contact: ${snmp.contact ?? "not configured"}`,
        `Location: ${snmp.location ?? "not configured"}`,
        `SNMP agent enabled (v2c, simulated)`,
        `Communities configured: ${snmp.communities.length}`,
        `Traps: ${snmp.trapsEnabled ? "enabled" : "disabled"} (${snmp.trapDestinations.length} destination(s))`,
      ].join("\n");
    },
  },
  {
    pattern: "show snmp community",
    modes: ["privileged"],
    device: "managed",
    run: (session) => table(
      ["Index", "Access", "Manager", "Value"],
      snmpOf(session).snapshot().communities.map((entry) => [
        entry.id,
        entry.access,
        entry.managerAddress ?? "any",
        // The community string is a shared secret: never rendered, not even
        // as its fingerprint, and `show running-config` redacts it too.
        "<redacted>",
      ]),
      "No SNMP communities are configured.",
    ),
  },
  {
    pattern: "show snmp host",
    modes: ["privileged"],
    device: "managed",
    run: (session) => table(
      ["Destination", "Port", "Version", "Community"],
      snmpOf(session).snapshot().trapDestinations.map((entry) => [
        entry.address,
        String(entry.port),
        entry.version,
        entry.communityFingerprint ? "<redacted>" : "not set",
      ]),
      "No SNMP trap destinations are configured.",
    ),
  },
];

/** AAA method lists and servers live on the same devices as remote access. */
function aaaOf(session: SessionApi): AaaState {
  const device = session.device;
  if (device instanceof L2Switch || device instanceof Router) return device.aaa;
  throw new InvalidModeError("This command requires a Router, Switch or Firewall");
}

/** The SNMP agent lives on the same devices as remote access and AAA. */
function snmpOf(session: SessionApi): SnmpAgent {
  const device = session.device;
  if (device instanceof L2Switch || device instanceof Router) return device.snmp;
  throw new InvalidModeError("This command requires a Router, Switch or Firewall");
}

function requireAaa(session: SessionApi): void {
  if (!aaaOf(session).enabled) throw new ValidationError("Enable AAA first with 'aaa new-model'.");
}

function enterServer(session: SessionApi, protocol: AaaServerProtocol, name: string): string {
  if (!/^[\w.-]{1,64}$/u.test(name)) throw new ValidationError("Invalid AAA server name.");
  const state = aaaOf(session);
  if (!state.serverByName(name)) {
    state.defineServer({
      name,
      protocol,
      address: protocol === "radius" ? "0.0.0.0" : "0.0.0.0",
      timeoutSeconds: 5,
      retries: 1,
    });
  }
  session.enter("config-aaa-server");
  session.aaaServerCtx = { name, protocol };
  return "";
}

function updateServer(session: SessionApi, update: Partial<AaaServerConfig>): string {
  const context = session.aaaServerCtx;
  if (!context) throw new InvalidModeError("Select an AAA server first");
  const state = aaaOf(session);
  const current = state.serverByName(context.name);
  if (!current) throw new ValidationError("The selected AAA server no longer exists.");
  state.defineServer({ ...current, ...update });
  return "";
}

function listName(value: string): string {
  const name = value.trim();
  if (!/^[\w.-]{1,64}$/u.test(name)) throw new ValidationError("Invalid method-list name.");
  return name;
}

function parseMethods(value: string): AaaMethod[] {
  const tokens = value.trim().toLowerCase().split(/\s+/u).filter((token) => token.length > 0);
  const methods: AaaMethod[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "group") {
      const target = tokens[++index];
      if (target === "radius") methods.push("group radius");
      else if (target === "tacacs+") methods.push("group tacacs+");
      else throw new ValidationError("Supported AAA groups are 'group radius' and 'group tacacs+'.");
      continue;
    }
    if (token === "local") methods.push("local");
    else if (token === "none") methods.push("none");
    else throw new ValidationError("Supported AAA methods are local, none, group radius and group tacacs+.");
  }
  if (methods.length === 0) throw new ValidationError("At least one AAA method is required.");
  if (methods.length > AAA_LIMITS.maximumMethodsPerList) {
    throw new ValidationError(`A method list may contain at most ${AAA_LIMITS.maximumMethodsPerList} methods.`);
  }
  return methods;
}

function parseAccountingMode(value: string): AaaAccountingMode {
  const mode = value.trim().toLowerCase();
  if (mode === "start-stop" || mode === "stop-only" || mode === "none") return mode;
  throw new ValidationError("Accounting mode must be start-stop, stop-only or none.");
}

function parsePrivilegeLevel(value: string): number {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 0 || level > 15) {
    throw new ValidationError("Privilege level must be between 0 and 15.");
  }
  return level;
}

function parseTimeout(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > AAA_LIMITS.maximumServerTimeoutSeconds) {
    throw new ValidationError(`Timeout must be between 1 and ${AAA_LIMITS.maximumServerTimeoutSeconds} seconds.`);
  }
  return seconds;
}

function formatSeconds(nanoseconds: number): string {
  return `${Math.floor(nanoseconds / 1_000_000_000)}s`;
}

function table(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return empty;
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)) + 2);
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(Math.max(1, width - 2)))), ...rows.map(line)].join("\n");
}

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
