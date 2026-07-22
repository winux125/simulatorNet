/**
 * CLI errors. Handlers throw these; the session catches them and renders a
 * Cisco-like `% ...` line. We deliberately do not aim for full Cisco
 * error-message parity — just the few categories a learner meets early.
 */
export abstract class CliError extends Error {
  abstract render(): string;
}

/** The command did not match any known syntax in the current mode. */
export class SyntaxError extends CliError {
  constructor(message = "Invalid input detected") {
    super(message);
    this.name = "SyntaxError";
  }
  override render(): string {
    return "% Invalid input detected at '^' marker.";
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
