/**
 * Credentials found in configuration *text*.
 *
 * Configuration text is the one place a plaintext secret can legitimately
 * appear: a learner pastes a `.cfg`, or an importer reads a vendor file. This
 * module is the single funnel that turns such a line into a verifier and
 * removes the plaintext, so no other layer ever has to reason about it.
 *
 * Three rules hold everywhere below:
 *
 * - a parsed secret is never returned inside a plan, a report or a rendered
 *   projection — only a value-free summary is;
 * - deriving a verifier is asynchronous (Web Crypto), so it is injected rather
 *   than imported, which keeps this package free of a crypto dependency;
 * - a vendor password *hash* is never accepted as a credential: it cannot be
 *   verified, so the device is flagged for an explicit reset instead.
 */
import type { ConsoleAccessConfiguration, ConsoleUserConfiguration, PasswordVerifier } from "@sim/contracts";

export interface ParsedConfigurationCredentials {
  readonly users: ReadonlyArray<{ username: string; privilegeLevel: number; secret: string }>;
  readonly enableSecret?: string;
  readonly consolePassword?: string;
  readonly loginConfigured: boolean;
  readonly loginLocal: boolean;
  readonly loginBanner?: string;
  readonly motdBanner?: string;
  readonly vendorHashDetected: boolean;
}

/** A value-free description of one credential a configuration text declares. */
export interface ConfigurationCredentialSummary {
  readonly kind: "enable-secret" | "local-user" | "console-password" | "vendor-hash";
  readonly username?: string;
  readonly privilegeLevel?: number;
}

/** A leading single-digit type field (e.g. `secret 5 <hash>`) marks a hash. */
function isVendorHash(rest: readonly string[]): boolean {
  return rest.length >= 2 && /^[0-9]$/u.test(rest[0]!);
}

function bannerText(line: string): string {
  const body = line.replace(/^banner\s+\w+\s*/iu, "");
  return body.replace(/^(.)([\s\S]*?)\1?\s*$/u, "$2").trim() || body.trim();
}

/**
 * Read the console credentials an IOS-like configuration declares.
 *
 * The returned object *does* carry plaintext, so it is deliberately never part
 * of a `ConfigApplyPlan`: only `summarizeConfigurationCredentials` output and
 * derived verifiers leave this module.
 */
export function parseConfigurationCredentials(text: string): ParsedConfigurationCredentials {
  const users: Array<{ username: string; privilegeLevel: number; secret: string }> = [];
  let enableSecret: string | undefined;
  let consolePassword: string | undefined;
  let loginConfigured = false;
  let loginLocal = false;
  let loginBanner: string | undefined;
  let motdBanner: string | undefined;
  let vendorHashDetected = false;
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
        if (isVendorHash(rest)) vendorHashDetected = true;
        else if (rest[0]) {
          users.push({ username: tokens[1], privilegeLevel: Math.min(15, Math.max(0, privilege)), secret: rest.join(" ") });
        }
      }
    } else if (head === "enable" && (tokens[1]?.toLowerCase() === "secret" || tokens[1]?.toLowerCase() === "password")) {
      const rest = tokens.slice(2);
      if (isVendorHash(rest)) vendorHashDetected = true;
      else if (rest[0]) enableSecret = rest.join(" ");
    } else if (head === "line" && tokens[1]?.toLowerCase() === "console") {
      inConsoleLine = true;
    } else if (head === "line") {
      inConsoleLine = false;
    } else if (inConsoleLine && head === "password") {
      const rest = tokens.slice(1);
      if (isVendorHash(rest)) vendorHashDetected = true;
      else if (rest[0]) consolePassword = rest.join(" ");
    } else if (inConsoleLine && head === "login") {
      loginConfigured = true;
      if (tokens[1]?.toLowerCase() === "local") loginLocal = true;
    } else if (head === "banner" && tokens[1]?.toLowerCase() === "login") {
      loginBanner = bannerText(line);
    } else if (head === "banner" && tokens[1]?.toLowerCase() === "motd") {
      motdBanner = bannerText(line);
    }
  }
  return { users, enableSecret, consolePassword, loginConfigured, loginLocal, loginBanner, motdBanner, vendorHashDetected };
}

/** What a preview may show about the credentials in a pasted configuration. */
export function summarizeConfigurationCredentials(
  parsed: ParsedConfigurationCredentials,
): ConfigurationCredentialSummary[] {
  const summaries: ConfigurationCredentialSummary[] = [];
  if (parsed.enableSecret !== undefined) summaries.push({ kind: "enable-secret" });
  for (const user of parsed.users) {
    summaries.push({ kind: "local-user", username: user.username, privilegeLevel: user.privilegeLevel });
  }
  if (parsed.consolePassword !== undefined) summaries.push({ kind: "console-password" });
  if (parsed.vendorHashDetected) summaries.push({ kind: "vendor-hash" });
  return summaries;
}

/** Keywords after which the remainder of a configuration line is a secret. */
const SECRET_KEYWORDS = new Set(["secret", "password", "key", "community", "passphrase", "pre-shared-key", "wpa-psk"]);

/**
 * Redact every plaintext secret from configuration text.
 *
 * Applied before any line is stored in a report, shown in a preview, written to
 * an artifact or logged. It keeps the command shape so the reader still sees
 * *that* a credential is configured.
 */
export function redactConfigurationSecrets(text: string): string {
  return text
    .split(/\r\n|\r|\n/u)
    .map((line) => redactConfigurationLine(line))
    .join("\n");
}

/** Redact one line, preserving its leading whitespace and command shape. */
export function redactConfigurationLine(line: string): string {
  const indent = /^\s*/u.exec(line)?.[0] ?? "";
  const tokens = line.trim().split(/\s+/u);
  if (tokens.length < 2) return line;
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index]!.toLowerCase();
    if (!SECRET_KEYWORDS.has(token)) continue;
    // `snmp-server community` and `key` may be followed by a vendor type digit;
    // everything after the keyword is treated as secret either way.
    return `${indent}${tokens.slice(0, index + 1).join(" ")} <redacted>`;
  }
  return line;
}

/** True when a configuration line declares a credential of any kind. */
export function isCredentialLine(line: string): boolean {
  return redactConfigurationLine(line) !== line;
}

/**
 * Turn parsed credentials into a `ConsoleAccessConfiguration`.
 *
 * `derive` is injected (`createPasswordVerifier` from `@sim/console-auth` in
 * both the browser and Node), so this package needs no crypto dependency and
 * stays synchronous everywhere else.
 */
export async function buildConsoleAccessFromCredentials(
  parsed: ParsedConfigurationCredentials,
  derive: (secret: string) => Promise<PasswordVerifier>,
): Promise<ConsoleAccessConfiguration | undefined> {
  const hasCredential = parsed.users.length > 0
    || parsed.enableSecret !== undefined
    || parsed.consolePassword !== undefined;
  if (!hasCredential && !parsed.vendorHashDetected) return undefined;
  const users: ConsoleUserConfiguration[] = [];
  let index = 0;
  for (const user of parsed.users) {
    users.push({
      id: `config-user-${index++}`,
      username: user.username,
      passwordVerifier: await derive(user.secret),
      privilegeLevel: user.privilegeLevel,
      enabled: true,
    });
  }
  const mode = users.length > 0 ? "local-user" : parsed.consolePassword ? "password-only" : "none";
  return {
    mode,
    users,
    consolePasswordVerifier: parsed.consolePassword ? await derive(parsed.consolePassword) : undefined,
    enableSecretVerifier: parsed.enableSecret ? await derive(parsed.enableSecret) : undefined,
    maximumAttempts: 3,
    loginBanner: parsed.loginBanner,
    motdBanner: parsed.motdBanner,
    credentialResetRequired: parsed.vendorHashDetected,
  };
}
