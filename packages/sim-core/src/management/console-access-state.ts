import type { ConsoleAccessConfiguration, ConsoleUserConfiguration } from "@sim/contracts";

/**
 * The device's local user database and console-login settings.
 *
 * There is exactly one of these per device and exactly one local-user
 * implementation in the product: the simulated console, the VTY lines,
 * Telnet, SSH and the AAA `local` method all resolve against it.
 *
 * It lives on the device so `lab-format` serializes it like any other
 * configuration — without it a saved lab would silently lose its users. Only
 * verifiers and opaque fingerprints are held; no plaintext secret exists here.
 */
export class ConsoleAccessState {
  private config: ConsoleAccessConfiguration | undefined;

  configure(config: ConsoleAccessConfiguration | undefined): void {
    this.config = config ? cloneConsoleAccess(config) : undefined;
  }

  /** Absent when the device has no configured console access at all. */
  snapshot(): ConsoleAccessConfiguration | undefined {
    return this.config ? cloneConsoleAccess(this.config) : undefined;
  }

  get users(): readonly ConsoleUserConfiguration[] {
    return this.config?.users ?? [];
  }

  get configured(): boolean {
    return this.config !== undefined;
  }
}

export function cloneConsoleAccess(config: ConsoleAccessConfiguration): ConsoleAccessConfiguration {
  return {
    mode: config.mode,
    users: [...config.users]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((user) => ({ ...user, passwordVerifier: { ...user.passwordVerifier } })),
    consolePasswordVerifier: config.consolePasswordVerifier ? { ...config.consolePasswordVerifier } : undefined,
    enableSecretVerifier: config.enableSecretVerifier ? { ...config.enableSecretVerifier } : undefined,
    enableCredentialFingerprint: config.enableCredentialFingerprint,
    maximumAttempts: config.maximumAttempts,
    loginBanner: config.loginBanner,
    motdBanner: config.motdBanner,
    credentialResetRequired: config.credentialResetRequired,
  };
}
