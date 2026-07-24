/**
 * Simulated console login/enable state machine. It gates a device console:
 * commands are never passed to the CLI parser until authentication succeeds.
 * Password verification is async (Web Crypto) and the session returns, for each
 * turn, whether the input was a secret so the terminal can suppress echo and
 * keep it out of history/logs. This is educational device auth — not platform
 * auth and not a real Telnet/SSH boundary — and never touches the packet engine.
 */
import type { ConsoleAccessConfiguration } from "@sim/contracts";
import { verifyPassword } from "./password";

export type ConsoleSessionState =
  | "disconnected"
  | "awaiting-return"
  | "awaiting-username"
  | "awaiting-password"
  | "awaiting-enable-password"
  | "authenticated-user-exec"
  | "privileged-exec";

export interface ConsoleTurnResult {
  readonly output: string;
  readonly state: ConsoleSessionState;
  /** The submitted line was a secret: do not echo, log, or add to history. */
  readonly secret: boolean;
  readonly authenticated: boolean;
}

export interface ConsoleSessionHooks {
  /** Run an authenticated command through the CLI and return its output. */
  execute(line: string): string;
  /** Tell the CLI to enter/leave privileged mode (drives the prompt). */
  setPrivileged?(privileged: boolean): void;
}

const PRIVILEGE_LEVEL_ENABLE = 15;

function isPrefix(input: string, command: string): boolean {
  const value = input.trim().toLowerCase();
  return value.length > 0 && command.startsWith(value);
}

export class ConsoleAuthSession {
  private stateValue: ConsoleSessionState = "disconnected";
  private attempts = 0;
  private pendingUsername = "";

  constructor(
    private readonly config: ConsoleAccessConfiguration,
    private readonly hooks: ConsoleSessionHooks,
  ) {}

  get state(): ConsoleSessionState {
    return this.stateValue;
  }

  isAuthenticated(): boolean {
    return this.stateValue === "authenticated-user-exec" || this.stateValue === "privileged-exec";
  }

  /** True while the next submitted line is a password (terminal hides echo). */
  expectsSecret(): boolean {
    return this.stateValue === "awaiting-password" || this.stateValue === "awaiting-enable-password";
  }

  /** Begin (or restart) the session, returning the initial banner/prompt text. */
  begin(): ConsoleTurnResult {
    this.attempts = 0;
    this.pendingUsername = "";
    const banner = this.config.motdBanner ? `${this.config.motdBanner}\n` : "";
    switch (this.config.mode) {
      case "press-return":
        this.stateValue = "awaiting-return";
        return this.result(`${banner}\nPress RETURN to get started!`, false);
      case "password-only":
        this.stateValue = "awaiting-password";
        return this.result(`${banner}\nPassword:`, false);
      case "local-user": {
        this.stateValue = "awaiting-username";
        const login = this.config.loginBanner ? `${this.config.loginBanner}\n` : "";
        return this.result(`${banner}${login}\nUsername:`, false);
      }
      default:
        this.stateValue = "authenticated-user-exec";
        return this.result(banner.trimEnd(), false, true);
    }
  }

  async submit(line: string): Promise<ConsoleTurnResult> {
    switch (this.stateValue) {
      case "awaiting-return":
        this.stateValue = "authenticated-user-exec";
        return this.result("", false, true);
      case "awaiting-password":
        return this.config.mode === "local-user" ? this.checkLocalUser(line) : this.checkConsolePassword(line);
      case "awaiting-username":
        this.pendingUsername = line.trim();
        this.stateValue = "awaiting-password";
        return this.result("Password:", false);
      case "awaiting-enable-password":
        return this.checkEnable(line);
      case "authenticated-user-exec":
      case "privileged-exec":
        return this.runCommand(line);
      default:
        return this.result("", false);
    }
  }

  private async checkConsolePassword(line: string): Promise<ConsoleTurnResult> {
    const ok = this.config.consolePasswordVerifier
      ? await verifyPassword(line, this.config.consolePasswordVerifier)
      : false;
    if (ok) return this.grantAccess(1);
    return this.failLogin();
  }

  private async checkLocalUser(line: string): Promise<ConsoleTurnResult> {
    const user = this.config.users.find((candidate) => candidate.enabled && candidate.username === this.pendingUsername);
    const ok = user ? await verifyPassword(line, user.passwordVerifier) : false;
    if (ok && user) {
      return this.grantAccess(user.privilegeLevel);
    }
    this.pendingUsername = "";
    return this.failLogin(true);
  }

  private grantAccess(privilegeLevel: number): ConsoleTurnResult {
    this.attempts = 0;
    if (privilegeLevel >= PRIVILEGE_LEVEL_ENABLE) {
      this.stateValue = "privileged-exec";
      this.hooks.setPrivileged?.(true);
    } else {
      this.stateValue = "authenticated-user-exec";
      this.hooks.setPrivileged?.(false);
    }
    return this.result("", true, true);
  }

  private failLogin(promptUsername = false): ConsoleTurnResult {
    this.attempts++;
    if (this.attempts >= this.config.maximumAttempts) {
      const restart = this.begin();
      return { ...restart, output: `% Authentication failed\n${restart.output}`, secret: true };
    }
    if (this.config.mode === "local-user") {
      this.stateValue = promptUsername ? "awaiting-username" : "awaiting-password";
      return this.result(`% Login invalid\n\n${promptUsername ? "Username:" : "Password:"}`, true);
    }
    this.stateValue = "awaiting-password";
    return this.result("% Login invalid\n\nPassword:", true);
  }

  private async checkEnable(line: string): Promise<ConsoleTurnResult> {
    const ok = this.config.enableSecretVerifier ? await verifyPassword(line, this.config.enableSecretVerifier) : false;
    if (ok) {
      this.stateValue = "privileged-exec";
      this.hooks.setPrivileged?.(true);
      return this.result("", true, true);
    }
    this.stateValue = "authenticated-user-exec";
    this.hooks.setPrivileged?.(false);
    return this.result("% Access denied", true, true);
  }

  private runCommand(line: string): ConsoleTurnResult {
    const trimmed = line.trim();
    if (this.stateValue === "authenticated-user-exec" && isPrefix(trimmed, "enable")) {
      if (this.config.enableSecretVerifier) {
        this.stateValue = "awaiting-enable-password";
        return this.result("Password:", false, true);
      }
      this.stateValue = "privileged-exec";
      this.hooks.setPrivileged?.(true);
    }
    const output = this.hooks.execute(line);
    return this.result(output, false, true);
  }

  private result(output: string, secret: boolean, authenticated = this.isAuthenticated()): ConsoleTurnResult {
    return { output, state: this.stateValue, secret, authenticated };
  }
}
