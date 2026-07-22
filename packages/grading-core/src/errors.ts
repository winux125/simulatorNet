export type VerificationErrorCode =
  | "invalid-request"
  | "invalid-submission"
  | "invalid-grading-spec"
  | "resource-limit"
  | "verification-failed";

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

export class VerificationResourceLimitError extends VerificationError {
  constructor(readonly limit: string, actual: number, maximum: number) {
    super("resource-limit", `Verification limit '${limit}' exceeded`, { limit, actual, maximum });
    this.name = "VerificationResourceLimitError";
  }
}
