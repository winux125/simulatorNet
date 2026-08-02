/**
 * Turning configuration *text* into structured configuration.
 *
 * The flow is deliberately two-phase:
 *
 *   text -> inspectDeviceConfigurationText -> plan (preview, warnings, errors)
 *        -> applyDeviceConfigurationPlan   -> one complete DeviceConfig
 *
 * Nothing is replayed through an interactive terminal, and the apply step is
 * atomic: either the whole recognised configuration becomes the device's new
 * structured configuration, or nothing changes. Unsupported lines never apply
 * silently — the caller has to acknowledge them explicitly.
 */
import type { ConsoleAccessConfiguration, DeviceConfig, DeviceType } from "@sim/contracts";
import {
  isCredentialLine,
  parseConfigurationCredentials,
  redactConfigurationLine,
  summarizeConfigurationCredentials,
  type ConfigurationCredentialSummary,
} from "./credentials";
import { buildDeviceConfigFromIos } from "./ios-mapper";
import { parseIosConfig, type ConfigLineOutcome } from "./ios-parser";
import { DEFAULT_DEVICE_CONFIGURATION_LIMITS, type DeviceConfigurationLimits } from "./limits";
import { supportsDeviceConfigurationText } from "./render";

/**
 * Device kinds whose configuration text can be parsed back into structured
 * configuration. Every kind here is covered by the shared IOS-like parser.
 *
 * An access point, wireless router or server renders a readable configuration
 * and exports a `.cfg`, but its settings are applied through its own panels —
 * inventing a parser for a format nothing else writes would be a second, weaker
 * source of truth.
 */
const APPLICABLE_KINDS: ReadonlySet<DeviceType> = new Set<DeviceType>([
  "router",
  "firewall",
  "l2-switch",
  "l3-switch",
  "bridge",
]);

export function supportsDeviceConfigurationApply(kind: DeviceType): boolean {
  return APPLICABLE_KINDS.has(kind);
}

export type ConfigApplyErrorCode =
  | "device-kind-unsupported"
  | "text-too-large"
  | "too-many-lines"
  | "empty-configuration"
  | "no-recognised-configuration";

export interface ConfigApplyProblem {
  readonly code: ConfigApplyErrorCode;
  readonly message: string;
  /** 1-based source line, when the problem belongs to one. */
  readonly line?: number;
}

export interface ConfigApplyPlan {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  /** The hostname the text sets, or the device's current one. */
  readonly hostname: string;
  /** Per-line outcome, redacted and bounded. */
  readonly lines: readonly ConfigLineOutcome[];
  /** Lines beyond `maximumReportedLines`, counted but not listed. */
  readonly truncatedLines: number;
  readonly appliedCount: number;
  readonly unsupportedCount: number;
  /**
   * Credentials the text declares. Values are never present: a preview shows
   * that an enable secret or a local user will be converted to a verifier.
   */
  readonly credentials: readonly ConfigurationCredentialSummary[];
  readonly warnings: readonly string[];
  readonly problems: readonly ConfigApplyProblem[];
  /** The structured configuration a successful apply would install. */
  readonly configuration: DeviceConfig | undefined;
}

export interface InspectDeviceConfigurationOptions {
  readonly deviceId: string;
  readonly deviceType: DeviceType;
  /** Interfaces the device actually has; a line naming another is unsupported. */
  readonly interfaceIds: readonly string[];
  /** Used when the text does not set a hostname. */
  readonly fallbackHostname: string;
  readonly limits?: DeviceConfigurationLimits;
}

/**
 * Parse configuration text and describe exactly what applying it would do.
 *
 * Pure and synchronous: it derives no credential verifier and mutates nothing.
 */
export function inspectDeviceConfigurationText(
  text: string,
  options: InspectDeviceConfigurationOptions,
): ConfigApplyPlan {
  const limits = options.limits ?? DEFAULT_DEVICE_CONFIGURATION_LIMITS;
  const problems: ConfigApplyProblem[] = [];
  const warnings: string[] = [];
  const empty: ConfigApplyPlan = {
    deviceId: options.deviceId,
    deviceType: options.deviceType,
    hostname: options.fallbackHostname,
    lines: [],
    truncatedLines: 0,
    appliedCount: 0,
    unsupportedCount: 0,
    credentials: [],
    warnings,
    problems,
    configuration: undefined,
  };

  if (!supportsDeviceConfigurationApply(options.deviceType)) {
    problems.push({
      code: "device-kind-unsupported",
      message: supportsDeviceConfigurationText(options.deviceType)
        ? `A ${options.deviceType} renders a readable configuration but is configured through its own panels, not by applying text.`
        : `A ${options.deviceType} is configured through Desktop / IP Configuration, not through a configuration file.`,
    });
    return empty;
  }
  if (text.length > limits.maximumTextCharacters) {
    problems.push({
      code: "text-too-large",
      message: `Configuration text is larger than ${limits.maximumTextCharacters.toLocaleString("en-US")} characters.`,
    });
    return empty;
  }
  const sourceLineCount = text.split(/\r\n|\r|\n/u).length;
  if (sourceLineCount > limits.maximumTextLines) {
    problems.push({
      code: "too-many-lines",
      message: `Configuration text has more than ${limits.maximumTextLines.toLocaleString("en-US")} lines.`,
    });
    return empty;
  }
  if (text.trim().length === 0) {
    problems.push({ code: "empty-configuration", message: "The configuration text is empty." });
    return empty;
  }

  const parsed = parseIosConfig(text, options.interfaceIds);
  const built = buildDeviceConfigFromIos(
    options.deviceType,
    parsed,
    options.interfaceIds,
    options.fallbackHostname,
  );
  const credentials = summarizeConfigurationCredentials(parseConfigurationCredentials(text));

  const reported = parsed.lines.slice(0, limits.maximumReportedLines).map((entry) => ({
    ...entry,
    text: entry.text.length > limits.maximumReportedLineCharacters
      ? `${entry.text.slice(0, limits.maximumReportedLineCharacters)}…`
      : entry.text,
  }));
  const appliedCount = parsed.lines.filter((entry) => entry.outcome === "applied").length;
  const unsupportedCount = parsed.lines.length - appliedCount;

  if (built.droppedRoutes > 0) {
    warnings.push(`${built.droppedRoutes} static route(s) were not applied: the next hop is not on a directly connected network.`);
  }
  if (credentials.some((entry) => entry.kind === "vendor-hash")) {
    warnings.push("A vendor password hash cannot be verified and was not imported; set a new password on the device.");
  }
  if (credentials.length > 0) {
    warnings.push(`${credentials.filter((entry) => entry.kind !== "vendor-hash").length} credential(s) will be stored as verifiers; no password is kept in the clear.`);
  }
  if (parsed.vpn.ikePeers.some((peer) => peer.credentialResetRequired)) {
    warnings.push("A pre-shared key was declared but never imported; set it again before the tunnel can protect traffic.");
  }
  if (appliedCount === 0) {
    problems.push({
      code: "no-recognised-configuration",
      message: "No supported configuration command was recognised in this text.",
    });
  }

  return {
    deviceId: options.deviceId,
    deviceType: options.deviceType,
    hostname: parsed.hostname ?? options.fallbackHostname,
    lines: reported,
    truncatedLines: Math.max(0, parsed.lines.length - reported.length),
    appliedCount,
    unsupportedCount,
    credentials,
    warnings,
    problems,
    configuration: built.config,
  };
}

export type ConfigApplyStatus = "applied" | "rejected" | "requires-confirmation";

export interface ConfigApplyResult {
  readonly status: ConfigApplyStatus;
  /** Present only when `status` is `applied`. */
  readonly configuration?: DeviceConfig;
  readonly message: string;
  readonly problems: readonly ConfigApplyProblem[];
}

export interface ApplyDeviceConfigurationOptions {
  /**
   * The device's current structured configuration. Settings the text parser
   * does not read — console access, remote access, AAA and SNMP — are carried
   * over from it, so pasting an interface block never silently erases a
   * device's credentials or its management plane.
   */
  readonly current: DeviceConfig;
  /**
   * Console access derived from the text by the caller (credential derivation
   * is asynchronous). When omitted, `current.consoleAccess` is kept.
   */
  readonly consoleAccess?: ConsoleAccessConfiguration;
  /** Required before a plan with unsupported lines may be applied. */
  readonly acceptUnsupportedLines?: boolean;
}

const CARRIED_OVER_KEYS = ["remoteAccess", "aaa", "snmp"] as const;

/**
 * Install a plan's configuration, atomically.
 *
 * A plan carrying any problem is rejected outright; a plan with unsupported
 * lines needs `acceptUnsupportedLines`. Nothing partial is ever written.
 */
export function applyDeviceConfigurationPlan(
  plan: ConfigApplyPlan,
  options: ApplyDeviceConfigurationOptions,
): ConfigApplyResult {
  if (plan.problems.length > 0 || !plan.configuration) {
    return {
      status: "rejected",
      message: plan.problems[0]?.message ?? "The configuration text could not be applied.",
      problems: plan.problems,
    };
  }
  if (plan.configuration.kind !== options.current.kind) {
    return {
      status: "rejected",
      message: `This configuration is for a ${plan.configuration.kind}, not a ${options.current.kind}.`,
      problems: [{ code: "device-kind-unsupported", message: "Device kind mismatch" }],
    };
  }
  if (plan.unsupportedCount > 0 && !options.acceptUnsupportedLines) {
    return {
      status: "requires-confirmation",
      message: `${plan.unsupportedCount} line(s) are not supported. Confirm to apply the recognised configuration and skip them.`,
      problems: [],
    };
  }

  // Start from the parsed result, then restore everything the text parser does
  // not describe. A property the parser never writes must survive the apply.
  const next: Record<string, unknown> = { ...plan.configuration };
  const current = options.current as unknown as Record<string, unknown>;
  if (options.consoleAccess !== undefined) next.consoleAccess = options.consoleAccess;
  else if ("consoleAccess" in options.current) next.consoleAccess = current.consoleAccess;
  for (const key of CARRIED_OVER_KEYS) {
    if (key in options.current) next[key] = current[key];
  }
  if (options.current.kind === "l2-switch") {
    next.managementSvi = current.managementSvi;
    next.managementDefaultGateway = current.managementDefaultGateway;
  }
  return {
    status: "applied",
    configuration: next as DeviceConfig,
    message: `Applied ${plan.appliedCount} configuration line(s)`
      + (plan.unsupportedCount > 0 ? `; skipped ${plan.unsupportedCount} unsupported line(s).` : "."),
    problems: [],
  };
}

export { isCredentialLine, redactConfigurationLine };
export type { ConfigLineOutcome, ConfigurationCredentialSummary };
