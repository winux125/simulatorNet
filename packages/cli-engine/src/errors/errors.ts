/**
 * CLI errors. Handlers throw these; the session catches them and renders a
 * Cisco-like `% ...` line. We deliberately do not aim for full Cisco
 * error-message parity — just the few categories a learner meets early.
 */
export abstract class CliError extends Error {
  abstract render(): string;
}

/** A known command prefix is missing one or more required arguments. */
export class IncompleteCommandError extends CliError {
  constructor(readonly usage: string) {
    super("Incomplete command");
    this.name = "IncompleteCommandError";
  }
  override render(): string {
    return `% Incomplete command.\nUsage: ${this.usage}`;
  }
}

/** The command did not match any known syntax in the current mode. */
export class SyntaxError extends CliError {
  constructor(readonly offset = 0, message = "Invalid input detected") {
    super(message);
    this.name = "SyntaxError";
  }
  override render(): string {
    return `${" ".repeat(this.offset)}^\n% Invalid input detected at '^' marker.`;
  }
}

/** A command was recognised but is not valid for the device or mode/context. */
export class InvalidModeError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModeError";
  }
  override render(): string {
    return `% ${this.message}`;
  }
}

/** The syntax is known, but the attached device does not implement it. */
export class UnsupportedCapabilityError extends CliError {
  constructor(readonly capability: string) {
    super(`Unsupported capability: ${capability}`);
    this.name = "UnsupportedCapabilityError";
  }
  override render(): string {
    return `% This device does not support ${this.capability}.`;
  }
}

/** A recognised command carried an invalid argument (bad VLAN id, IP, etc.). */
export class ValidationError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
  override render(): string {
    return `% ${this.message}`;
  }
}
