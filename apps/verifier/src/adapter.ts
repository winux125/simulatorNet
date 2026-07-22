import type { VerificationResult } from "@sim/contracts/grading";
import { verifySubmission, type VerificationLimits } from "@sim/grading-core";

export interface VerificationExecution {
  readonly result: VerificationResult;
  readonly durationMs: number;
}

/** Replaceable synchronous adapter boundary; API code never runs protocols. */
export function executeVerification(input: unknown, limits?: VerificationLimits): VerificationExecution {
  const started = performance.now();
  const result = verifySubmission(input, limits);
  const durationMs = Math.round((performance.now() - started) * 1_000) / 1_000;
  return { result, durationMs };
}
