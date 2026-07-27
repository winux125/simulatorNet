export const DEFAULT_WIRELESS_LIMITS = Object.freeze({
  maximumAccessPointsPerRadioDomain: 64,
  maximumStationsPerAccessPoint: 64,
  maximumScanResults: 32,
  maximumPendingWirelessFrames: 512,
  managementFrameDelayNs: 250_000,
  dataFrameDelayNs: 100_000,
});

export type WirelessLimits = typeof DEFAULT_WIRELESS_LIMITS;

export type WirelessLimitCode =
  | "access-points-per-radio-domain"
  | "stations-per-access-point"
  | "scan-results"
  | "association-attempts"
  | "pending-wireless-frames";

export class WirelessLimitError extends Error {
  readonly code = "wireless-limit";

  constructor(
    readonly limit: WirelessLimitCode,
    readonly actual: number,
    readonly maximum: number,
    readonly scope?: string,
  ) {
    super(`Wireless limit '${limit}' exceeded${scope ? ` on '${scope}'` : ""}: ${actual} > ${maximum}`);
    this.name = "WirelessLimitError";
  }
}
