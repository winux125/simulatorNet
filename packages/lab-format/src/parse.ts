import type { LabDocument } from "@sim/contracts";
import { validateLabSemantics } from "./semantic";
import { migrateLabDocument } from "./version";

export function parseLabDocument(input: unknown): LabDocument {
  const document = migrateLabDocument(input);
  validateLabSemantics(document);
  return document;
}
