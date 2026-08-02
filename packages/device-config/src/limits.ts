/**
 * Every bound the configuration text surface enforces. One central place, so no
 * caller invents its own limit and no unbounded text can reach the parser, a
 * report, a `.cfg` projection or a lab package.
 */
export interface DeviceConfigurationLimits {
  /** Characters accepted for one device's configuration text. */
  readonly maximumTextCharacters: number;
  /** Lines accepted for one device's configuration text. */
  readonly maximumTextLines: number;
  /** Characters of one source line the report will echo. */
  readonly maximumReportedLineCharacters: number;
  /** Line outcomes a single plan reports; the rest are counted only. */
  readonly maximumReportedLines: number;
}

export const DEFAULT_DEVICE_CONFIGURATION_LIMITS: DeviceConfigurationLimits = Object.freeze({
  maximumTextCharacters: 262_144,
  maximumTextLines: 5_000,
  maximumReportedLineCharacters: 400,
  maximumReportedLines: 1_000,
});
