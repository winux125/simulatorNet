import { EndHost, Server, type SyslogSeverity } from "@sim/sim-core";
import { InvalidModeError, ValidationError } from "../errors/errors";
import type { CommandSpec, SessionApi } from "../types";
import { parseIpv4 } from "./helpers";

const EXEC_MODES = ["exec", "privileged"] as const;
const severities = new Set<SyslogSeverity>([
  "emergency", "alert", "critical", "error", "warning", "notice", "informational", "debug",
]);

function host(session: SessionApi): EndHost {
  if (!(session.device instanceof EndHost)) throw new InvalidModeError("This command requires an end host");
  return session.device;
}

function server(session: SessionApi): Server {
  if (!(session.device instanceof Server)) throw new InvalidModeError("This command requires a server");
  return session.device;
}

function safely(run: () => string): string {
  try {
    return run();
  } catch (error) {
    if (error instanceof InvalidModeError || error instanceof ValidationError) throw error;
    throw new ValidationError(error instanceof Error ? error.message : "Application command failed");
  }
}

export const applicationCommands: CommandSpec[] = [
  {
    pattern: "nslookup {hostname} {server}",
    usage: "nslookup <hostname> [dns-server]",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => runNslookup(session, params.hostname!, parseIpv4(params.server!))),
  },
  {
    pattern: "nslookup {hostname}",
    usage: "nslookup <hostname> [dns-server]",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => runNslookup(session, params.hostname!)),
  },
  {
    pattern: "sim http get {url}",
    usage: "sim http get <http://server-ip[:port]/path>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => {
      const device = host(session);
      let requestId = -1;
      return session.runNetworkOperation(
        () => { requestId = device.applications.httpGet(params.url!); },
        () => {
          const result = device.applications.httpResults.find((candidate) => candidate.requestId === requestId);
          if (!result) return "% HTTP request did not complete.";
          if (result.status !== "completed") return `% HTTP ${result.status}.`;
          const headers = Object.entries(result.headers ?? {}).map(([name, value]) => `${name}: ${value}`);
          return [`HTTP/1.1 ${result.statusCode}`, ...headers, "", result.body ?? ""].join("\n").trimEnd();
        },
      );
    }),
  },
  {
    pattern: "sim tftp get {server} {filename}",
    usage: "sim tftp get <server-ip> <filename>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => {
      const device = host(session);
      let requestId = -1;
      return session.runNetworkOperation(
        () => { requestId = device.applications.tftpGet(parseIpv4(params.server!), params.filename!); },
        () => {
          const result = device.applications.tftpResults.find((candidate) => candidate.requestId === requestId);
          if (!result) return "% TFTP transfer did not complete.";
          if (result.status !== "completed") return `% TFTP ${result.status}: ${result.message ?? result.filename}`;
          return `Received ${result.content?.length ?? 0} bytes as ${result.filename}`;
        },
      );
    }),
  },
  {
    pattern: "sim ntp query {server}",
    usage: "sim ntp query <server-ip>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => {
      const device = host(session);
      let requestId = -1;
      return session.runNetworkOperation(
        () => { requestId = device.applications.queryNtp(parseIpv4(params.server!)); },
        () => {
          const result = device.applications.ntpResults.find((candidate) => candidate.requestId === requestId);
          return result?.status === "completed"
            ? `NTP server time: ${result.serverTimeNs} ns\nClock offset: ${result.offsetNs} ns`
            : "% NTP request timed out.";
        },
      );
    }),
  },
  {
    pattern: "sim show clock",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session) => `${host(session).applications.clockNow()} ns (virtual)`,
  },
  {
    pattern: "sim syslog send {server} {severity} {message...}",
    usage: "sim syslog send <server-ip> <severity> <message>",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session, params) => safely(() => {
      const severity = params.severity!.toLowerCase() as SyslogSeverity;
      if (!severities.has(severity)) throw new ValidationError("Syslog severity must be emergency, alert, critical, error, warning, notice, informational, or debug.");
      return session.runNetworkOperation(
        () => host(session).applications.sendSyslog(parseIpv4(params.server!), severity, params.message!),
        () => `Syslog ${severity} message sent to ${params.server}.`,
      );
    }),
  },
  {
    pattern: "sim show udp sockets",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session) => formatRows(
      ["Local address", "Port", "Service", "State"],
      host(session).transport.udp.inspect().map((entry) => [entry.localAddress ?? "0.0.0.0", String(entry.localPort), entry.service, entry.state]),
      "No UDP sockets.",
    ),
  },
  {
    pattern: "sim show tcp connections",
    modes: [...EXEC_MODES],
    device: "host",
    run: (session) => formatRows(
      ["Local", "Remote", "State", "Service"],
      host(session).transport.tcp.inspect().map((entry) => [
        `${entry.localAddress}:${entry.localPort}`,
        entry.remotePort === 0 ? "*" : `${entry.remoteAddress}:${entry.remotePort}`,
        entry.state,
        entry.service,
      ]),
      "No TCP connections.",
    ),
  },
  {
    pattern: "sim show services",
    modes: [...EXEC_MODES],
    device: "server",
    capabilities: ["application-services"],
    run: (session) => formatRows(
      ["ID", "Type", "Enabled", "State", "Port"],
      server(session).listServices().map((entry) => [entry.id, entry.type, entry.enabled ? "yes" : "no", entry.state, String(entry.listeningPort ?? "—")]),
      "No application services configured.",
    ),
  },
  ...(["dns", "http", "tftp", "syslog"] as const).map((type): CommandSpec => ({
    pattern: `sim show ${type}`,
    modes: [...EXEC_MODES],
    device: "server",
    capabilities: ["application-services"],
    run: (session) => showService(server(session), type),
  })),
];

function runNslookup(session: SessionApi, hostname: string, dnsServer?: string): string {
  const device = host(session);
  let requestId = -1;
  return session.runNetworkOperation(
    () => { requestId = device.applications.resolveDns(hostname, dnsServer); },
    () => {
      const result = device.applications.dnsResults.find((candidate) => candidate.requestId === requestId);
      if (!result || result.status === "timeout") return `Server: ${dnsServer ?? device.applications.dnsServer ?? "unconfigured"}\n*** Request timed out.`;
      if (result.status === "nxdomain") return `Server: ${result.serverAddress}\n*** ${result.hostname}: NXDOMAIN`;
      if (result.status !== "success") return `Server: ${result.serverAddress}\n*** Malformed DNS response.`;
      return `Server: ${result.serverAddress}\nName: ${result.hostname}\nAddress: ${result.address}`;
    },
  );
}

function showService(device: Server, type: "dns" | "http" | "tftp" | "syslog"): string {
  const config = device.services.configurations().find((entry) => entry.type === type);
  if (!config) return `${type.toUpperCase()} service is not configured.`;
  if (config.type === "dns") return formatRows(["Name", "Address"], config.records.map((entry) => [entry.name, entry.address]), "No DNS records.");
  if (config.type === "http") return formatRows(["Path", "Content-Type", "Bytes"], config.resources.map((entry) => [entry.path, entry.contentType, String(entry.body.length)]), "No HTTP resources.");
  if (config.type === "tftp") return formatRows(["Filename", "Bytes"], config.files.map((entry) => [entry.filename, String(entry.content.length)]), "No TFTP files.");
  return formatRows(
    ["Seq", "Time", "Source", "Severity", "Message"],
    device.serviceRuntimeSnapshot().syslog.entries.map((entry) => [String(entry.sequence), String(entry.receivedAtNs), entry.source, entry.severity, entry.message]),
    "No Syslog messages.",
  );
}

function formatRows(headers: string[], rows: string[][], empty: string): string {
  if (rows.length === 0) return empty;
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)) + 2);
  const line = (values: string[]) => values.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(Math.max(1, width - 2)))), ...rows.map(line)].join("\n");
}
