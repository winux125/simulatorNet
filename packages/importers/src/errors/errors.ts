export type ImportErrorCode =
  | "empty-input"
  | "input-too-large"
  | "unsupported-format"
  | "recognized-unsupported"
  | "no-adapter"
  | "archive-invalid"
  | "archive-too-many-entries"
  | "archive-uncompressed-too-large"
  | "archive-entry-too-large"
  | "archive-compression-ratio"
  | "archive-path-traversal"
  | "archive-absolute-path"
  | "archive-symlink"
  | "archive-nested"
  | "archive-duplicate-path"
  | "xml-doctype-forbidden"
  | "xml-entity-forbidden"
  | "xml-too-deep"
  | "xml-too-large"
  | "xml-malformed"
  | "yaml-tag-forbidden"
  | "yaml-alias-forbidden"
  | "yaml-too-deep"
  | "yaml-too-large"
  | "yaml-malformed"
  | "topology-too-large"
  | "too-many-nodes"
  | "too-many-links"
  | "adapter-error"
  | "plan-invalid"
  // --- native `.simlab` package ---
  | "package-invalid"
  | "package-too-large"
  | "package-unsupported-version";

/** Base error for any refused or failed import. Carries a stable machine code. */
export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ImportError";
  }
}

/**
 * Raised specifically when untrusted content trips a security guard (archive
 * bombs, path traversal, symlinks, XML entities, YAML tags). Kept as a distinct
 * type so callers can surface "blocked for safety" separately from "malformed".
 */
export class ImportSecurityError extends ImportError {
  constructor(code: ImportErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(code, message, detail);
    this.name = "ImportSecurityError";
  }
}

/** Raised when a file is recognised but has no supported conversion contract. */
export class UnsupportedImportFormatError extends ImportError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super("recognized-unsupported", message, detail);
    this.name = "UnsupportedImportFormatError";
  }
}
