/**
 * Redacted running-config rendering for console access. Existing passwords and
 * verifier hashes are never revealed; a stable placeholder stands in their place
 * so `show running-config` is honest about what is configured without leaking a
 * secret or a crackable hash.
 */
import type { ConsoleAccessConfiguration } from "@sim/contracts";

const REDACTED = "5 <hidden>";

export function renderConsoleAccessConfig(access: ConsoleAccessConfiguration | undefined): string[] {
  if (!access || access.mode === "none") return [];
  const lines: string[] = [];
  for (const user of access.users) {
    if (!user.enabled) continue;
    lines.push(`username ${user.username} privilege ${user.privilegeLevel} secret ${REDACTED}`);
  }
  if (access.enableSecretVerifier) lines.push(`enable secret ${REDACTED}`);
  if (access.loginBanner) lines.push(`banner login ^C${access.loginBanner}^C`);
  if (access.motdBanner) lines.push(`banner motd ^C${access.motdBanner}^C`);
  lines.push("line console 0");
  if (access.consolePasswordVerifier) lines.push(` password ${REDACTED}`);
  lines.push(access.mode === "local-user" ? " login local" : " login");
  return lines;
}

/** A disabled, empty console-access configuration. */
export function emptyConsoleAccess(): ConsoleAccessConfiguration {
  return { mode: "none", users: [], maximumAttempts: 3, credentialResetRequired: false };
}
