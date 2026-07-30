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

/**
 * One line-oriented input request rendered by the terminal adapter.
 *
 * The text includes its exact trailing spacing and is written without a line
 * break. The line editor owns the single CRLF emitted when the learner submits
 * the value.
 */
export interface TerminalInputPrompt {
  readonly text: string;
  readonly echo: "plain" | "hidden";
  readonly history: boolean;
  readonly completion: "line";
}

export interface ConsoleTurnResult {
  readonly output: string;
  /** Prompt for the next line, kept separate from ordinary terminal output. */
  readonly prompt?: TerminalInputPrompt;
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
const USERNAME_PROMPT: TerminalInputPrompt = {
  text: "Username: ",
  echo: "plain",
  history: false,
  completion: "line",
};
const PASSWORD_PROMPT: TerminalInputPrompt = {
  text: "Password: ",
  echo: "hidden",
  history: false,
  completion: "line",
};
const PRESS_RETURN_PROMPT: TerminalInputPrompt = {
  text: "Press RETURN to get started!",
  echo: "plain",
  history: false,
  completion: "line",
};

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
    const loginOutput = this.config.loginBanner ? `${this.config.loginBanner}\n` : "";
    switch (this.config.mode) {
      case "press-return":
        this.stateValue = "awaiting-return";
        return this.result(loginOutput, false, false, PRESS_RETURN_PROMPT);
      case "password-only":
        this.stateValue = "awaiting-password";
        return this.result(loginOutput, false, false, PASSWORD_PROMPT);
      case "local-user":
        this.stateValue = "awaiting-username";
        return this.result(loginOutput, false, false, USERNAME_PROMPT);
      default:
        this.stateValue = "authenticated-user-exec";
        return this.result(this.motdOutput().trimEnd(), false, true);
    }
  }

  async submit(line: string): Promise<ConsoleTurnResult> {
    switch (this.stateValue) {
      case "awaiting-return":
        return this.grantAccess(1, false);
      case "awaiting-password":
        return this.config.mode === "local-user" ? this.checkLocalUser(line) : this.checkConsolePassword(line);
      case "awaiting-username":
        this.pendingUsername = line.trim();
        this.stateValue = "awaiting-password";
        return this.result("", false, false, PASSWORD_PROMPT);
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

  private grantAccess(privilegeLevel: number, secret = true): ConsoleTurnResult {
    this.attempts = 0;
    if (privilegeLevel >= PRIVILEGE_LEVEL_ENABLE) {
      this.stateValue = "privileged-exec";
      this.hooks.setPrivileged?.(true);
    } else {
      this.stateValue = "authenticated-user-exec";
      this.hooks.setPrivileged?.(false);
    }
    return this.result(this.motdOutput(), secret, true);
  }

  private failLogin(promptUsername = false): ConsoleTurnResult {
    this.attempts++;
    if (this.attempts >= this.config.maximumAttempts) {
      const restart = this.begin();
      return { ...restart, output: `% Authentication failed\n\n${restart.output}`, secret: true };
    }
    if (this.config.mode === "local-user") {
      this.stateValue = promptUsername ? "awaiting-username" : "awaiting-password";
      return this.result(
        "% Login invalid\n\n",
        true,
        false,
        promptUsername ? USERNAME_PROMPT : PASSWORD_PROMPT,
      );
    }
    this.stateValue = "awaiting-password";
    return this.result("% Login invalid\n\n", true, false, PASSWORD_PROMPT);
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
        return this.result("", false, true, PASSWORD_PROMPT);
      }
      this.stateValue = "privileged-exec";
      this.hooks.setPrivileged?.(true);
    }
    const output = this.hooks.execute(line);
    return this.result(output, false, true);
  }

  private result(
    output: string,
    secret: boolean,
    authenticated = this.isAuthenticated(),
    prompt?: TerminalInputPrompt,
  ): ConsoleTurnResult {
    return { output, prompt, state: this.stateValue, secret, authenticated };
  }

  private motdOutput(): string {
    return this.config.motdBanner ? `${this.config.motdBanner}\n` : "";
  }
}
