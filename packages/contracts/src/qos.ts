import { z } from "zod";
import {
  Ipv4AddressMatcherSchema,
  Ipv6AddressMatcherSchema,
  PortMatcherSchema,
} from "./primitives";

/**
 * Serializable Quality of Service configuration.
 *
 * Only *configuration* lives here. Queued packets, token counts, scheduler
 * cursors, counters, drops and measured waiting times are runtime state and
 * deliberately never appear in a `LabDocument`.
 */

export const DscpValueSchema = z.number().int().min(0).max(63);
export const IpPrecedenceValueSchema = z.number().int().min(0).max(7);
export const CosValueSchema = z.number().int().min(0).max(7);

export const MAXIMUM_DSCP = 63;
export const MAXIMUM_IP_PRECEDENCE = 7;
export const MAXIMUM_COS = 7;

/**
 * The symbolic DSCP vocabulary shared by the CLI, the importer and the UI. It
 * is serializable data, so it lives here rather than in the engine.
 */
export const DSCP_NAMES: Readonly<Record<string, number>> = Object.freeze({
  default: 0,
  cs0: 0,
  cs1: 8,
  cs2: 16,
  cs3: 24,
  cs4: 32,
  cs5: 40,
  cs6: 48,
  cs7: 56,
  af11: 10,
  af12: 12,
  af13: 14,
  af21: 18,
  af22: 20,
  af23: 22,
  af31: 26,
  af32: 28,
  af33: 30,
  af41: 34,
  af42: 36,
  af43: 38,
  ef: 46,
});

/** Preferred name per value, so `show` output is stable and unambiguous. */
const CANONICAL_DSCP_NAME: Readonly<Record<number, string>> = Object.freeze({
  0: "default",
  8: "cs1",
  10: "af11",
  12: "af12",
  14: "af13",
  16: "cs2",
  18: "af21",
  20: "af22",
  22: "af23",
  24: "cs3",
  26: "af31",
  28: "af32",
  30: "af33",
  32: "cs4",
  34: "af41",
  36: "af42",
  38: "af43",
  40: "cs5",
  46: "ef",
  48: "cs6",
  56: "cs7",
});

/** `ef`, `af31`, `cs5`, `default` or a numeric 0-63 token; undefined if invalid. */
export function parseDscpToken(token: string): number | undefined {
  const normalized = token.trim().toLowerCase();
  if (normalized.length === 0) return undefined;
  const named = DSCP_NAMES[normalized];
  if (named !== undefined) return named;
  const numeric = Number(normalized);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= MAXIMUM_DSCP ? numeric : undefined;
}

/** The canonical symbolic name of a DSCP value, or its number when unnamed. */
export function dscpName(value: number): string {
  return CANONICAL_DSCP_NAME[value] ?? String(value);
}

/** The three most significant DSCP bits, which is what IP precedence is. */
export function precedenceOfDscp(dscp: number): number {
  return (dscp >> 3) & 0b111;
}

export const QOS_CONFIG_LIMITS = Object.freeze({
  maximumClassMaps: 32,
  maximumPolicyMaps: 16,
  maximumClassesPerPolicy: 8,
  maximumMatchRulesPerClass: 8,
  maximumServicePolicies: 64,
});

export const QosMatchRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("access-group"), aclId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("ipv6-access-group"), aclId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("protocol"), protocol: z.enum(["icmp", "tcp", "udp"]) }).strict(),
  z.object({ kind: z.literal("source-port"), port: PortMatcherSchema }).strict(),
  z.object({ kind: z.literal("destination-port"), port: PortMatcherSchema }).strict(),
  z.object({ kind: z.literal("dscp"), values: z.array(DscpValueSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("precedence"), values: z.array(IpPrecedenceValueSchema).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("cos"), values: z.array(CosValueSchema).min(1).max(8) }).strict(),
  z.object({
    kind: z.literal("source-prefix"),
    ipv4: Ipv4AddressMatcherSchema.optional(),
    ipv6: Ipv6AddressMatcherSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("destination-prefix"),
    ipv4: Ipv4AddressMatcherSchema.optional(),
    ipv6: Ipv6AddressMatcherSchema.optional(),
  }).strict(),
  /** Internal test metadata; deliberately not part of the Cisco-like CLI. */
  z.object({ kind: z.literal("traffic-flow"), flowId: z.string().min(1).max(64) }).strict(),
]);
export type QosMatchRuleConfig = z.infer<typeof QosMatchRuleSchema>;

export const QosClassMapConfigSchema = z.object({
  id: z.string().min(1).max(64),
  matchType: z.enum(["match-all", "match-any"]).default("match-any"),
  matches: z.array(QosMatchRuleSchema).max(QOS_CONFIG_LIMITS.maximumMatchRulesPerClass).default([]),
}).strict();
export type QosClassMapConfig = z.infer<typeof QosClassMapConfigSchema>;

export const QosMarkingActionSchema = z.object({
  dscp: DscpValueSchema.optional(),
  precedence: IpPrecedenceValueSchema.optional(),
  cos: CosValueSchema.optional(),
}).strict();
export type QosMarkingActionConfig = z.infer<typeof QosMarkingActionSchema>;

export const QosPolicerConfigSchema = z.object({
  rateBps: z.number().int().min(8_000).max(100_000_000_000),
  burstBytes: z.number().int().min(64).max(16_777_216),
  exceedAction: z.enum(["drop", "set-dscp-transmit"]).default("drop"),
  exceedDscp: DscpValueSchema.optional(),
}).strict();
export type QosPolicerConfig = z.infer<typeof QosPolicerConfigSchema>;

export const QosShaperConfigSchema = z.object({
  averageRateBps: z.number().int().min(8_000).max(100_000_000_000),
  burstBytes: z.number().int().min(64).max(16_777_216).optional(),
}).strict();
export type QosShaperConfig = z.infer<typeof QosShaperConfigSchema>;

export const QosPriorityConfigSchema = z.object({
  percent: z.number().int().min(1).max(100).optional(),
  rateBps: z.number().int().min(8_000).max(100_000_000_000).optional(),
}).strict();
export type QosPriorityConfig = z.infer<typeof QosPriorityConfigSchema>;

export const QosPolicyClassConfigSchema = z.object({
  /** A class-map id, or the reserved `class-default`. */
  className: z.string().min(1).max(64),
  marking: QosMarkingActionSchema.optional(),
  priority: QosPriorityConfigSchema.optional(),
  bandwidthPercent: z.number().int().min(1).max(100).optional(),
  police: QosPolicerConfigSchema.optional(),
  shape: QosShaperConfigSchema.optional(),
  queueLimitPackets: z.number().int().min(1).max(4_096).optional(),
}).strict();
export type QosPolicyClassConfig = z.infer<typeof QosPolicyClassConfigSchema>;

export const QosPolicyMapConfigSchema = z.object({
  id: z.string().min(1).max(64),
  classes: z.array(QosPolicyClassConfigSchema).max(QOS_CONFIG_LIMITS.maximumClassesPerPolicy).default([]),
}).strict();
export type QosPolicyMapConfig = z.infer<typeof QosPolicyMapConfigSchema>;

export const QosServicePolicyConfigSchema = z.object({
  interfaceName: z.string().min(1).max(64),
  direction: z.enum(["input", "output"]),
  policyMapId: z.string().min(1).max(64),
}).strict();
export type QosServicePolicyConfig = z.infer<typeof QosServicePolicyConfigSchema>;

export const QosConfigurationSchema = z.object({
  classMaps: z.array(QosClassMapConfigSchema).max(QOS_CONFIG_LIMITS.maximumClassMaps).default([]),
  policyMaps: z.array(QosPolicyMapConfigSchema).max(QOS_CONFIG_LIMITS.maximumPolicyMaps).default([]),
  servicePolicies: z.array(QosServicePolicyConfigSchema).max(QOS_CONFIG_LIMITS.maximumServicePolicies).default([]),
}).strict();
export type QosConfiguration = z.infer<typeof QosConfigurationSchema>;

export const EMPTY_QOS_CONFIGURATION: QosConfiguration = Object.freeze({
  classMaps: [],
  policyMaps: [],
  servicePolicies: [],
});

/** Absent-equivalent, so an untouched lab round-trips without a `qos` block. */
export function isDefaultQosConfiguration(configuration: QosConfiguration | undefined): boolean {
  if (!configuration) return true;
  return configuration.classMaps.length === 0
    && configuration.policyMaps.length === 0
    && configuration.servicePolicies.length === 0;
}
