import { LabSemanticError, LabValidationError, UnsupportedSchemaVersionError } from "@sim/lab-format";
import { FrameTraversalLimitError } from "@sim/sim-core";
import type { SerializedWorkerError } from "./protocol";

export class SimulationWorkerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly path?: string,
    readonly context?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "SimulationWorkerError";
  }
}

export class WorkerRequestTimeoutError extends Error {
  constructor(readonly requestId: string) {
    super(`Simulation worker request '${requestId}' timed out`);
    this.name = "WorkerRequestTimeoutError";
  }
}

export class WorkerTerminatedError extends Error {
  constructor() {
    super("Simulation worker was terminated");
    this.name = "WorkerTerminatedError";
  }
}

export function serializeWorkerError(error: unknown): SerializedWorkerError {
  if (error instanceof SimulationWorkerError) {
    return { name: error.name, code: error.code, message: error.message, path: error.path, context: error.context };
  }
  if (error instanceof LabSemanticError) {
    return { name: error.name, code: error.code, message: error.message, path: error.path, context: error.context };
  }
  if (error instanceof UnsupportedSchemaVersionError) {
    return { name: error.name, code: "unsupported-schema-version", message: error.message, context: { version: error.version } };
  }
  if (error instanceof LabValidationError) {
    const first = error.issues[0];
    return {
      name: error.name,
      code: "lab-validation-error",
      message: error.message,
      path: first?.path.join("."),
      context: first ? { issue: first.message } : undefined,
    };
  }
  if (error instanceof FrameTraversalLimitError) {
    return {
      name: error.name,
      code: error.code,
      message: error.message,
      context: { deviceId: error.deviceId, interfaceId: error.interfaceId },
    };
  }
  if (error instanceof Error) return { name: error.name, code: "runtime-error", message: error.message };
  return { name: "Error", code: "unknown-error", message: "Unknown simulation worker error" };
}
