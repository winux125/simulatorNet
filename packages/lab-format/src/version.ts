import {
  CURRENT_LAB_SCHEMA_VERSION,
  LabDocumentSchema,
  type LabDocument,
} from "@sim/contracts";
import { LabValidationError, UnsupportedSchemaVersionError } from "./errors";

function decodeInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input) as unknown;
  } catch (cause) {
    throw new LabValidationError("Lab document is not valid JSON", [], { cause });
  }
}

/** Central migration entry point. Version 1 is currently the only supported source. */
export function migrateLabDocument(input: unknown): LabDocument {
  const decoded = decodeInput(input);
  if (typeof decoded === "object" && decoded !== null && "schemaVersion" in decoded) {
    const version = (decoded as { schemaVersion?: unknown }).schemaVersion;
    if (version !== CURRENT_LAB_SCHEMA_VERSION) throw new UnsupportedSchemaVersionError(version);
  }

  const result = LabDocumentSchema.safeParse(decoded);
  if (!result.success) {
    throw new LabValidationError("Lab document failed schema validation", result.error.issues, {
      cause: result.error,
    });
  }
  return result.data;
}
