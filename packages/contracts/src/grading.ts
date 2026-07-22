import { z } from "zod";
import { DeviceCapabilitySchema, DeviceTypeSchema } from "./devices";
import { Ipv4Schema, LabSubmissionDocumentSchema, PrefixLengthSchema, VlanIdSchema } from "./lab";

export const GradingVisibilitySchema = z.enum(["hidden", "visible"]);
export type GradingVisibility = z.infer<typeof GradingVisibilitySchema>;

const CheckIdentitySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  points: z.number().nonnegative(),
  visibility: GradingVisibilitySchema,
});

export const PingGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ping"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    destinationIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]),
  }),
});

export const InterfaceStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("interface-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedAdminUp: z.boolean(),
  }),
});

export const SwitchportGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("switchport"),
  configuration: z.object({
    deviceId: z.string().min(1),
    interfaceId: z.string().min(1),
    expectedMode: z.enum(["access", "trunk"]),
    expectedAccessVlan: VlanIdSchema.optional(),
  }),
});

export const VlanExistsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("vlan-exists"),
  configuration: z.object({ deviceId: z.string().min(1), vlanId: VlanIdSchema }),
});

export const RouteExistsGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("route-exists"),
  configuration: z.object({
    deviceId: z.string().min(1),
    network: Ipv4Schema,
    prefixLength: PrefixLengthSchema,
  }),
});

export const Ipv4CidrSchema = z.string().refine((value) => {
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  return Ipv4Schema.safeParse(parts[0]).success && PrefixLengthSchema.safeParse(Number(parts[1])).success;
}, "Invalid IPv4 CIDR");

export const DhcpAddressGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dhcp-address"),
  configuration: z.object({ deviceId: z.string().min(1), expectedSubnet: Ipv4CidrSchema }),
});

export const DeviceTypeGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("device-type"),
  configuration: z.object({ deviceId: z.string().min(1), expectedType: DeviceTypeSchema }),
});

export const CapabilityPresentGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("capability-present"),
  configuration: z.object({ deviceId: z.string().min(1), capability: DeviceCapabilitySchema }),
});

export const SviStateGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("svi-state"),
  configuration: z.object({
    deviceId: z.string().min(1),
    vlanId: VlanIdSchema,
    expectedAdminUp: z.boolean(),
    expectedOperationalUp: z.boolean(),
  }),
});

export const IpRoutingEnabledGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ip-routing-enabled"),
  configuration: z.object({ deviceId: z.string().min(1), expected: z.boolean() }),
});

export const DnsRecordGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dns-record"),
  configuration: z.object({
    deviceId: z.string().min(1),
    hostname: z.string().min(1),
    expectedAddress: Ipv4Schema,
  }),
});

export const DnsResolutionGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("dns-resolution"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    hostname: z.string().min(1),
    dnsServer: Ipv4Schema.optional(),
    expectedAddress: Ipv4Schema,
  }),
});

export const HttpResponseGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("http-response"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    url: z.string().min(1),
    expectedStatus: z.number().int().min(100).max(599),
    expectedBody: z.string().optional(),
  }),
});

export const TftpFileGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tftp-file"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverIp: Ipv4Schema,
    filename: z.string().min(1),
    expectedContent: z.string().optional(),
  }),
});

export const NtpResponseGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("ntp-response"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverIp: Ipv4Schema,
    expected: z.enum(["success", "failure"]).default("success"),
  }),
});

export const SyslogReceivedGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("syslog-received"),
  configuration: z.object({
    sourceDeviceId: z.string().min(1),
    serverDeviceId: z.string().min(1),
    severity: z.enum(["emergency", "alert", "critical", "error", "warning", "notice", "informational", "debug"]),
    message: z.string().min(1),
  }),
});

export const TcpListenerGradingCheckSchema = CheckIdentitySchema.extend({
  type: z.literal("tcp-listener"),
  configuration: z.object({
    deviceId: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
  }),
});

export const GradingCheckSchema = z.discriminatedUnion("type", [
  PingGradingCheckSchema,
  InterfaceStateGradingCheckSchema,
  SwitchportGradingCheckSchema,
  VlanExistsGradingCheckSchema,
  RouteExistsGradingCheckSchema,
  DhcpAddressGradingCheckSchema,
  DeviceTypeGradingCheckSchema,
  CapabilityPresentGradingCheckSchema,
  SviStateGradingCheckSchema,
  IpRoutingEnabledGradingCheckSchema,
  DnsRecordGradingCheckSchema,
  DnsResolutionGradingCheckSchema,
  HttpResponseGradingCheckSchema,
  TftpFileGradingCheckSchema,
  NtpResponseGradingCheckSchema,
  SyslogReceivedGradingCheckSchema,
  TcpListenerGradingCheckSchema,
]);
export type GradingCheck = z.infer<typeof GradingCheckSchema>;

export const GradingSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  checks: z.array(GradingCheckSchema),
});
export type GradingSpec = z.infer<typeof GradingSpecSchema>;

export const VerificationResultViewSchema = z.enum(["student", "instructor"]);
export type VerificationResultView = z.infer<typeof VerificationResultViewSchema>;

export const VerificationRequestSchema = z.object({
  submission: LabSubmissionDocumentSchema,
  gradingSpec: GradingSpecSchema,
  resultView: VerificationResultViewSchema.default("student"),
  /** Deliberately ignored untrusted browser claim, retained for boundary tests. */
  score: z.unknown().optional(),
});
export type VerificationRequest = z.infer<typeof VerificationRequestSchema>;

export const VerificationCheckResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["passed", "failed", "error"]),
  awardedPoints: z.number().nonnegative(),
  maximumPoints: z.number().nonnegative(),
  message: z.string(),
  title: z.string().optional(),
  visibility: GradingVisibilitySchema.optional(),
  diagnostics: z.record(z.unknown()).optional(),
});
export type VerificationCheckResult = z.infer<typeof VerificationCheckResultSchema>;

export const VerificationResultSchema = z.object({
  verificationId: z.string().min(1),
  status: z.literal("completed"),
  resultView: VerificationResultViewSchema,
  score: z.number().min(0).max(100),
  awardedPoints: z.number().nonnegative(),
  maximumPoints: z.number().nonnegative(),
  checks: z.array(VerificationCheckResultSchema),
  engine: z.object({
    schemaVersion: z.literal(1),
    simulationSeed: z.number().int().nonnegative(),
    processedEvents: z.number().int().nonnegative(),
    virtualTimeNs: z.number().nonnegative(),
  }),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;
