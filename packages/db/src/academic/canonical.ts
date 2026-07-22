import { createHash } from "node:crypto";
import type { LabDocument } from "@sim/contracts";
import { GradingSpecSchema, type GradingSpec } from "@sim/contracts/grading";
import { canonicalizeLabDocument, LabFormatError, LabSemanticError, stringifyLabDocument } from "@sim/lab-format";
import { DatabaseInvalidInputError } from "../errors/index";

export interface CanonicalLabDocument {
  readonly document: LabDocument;
  readonly canonicalHash: string;
  readonly schemaVersion: number;
}

/**
 * Validate, canonicalize and hash an untrusted lab document at the persistence
 * boundary. The hash is a SHA-256 of the canonical JSON, computed by the server
 * — a client-provided hash is never trusted.
 */
export function canonicalizeLab(input: unknown): CanonicalLabDocument {
  let document: LabDocument;
  try {
    document = canonicalizeLabDocument(input as LabDocument);
  } catch (error) {
    if (error instanceof LabSemanticError) {
      throw new DatabaseInvalidInputError(error.message, { code: error.code, path: error.path });
    }
    if (error instanceof LabFormatError) {
      throw new DatabaseInvalidInputError(error.message);
    }
    throw new DatabaseInvalidInputError(error instanceof Error ? error.message : "Invalid lab document");
  }
  const canonicalHash = createHash("sha256").update(stringifyLabDocument(document)).digest("hex");
  return { document, canonicalHash, schemaVersion: document.schemaVersion };
}

/** Validate a grading specification against the server-only grading contract. */
export function validateGradingSpec(input: unknown): GradingSpec {
  const result = GradingSpecSchema.safeParse(input);
  if (!result.success) {
    throw new DatabaseInvalidInputError("Grading specification failed validation", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}
