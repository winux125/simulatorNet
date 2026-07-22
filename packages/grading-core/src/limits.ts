export interface VerificationLimits {
  readonly maximumNodes: number;
  readonly maximumLinks: number;
  readonly maximumInterfaces: number;
  readonly maximumGradingChecks: number;
  readonly maximumVirtualEvents: number;
  readonly maximumVirtualTimeNs: number;
  readonly maximumTraceRecords: number;
  readonly maximumJsonPayloadBytes: number;
}

/** Central MVP safety envelope shared by grading-core and the HTTP adapter. */
export const DEFAULT_VERIFICATION_LIMITS: VerificationLimits = Object.freeze({
  maximumNodes: 64,
  maximumLinks: 128,
  maximumInterfaces: 512,
  maximumGradingChecks: 100,
  maximumVirtualEvents: 50_000,
  maximumVirtualTimeNs: 60_000_000_000,
  maximumTraceRecords: 2_000,
  maximumJsonPayloadBytes: 1_000_000,
});
