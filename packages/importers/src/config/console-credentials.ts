/**
 * Convert explicit console credentials found in an imported IOS-like config into
 * SimulatorNet password verifiers. Imported *plaintext* credentials are hashed
 * into a verifier and the raw password is removed from the preserved artifact so
 * it is never shown in the report or kept in the clear. A vendor password *hash*
 * (Cisco type 5/7/8/9) cannot be verified, so no active credential is created:
 * the device is flagged as needing a fresh simulated password. Known default
 * vendor passwords are never substituted automatically.
 */
import type { ConsoleAccessConfiguration, ConsoleUserConfiguration, DeviceConfig } from "@sim/contracts";
import { createPasswordVerifier } from "@sim/console-auth";
import type { ImportReport, ImportResult, ImportedSourceArtifact } from "../types";
import {
  deriveManagementSecrets,
  parseManagementConfigFromIos,
  redactManagementSecrets,
  type ParsedManagementConfig,
} from "./management-config";

const CONSOLE_KINDS = new Set(["router", "l2-switch", "l3-switch", "firewall", "server", "bridge"]);

interface ParsedCredentials {
  users: Array<{ username: string; privilegeLevel: number; secret: string }>;
  enableSecret?: string;
  consolePassword?: string;
  loginConfigured: boolean;
  loginLocal: boolean;
  loginBanner?: string;
  motdBanner?: string;
  vendorHashDetected: boolean;
}

/** A leading single-digit type field (e.g. `secret 5 <hash>`) marks a hash. */
function isVendorHash(rest: readonly string[]): boolean {
  return rest.length >= 2 && /^[0-9]$/u.test(rest[0]!);
}

function bannerText(line: string): string {
  const body = line.replace(/^banner\s+\w+\s*/iu, "");
  return body.replace(/^(.)([\s\S]*?)\1?\s*$/u, "$2").trim() || body.trim();
}

export function parseConsoleCredentialsFromIos(text: string): ParsedCredentials {
  const parsed: ParsedCredentials = { users: [], loginConfigured: false, loginLocal: false, vendorHashDetected: false };
  let inConsoleLine = false;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.trim();
    if (line === "") continue;
    const tokens = line.split(/\s+/u);
    const head = tokens[0]?.toLowerCase();
    if (head === "username" && tokens[1]) {
      let privilege = 1;
      let index = 2;
      if (tokens[2]?.toLowerCase() === "privilege" && tokens[3]) { privilege = Number(tokens[3]) || 1; index = 4; }
      const keyword = tokens[index]?.toLowerCase();
      if (keyword === "secret" || keyword === "password") {
        const rest = tokens.slice(index + 1);
        if (isVendorHash(rest)) parsed.vendorHashDetected = true;
        else if (rest[0]) parsed.users.push({ username: tokens[1], privilegeLevel: Math.min(15, Math.max(0, privilege)), secret: rest.join(" ") });
      }
    } else if (head === "enable" && (tokens[1]?.toLowerCase() === "secret" || tokens[1]?.toLowerCase() === "password")) {
      const rest = tokens.slice(2);
      if (isVendorHash(rest)) parsed.vendorHashDetected = true;
      else if (rest[0]) parsed.enableSecret = rest.join(" ");
    } else if (head === "line" && tokens[1]?.toLowerCase() === "console") {
      inConsoleLine = true;
    } else if (head === "line") {
      inConsoleLine = false;
    } else if (inConsoleLine && head === "password") {
      const rest = tokens.slice(1);
      if (isVendorHash(rest)) parsed.vendorHashDetected = true;
      else if (rest[0]) parsed.consolePassword = rest.join(" ");
    } else if (inConsoleLine && head === "login") {
      parsed.loginConfigured = true;
      if (tokens[1]?.toLowerCase() === "local") parsed.loginLocal = true;
    } else if (head === "banner" && tokens[1]?.toLowerCase() === "login") {
      parsed.loginBanner = bannerText(line);
    } else if (head === "banner" && tokens[1]?.toLowerCase() === "motd") {
      parsed.motdBanner = bannerText(line);
    }
  }
  return parsed;
}

/** Redact plaintext secrets from preserved config text before it is displayed. */
export function redactCredentials(text: string): string {
  return text
    .replace(/((?:^|\s)(?:secret|password))\s+\S.*$/gimu, "$1 <redacted>")
    .replace(/(username\s+\S+(?:\s+privilege\s+\d+)?\s+(?:secret|password))\s+\S.*$/gimu, "$1 <redacted>");
}

async function buildConsoleAccess(parsed: ParsedCredentials): Promise<ConsoleAccessConfiguration | undefined> {
  const hasCredential = parsed.users.length > 0 || parsed.enableSecret !== undefined || parsed.consolePassword !== undefined;
  if (!hasCredential && !parsed.vendorHashDetected) return undefined;
  const users: ConsoleUserConfiguration[] = [];
  let index = 0;
  for (const user of parsed.users) {
    users.push({ id: `imported-user-${index++}`, username: user.username, passwordVerifier: await createPasswordVerifier(user.secret), privilegeLevel: user.privilegeLevel, enabled: true });
  }
  const mode = users.length > 0 ? "local-user" : parsed.consolePassword ? "password-only" : "none";
  return {
    mode,
    users,
    consolePasswordVerifier: parsed.consolePassword ? await createPasswordVerifier(parsed.consolePassword) : undefined,
    enableSecretVerifier: parsed.enableSecret ? await createPasswordVerifier(parsed.enableSecret) : undefined,
    maximumAttempts: 3,
    loginBanner: parsed.loginBanner,
    motdBanner: parsed.motdBanner,
    credentialResetRequired: parsed.vendorHashDetected,
  };
}

/** Only devices with a management plane accept remote-access/AAA configuration. */
const MANAGED_KINDS = new Set(["router", "l2-switch", "l3-switch", "firewall"]);

function applyManagement(
  config: DeviceConfig,
  access: ConsoleAccessConfiguration | undefined,
  management: ParsedManagementConfig,
): DeviceConfig {
  const next: Record<string, unknown> = { ...config };
  if (access) next.consoleAccess = access;
  if (!MANAGED_KINDS.has(config.kind)) return next as DeviceConfig;
  if (management.remoteAccess) {
    next.remoteAccess = {
      ...management.remoteAccess,
      // A simulated host key is derived when the lab is built, not imported:
      // an imported config never carries usable key material.
      ssh: { ...management.remoteAccess.ssh, enabled: false, hostKeyFingerprint: undefined },
    };
  }
  if (management.aaa) next.aaa = management.aaa;
  if (config.kind === "l2-switch") {
    if (management.managementSvi) next.managementSvi = management.managementSvi;
    if (management.managementDefaultGateway) next.managementDefaultGateway = management.managementDefaultGateway;
  }
  return next as DeviceConfig;
}

/**
 * Post-process an import result: for every console-capable device with an
 * imported IOS-like config, create console-access verifiers, attach them to the
 * device config, redact the preserved artifact, and update the report counts.
 */
export async function applyImportedConsoleCredentials(result: ImportResult): Promise<ImportResult> {
  const configurations: Record<string, DeviceConfig> = { ...result.document.configurations };
  const artifacts: ImportedSourceArtifact[] = [];
  const unsupportedManagement = new Set<string>();
  let credentialsDetected = 0;
  let credentialsRequiringReset = 0;

  for (const artifact of result.sourceArtifacts) {
    if (artifact.kind !== "startup-config") { artifacts.push(artifact); continue; }
    const config = configurations[artifact.nodeId];
    if (!config || !CONSOLE_KINDS.has(config.kind)) { artifacts.push(artifact); continue; }
    const parsed = parseConsoleCredentialsFromIos(artifact.text);
    const access = await buildConsoleAccess(parsed);
    const management = await deriveManagementSecrets(
      artifact.text,
      parseManagementConfigFromIos(artifact.text),
    );
    const hasManagement = management.remoteAccess !== undefined
      || management.aaa !== undefined
      || management.managementSvi !== undefined
      || management.managementDefaultGateway !== undefined;
    if (!access && !hasManagement) { artifacts.push(artifact); continue; }
    configurations[artifact.nodeId] = applyManagement(config, access, management);
    credentialsDetected += parsed.users.length
      + (parsed.enableSecret ? 1 : 0)
      + (parsed.consolePassword ? 1 : 0)
      + (management.remoteAccess?.vtyLines.filter((line) => line.passwordVerifier).length ?? 0)
      + (management.aaa?.servers.filter((server) => server.sharedKeyFingerprint).length ?? 0);
    if (access?.credentialResetRequired || management.resetRequired) credentialsRequiringReset += 1;
    for (const ignored of management.ignored) unsupportedManagement.add(ignored);
    artifacts.push({
      ...artifact,
      text: redactManagementSecrets(redactCredentials(artifact.text)),
    });
  }

  const entries = [...result.report.entries];
  if (unsupportedManagement.size > 0) {
    // Reported honestly rather than silently dropped: the learner sees exactly
    // which advanced AAA syntax SimulatorNet does not simulate.
    entries.push({
      level: "warning",
      code: "management-config-ignored",
      message: `Unsupported management configuration was preserved but not applied: ${[...unsupportedManagement].slice(0, 10).join("; ")}`,
    });
  }
  if (credentialsDetected > 0) {
    entries.push({ level: "info", code: "credential-imported", message: `Explicit console credential imported and converted to a verifier (${credentialsDetected} total)` });
  }
  if (credentialsRequiringReset > 0) {
    entries.push({ level: "warning", code: "credential-reset-required", message: `A vendor password hash could not be verified on ${credentialsRequiringReset} device(s); set a new simulated password` });
  }
  const report: ImportReport = {
    ...result.report,
    credentialsDetected,
    credentialsRequiringReset,
    entries,
    warningCount: entries.filter((entry) => entry.level === "warning").length,
    errorCount: entries.filter((entry) => entry.level === "error").length,
  };
  return { document: { ...result.document, configurations }, report, sourceArtifacts: artifacts };
}
