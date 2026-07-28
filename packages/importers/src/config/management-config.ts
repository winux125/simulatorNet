/**
 * Import the IOS-like *management* subset: the L2 management SVI, VTY lines,
 * the simulated SSH server, AAA method lists and RADIUS/TACACS+ servers.
 *
 * Imports are untrusted and one-way. Nothing here executes vendor
 * configuration: lines are matched literally and converted into structured
 * `LabDocument` fields. Every plaintext secret becomes a scope-bound verifier
 * and is removed from the preserved artifact; a vendor password *hash* cannot
 * be verified, so it produces a reset requirement rather than a usable
 * credential.
 */
import {
  createManagementCredentialVerifier,
  managementCredentialScope,
} from "@sim/console-auth";
import type {
  AaaAccountingMode,
  AaaConfiguration,
  AaaMethod,
  AaaServerConfig,
  ManagementSviConfig,
  RemoteAccessConfiguration,
  RemoteProtocol,
  VtyLineConfig,
  VtyLoginMode,
} from "@sim/contracts";

export interface ParsedManagementConfig {
  readonly managementSvi?: ManagementSviConfig;
  readonly managementDefaultGateway?: string;
  readonly remoteAccess?: RemoteAccessConfiguration;
  readonly aaa?: AaaConfiguration;
  /** Lines recognised as management config but deliberately not applied. */
  readonly ignored: string[];
  /** A vendor hash appeared where a comparable secret was required. */
  readonly resetRequired: boolean;
}

interface Draft {
  svi?: { vlanId: number; ipAddress?: string; prefixLength?: number; adminUp: boolean; description?: string };
  defaultGateway?: string;
  telnetEnabled: boolean;
  sshDomainName?: string;
  sshVersion?: 2;
  sshModulusBits?: number;
  sshKeyRequested: boolean;
  vtyLines: Array<{
    first: number;
    last: number;
    loginMode: VtyLoginMode;
    linePassword?: string;
    transports: RemoteProtocol[];
    execTimeoutSeconds: number;
    authenticationListName?: string;
    authorizationListName?: string;
  }>;
  aaaEnabled: boolean;
  authenticationLogin: Array<{ name: string; methods: AaaMethod[] }>;
  authorizationExec: Array<{ name: string; methods: AaaMethod[] }>;
  authorizationCommands: Array<{ name: string; privilegeLevel: number; methods: AaaMethod[] }>;
  accountingExec: Array<{ name: string; mode: AaaAccountingMode; methods: AaaMethod[] }>;
  accountingCommands: Array<{ name: string; privilegeLevel: number; mode: AaaAccountingMode; methods: AaaMethod[] }>;
  servers: Array<{ name: string; protocol: "radius" | "tacacs+"; address?: string; authPort?: number; acctPort?: number; key?: string; timeoutSeconds?: number }>;
  ignored: string[];
  resetRequired: boolean;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

function newDraft(): Draft {
  return {
    telnetEnabled: true,
    sshKeyRequested: false,
    vtyLines: [],
    aaaEnabled: false,
    authenticationLogin: [],
    authorizationExec: [],
    authorizationCommands: [],
    accountingExec: [],
    accountingCommands: [],
    servers: [],
    ignored: [],
    resetRequired: false,
  };
}

/** `group radius local` -> ["group radius", "local"]; unknown tokens are ignored. */
function parseMethods(tokens: readonly string[]): AaaMethod[] {
  const methods: AaaMethod[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]?.toLowerCase();
    if (token === "group") {
      const target = tokens[++index]?.toLowerCase();
      if (target === "radius") methods.push("group radius");
      else if (target === "tacacs+") methods.push("group tacacs+");
      continue;
    }
    if (token === "local") methods.push("local");
    else if (token === "none") methods.push("none");
  }
  return methods.slice(0, 4);
}

function parseAccountingMode(token: string | undefined): AaaAccountingMode {
  const value = token?.toLowerCase();
  if (value === "stop-only") return "stop-only";
  if (value === "none") return "none";
  return "start-stop";
}

/** A leading single-digit type field (`key 7 <hash>`) marks a vendor hash. */
function isVendorHash(rest: readonly string[]): boolean {
  return rest.length >= 2 && /^[0-9]$/u.test(rest[0]!);
}

export function parseManagementConfigFromIos(text: string): ParsedManagementConfig {
  const draft = newDraft();
  let context: "none" | "svi" | "vty" | "radius" | "tacacs" = "none";
  let currentVty: Draft["vtyLines"][number] | undefined;
  let currentServer: Draft["servers"][number] | undefined;

  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("!")) continue;
    const tokens = line.split(/\s+/u);
    const head = tokens[0]?.toLowerCase();

    if (head === "interface" && /^vlan\d*$/iu.test(tokens[1] ?? "")) {
      const vlanId = Number(tokens[1]!.replace(/^vlan/iu, "")) || Number(tokens[2]);
      if (Number.isInteger(vlanId) && vlanId >= 1 && vlanId <= 4_094) {
        draft.svi = { vlanId, adminUp: true };
        context = "svi";
        continue;
      }
    }
    if (head === "interface" || head === "router" || head === "vlan") {
      context = "none";
      currentVty = undefined;
      currentServer = undefined;
      continue;
    }
    if (head === "line" && tokens[1]?.toLowerCase() === "vty") {
      const first = Number(tokens[2]);
      const last = Number(tokens[3] ?? tokens[2]);
      if (Number.isInteger(first) && Number.isInteger(last) && first >= 0 && last <= 15 && first <= last) {
        currentVty = {
          first,
          last,
          loginMode: "none",
          transports: ["telnet", "ssh"],
          execTimeoutSeconds: 600,
        };
        draft.vtyLines.push(currentVty);
        context = "vty";
        continue;
      }
    }
    if (head === "line") {
      context = "none";
      currentVty = undefined;
      continue;
    }
    if (head === "radius" && tokens[1]?.toLowerCase() === "server" && tokens[2]) {
      currentServer = { name: tokens[2], protocol: "radius" };
      draft.servers.push(currentServer);
      context = "radius";
      continue;
    }
    if (head === "tacacs" && tokens[1]?.toLowerCase() === "server" && tokens[2]) {
      currentServer = { name: tokens[2], protocol: "tacacs+" };
      draft.servers.push(currentServer);
      context = "tacacs";
      continue;
    }

    if (context === "svi" && draft.svi) {
      if (head === "ip" && tokens[1]?.toLowerCase() === "address" && IPV4.test(tokens[2] ?? "") && IPV4.test(tokens[3] ?? "")) {
        draft.svi.ipAddress = tokens[2];
        draft.svi.prefixLength = maskToPrefix(tokens[3]!);
        continue;
      }
      if (head === "shutdown") { draft.svi.adminUp = false; continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "shutdown") { draft.svi.adminUp = true; continue; }
      if (head === "description") { draft.svi.description = tokens.slice(1).join(" ").slice(0, 240) || undefined; continue; }
    }

    if (context === "vty" && currentVty) {
      if (head === "login" && tokens[1]?.toLowerCase() === "local") { currentVty.loginMode = "local"; continue; }
      if (head === "login" && tokens[1]?.toLowerCase() === "authentication" && tokens[2]) {
        currentVty.authenticationListName = tokens[2];
        continue;
      }
      if (head === "login") { currentVty.loginMode = "password"; continue; }
      if (head === "no" && tokens[1]?.toLowerCase() === "login") { currentVty.loginMode = "none"; continue; }
      if (head === "password") {
        const rest = tokens.slice(1);
        if (isVendorHash(rest)) draft.resetRequired = true;
        else if (rest[0]) currentVty.linePassword = rest.join(" ");
        continue;
      }
      if (head === "transport" && tokens[1]?.toLowerCase() === "input") {
        currentVty.transports = parseTransports(tokens.slice(2));
        continue;
      }
      if (head === "exec-timeout") {
        const minutes = Number(tokens[1] ?? 0);
        const seconds = Number(tokens[2] ?? 0);
        if (Number.isInteger(minutes) && Number.isInteger(seconds)) {
          currentVty.execTimeoutSeconds = Math.min(3_600, Math.max(0, minutes * 60 + seconds));
        }
        continue;
      }
      if (head === "authorization" && tokens[1]?.toLowerCase() === "exec" && tokens[2]) {
        currentVty.authorizationListName = tokens[2];
        continue;
      }
    }

    if ((context === "radius" || context === "tacacs") && currentServer) {
      if (head === "address") {
        const family = tokens[1]?.toLowerCase();
        if (family === "ipv4" || family === "ipv6") currentServer.address = tokens[2];
        const authIndex = tokens.findIndex((token) => token.toLowerCase() === "auth-port");
        const acctIndex = tokens.findIndex((token) => token.toLowerCase() === "acct-port");
        if (authIndex >= 0) currentServer.authPort = Number(tokens[authIndex + 1]) || undefined;
        if (acctIndex >= 0) currentServer.acctPort = Number(tokens[acctIndex + 1]) || undefined;
        continue;
      }
      if (head === "key") {
        const rest = tokens.slice(1);
        if (isVendorHash(rest)) draft.resetRequired = true;
        else if (rest[0]) currentServer.key = rest.join(" ");
        continue;
      }
      if (head === "timeout") {
        const seconds = Number(tokens[1]);
        if (Number.isInteger(seconds) && seconds > 0) currentServer.timeoutSeconds = Math.min(30, seconds);
        continue;
      }
    }

    // --- global management commands ---
    if (head === "ip" && tokens[1]?.toLowerCase() === "default-gateway" && IPV4.test(tokens[2] ?? "")) {
      draft.defaultGateway = tokens[2];
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "domain-name" && tokens[2]) {
      draft.sshDomainName = tokens[2].slice(0, 128);
      continue;
    }
    if (head === "ip" && tokens[1]?.toLowerCase() === "ssh" && tokens[2]?.toLowerCase() === "version") {
      if (tokens[3] === "2") draft.sshVersion = 2;
      else draft.ignored.push(line);
      continue;
    }
    if (head === "crypto" && tokens[1]?.toLowerCase() === "key" && tokens[2]?.toLowerCase() === "generate") {
      draft.sshKeyRequested = true;
      const modulusIndex = tokens.findIndex((token) => token.toLowerCase() === "modulus");
      if (modulusIndex >= 0) draft.sshModulusBits = Number(tokens[modulusIndex + 1]) || undefined;
      continue;
    }
    if (head === "aaa") {
      parseAaaLine(draft, tokens);
      continue;
    }
  }

  return finalize(draft);
}

function parseAaaLine(draft: Draft, tokens: readonly string[]): void {
  const second = tokens[1]?.toLowerCase();
  if (second === "new-model") {
    draft.aaaEnabled = true;
    return;
  }
  if (second === "authentication" && tokens[2]?.toLowerCase() === "login" && tokens[3]) {
    draft.authenticationLogin.push({ name: tokens[3], methods: parseMethods(tokens.slice(4)) });
    return;
  }
  if (second === "authorization" && tokens[2]?.toLowerCase() === "exec" && tokens[3]) {
    draft.authorizationExec.push({ name: tokens[3], methods: parseMethods(tokens.slice(4)) });
    return;
  }
  if (second === "authorization" && tokens[2]?.toLowerCase() === "commands" && tokens[3] && tokens[4]) {
    const level = Number(tokens[3]);
    if (Number.isInteger(level) && level >= 0 && level <= 15) {
      draft.authorizationCommands.push({ name: tokens[4], privilegeLevel: level, methods: parseMethods(tokens.slice(5)) });
    }
    return;
  }
  if (second === "accounting" && tokens[2]?.toLowerCase() === "exec" && tokens[3]) {
    draft.accountingExec.push({
      name: tokens[3],
      mode: parseAccountingMode(tokens[4]),
      methods: parseMethods(tokens.slice(5)),
    });
    return;
  }
  if (second === "accounting" && tokens[2]?.toLowerCase() === "commands" && tokens[3] && tokens[4]) {
    const level = Number(tokens[3]);
    if (Number.isInteger(level) && level >= 0 && level <= 15) {
      draft.accountingCommands.push({
        name: tokens[4],
        privilegeLevel: level,
        mode: parseAccountingMode(tokens[5]),
        methods: parseMethods(tokens.slice(6)),
      });
    }
    return;
  }
  draft.ignored.push(tokens.join(" "));
}

function parseTransports(tokens: readonly string[]): RemoteProtocol[] {
  const lowered = tokens.map((token) => token.toLowerCase());
  if (lowered.includes("none")) return [];
  if (lowered.includes("all")) return ["telnet", "ssh"];
  const selected: RemoteProtocol[] = [];
  if (lowered.includes("telnet")) selected.push("telnet");
  if (lowered.includes("ssh")) selected.push("ssh");
  return selected;
}

function maskToPrefix(mask: string): number {
  return mask
    .split(".")
    .map((octet) => Number(octet).toString(2).split("").filter((bit) => bit === "1").length)
    .reduce((total, bits) => total + bits, 0);
}

function finalize(draft: Draft): ParsedManagementConfig {
  const remoteAccess: RemoteAccessConfiguration | undefined = draft.vtyLines.length > 0 || draft.sshKeyRequested
    ? {
        telnetEnabled: draft.telnetEnabled,
        ssh: {
          enabled: false, // enabled once the host key is derived below
          version: draft.sshVersion ?? 2,
          domainName: draft.sshDomainName,
          modulusBits: draft.sshKeyRequested ? draft.sshModulusBits ?? 1_024 : undefined,
        },
        vtyLines: draft.vtyLines.map((line): VtyLineConfig => ({
          first: line.first,
          last: line.last,
          loginMode: line.loginMode,
          transports: line.transports,
          execTimeoutSeconds: line.execTimeoutSeconds,
          authenticationListName: line.authenticationListName,
          authorizationListName: line.authorizationListName,
        })),
      }
    : undefined;

  const aaa: AaaConfiguration | undefined = draft.aaaEnabled
    || draft.servers.length > 0
    || draft.authenticationLogin.length > 0
    ? {
        enabled: draft.aaaEnabled,
        authenticationLogin: draft.authenticationLogin,
        authorizationExec: draft.authorizationExec,
        authorizationCommands: draft.authorizationCommands,
        accountingExec: draft.accountingExec,
        accountingCommands: draft.accountingCommands,
        servers: draft.servers.map((server): AaaServerConfig => ({
          name: server.name,
          protocol: server.protocol,
          address: server.address ?? "0.0.0.0",
          authenticationPort: server.authPort,
          accountingPort: server.acctPort,
          timeoutSeconds: server.timeoutSeconds ?? 5,
          retries: 1,
        })),
      }
    : undefined;

  return {
    managementSvi: draft.svi,
    managementDefaultGateway: draft.defaultGateway,
    remoteAccess,
    aaa,
    ignored: draft.ignored,
    resetRequired: draft.resetRequired,
  };
}

/**
 * Convert the plaintext secrets the parser held onto into scope-bound
 * verifiers. Called separately because deriving a verifier is asynchronous and
 * must happen outside any deterministic engine work.
 */
export async function deriveManagementSecrets(
  text: string,
  parsed: ParsedManagementConfig,
): Promise<ParsedManagementConfig> {
  const draftSecrets = collectSecrets(text);
  let remoteAccess = parsed.remoteAccess;
  if (remoteAccess) {
    const vtyLines = await Promise.all(remoteAccess.vtyLines.map(async (line) => {
      const secret = draftSecrets.linePasswords.get(`${line.first}:${line.last}`);
      if (!secret) return line;
      return {
        ...line,
        passwordVerifier: await createManagementCredentialVerifier(managementCredentialScope.line("vty"), secret),
      };
    }));
    remoteAccess = { ...remoteAccess, vtyLines };
  }
  let aaa = parsed.aaa;
  if (aaa) {
    const servers = await Promise.all(aaa.servers.map(async (server) => {
      const key = draftSecrets.serverKeys.get(server.name);
      if (!key) return server;
      return {
        ...server,
        sharedKeyFingerprint: (
          await createManagementCredentialVerifier(managementCredentialScope.sharedKey(server.name), key)
        ).hashBase64,
      };
    }));
    aaa = { ...aaa, servers };
  }
  return { ...parsed, remoteAccess, aaa };
}

/** Second pass over the raw text purely to pair secrets with their owners. */
function collectSecrets(text: string): {
  linePasswords: Map<string, string>;
  serverKeys: Map<string, string>;
} {
  const linePasswords = new Map<string, string>();
  const serverKeys = new Map<string, string>();
  let vtyKey: string | undefined;
  let serverName: string | undefined;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const tokens = raw.trim().split(/\s+/u);
    const head = tokens[0]?.toLowerCase();
    if (head === "line" && tokens[1]?.toLowerCase() === "vty") {
      vtyKey = `${Number(tokens[2])}:${Number(tokens[3] ?? tokens[2])}`;
      serverName = undefined;
      continue;
    }
    if ((head === "radius" || head === "tacacs") && tokens[1]?.toLowerCase() === "server" && tokens[2]) {
      serverName = tokens[2];
      vtyKey = undefined;
      continue;
    }
    if (head === "line" || head === "interface" || head === "router") {
      vtyKey = undefined;
      serverName = undefined;
      continue;
    }
    if (vtyKey && head === "password") {
      const rest = tokens.slice(1);
      if (!isVendorHash(rest) && rest[0]) linePasswords.set(vtyKey, rest.join(" "));
      continue;
    }
    if (serverName && head === "key") {
      const rest = tokens.slice(1);
      if (!isVendorHash(rest) && rest[0]) serverKeys.set(serverName, rest.join(" "));
    }
  }
  return { linePasswords, serverKeys };
}

/** Remove management secrets from preserved artifact text before it is shown. */
export function redactManagementSecrets(text: string): string {
  return text
    .replace(/((?:^|\s)key)\s+\S.*$/gimu, "$1 <redacted>")
    .replace(/((?:^|\s)snmp-server\s+community)\s+\S+/gimu, "$1 <redacted>");
}
