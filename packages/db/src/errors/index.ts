export type DatabaseErrorCode = "DB_CONFLICT" | "DB_NOT_FOUND" | "DB_FORBIDDEN" | "DB_INVALID_INPUT";

export class DatabaseError extends Error {
  constructor(readonly code: DatabaseErrorCode, message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class DatabaseConflictError extends DatabaseError {
  constructor(message: string) {
    super("DB_CONFLICT", message);
    this.name = "DatabaseConflictError";
  }
}

export class DatabaseNotFoundError extends DatabaseError {
  constructor(message: string) {
    super("DB_NOT_FOUND", message);
    this.name = "DatabaseNotFoundError";
  }
}

export class DatabaseForbiddenError extends DatabaseError {
  constructor(message: string) {
    super("DB_FORBIDDEN", message);
    this.name = "DatabaseForbiddenError";
  }
}

export class DatabaseInvalidInputError extends DatabaseError {
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super("DB_INVALID_INPUT", message);
    this.name = "DatabaseInvalidInputError";
  }
}

/** Optimistic-concurrency failure: the caller's expected revision was stale. */
export class DatabaseRevisionConflictError extends DatabaseConflictError {
  constructor(message: string, readonly currentRevision: number) {
    super(message);
    this.name = "DatabaseRevisionConflictError";
  }
}

/** A bounded resource (e.g. submission attempts) has been exhausted. */
export class DatabaseLimitReachedError extends DatabaseConflictError {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseLimitReachedError";
  }
}

/** Drizzle preserves PostgreSQL errors as a cause; walk that chain without leaking it. */
export function hasPostgresErrorCode(error: unknown, expectedCode: string): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === expectedCode) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
