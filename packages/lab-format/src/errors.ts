import type { ZodIssue } from "zod";

export class LabFormatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LabFormatError";
  }
}

export class LabValidationError extends LabFormatError {
  constructor(
    message: string,
    readonly issues: readonly ZodIssue[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LabValidationError";
  }
}

export class LabSemanticError extends LabFormatError {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${path}: ${message}`);
    this.name = "LabSemanticError";
  }
}

export class UnsupportedSchemaVersionError extends LabFormatError {
  constructor(readonly version: unknown) {
    super(`Unsupported lab schema version: ${String(version)}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}
