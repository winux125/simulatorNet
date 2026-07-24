import { z } from "zod";
import { TopologySchema } from "./topology";
import { LabDiagramSchema } from "./diagram";

/** The only lab JSON schema understood by this release. */
export const CURRENT_LAB_SCHEMA_VERSION = 1 as const;

export const Ipv4Schema = z.string().refine((value) => {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}, "Invalid IPv4 address");

export const PrefixLengthSchema = z.number().int().min(0).max(32);
export const VlanIdSchema = z.number().int().min(1).max(4094);

export const Ipv4InterfaceConfigSchema = z.object({
  address: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
});
export type Ipv4InterfaceConfig = z.infer<typeof Ipv4InterfaceConfigSchema>;

export const PhysicalInterfaceConfigSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  shutdown: z.boolean().default(false),
});
export type PhysicalInterfaceConfig = z.infer<typeof PhysicalInterfaceConfigSchema>;

export const PcDeviceConfigSchema = z.object({
  kind: z.literal("pc"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  ipv4: Ipv4InterfaceConfigSchema.extend({
    defaultGateway: Ipv4Schema.optional(),
  }).optional(),
  dhcpEnabled: z.boolean().default(false),
  dnsServer: Ipv4Schema.optional(),
});
export type PcDeviceConfig = z.infer<typeof PcDeviceConfigSchema>;

export const HostInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  ipv4: Ipv4InterfaceConfigSchema.optional(),
});
export type HostInterfaceConfig = z.infer<typeof HostInterfaceConfigSchema>;

const ServiceBaseSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
});

export const DnsRecordSchema = z.object({
  name: z.string().min(1).max(253).refine(
    (value) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.?$/i.test(value.trim()),
    "Invalid DNS name",
  ),
  address: Ipv4Schema,
}).strict();
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

export const DnsServiceConfigSchema = ServiceBaseSchema.extend({
  type: z.literal("dns"),
  port: z.number().int().min(1).max(65_535).default(53),
  records: z.array(DnsRecordSchema).max(256).default([]),
}).strict();
export type DnsServiceConfig = z.infer<typeof DnsServiceConfigSchema>;

export const HttpResourceSchema = z.object({
  path: z.string().min(1).max(512).refine(
    (value) => value.startsWith("/") && !value.includes("\\") && !value.includes(".."),
    "Invalid HTTP resource path",
  ),
  contentType: z.string().min(1).max(128).default("text/plain"),
  body: z.string().max(65_536),
}).strict();
export type HttpResource = z.infer<typeof HttpResourceSchema>;

export const HttpServiceConfigSchema = ServiceBaseSchema.extend({
  type: z.literal("http"),
  port: z.number().int().min(1).max(65_535).default(80),
  resources: z.array(HttpResourceSchema).max(128).default([]),
}).strict();
export type HttpServiceConfig = z.infer<typeof HttpServiceConfigSchema>;

export const TftpFileSchema = z.object({
  filename: z.string().min(1).max(255).refine(
    (value) => !value.includes("/") && !value.includes("\\") && !value.includes(".."),
    "Invalid TFTP filename",
  ),
  content: z.string().max(262_144),
}).strict();
export type TftpFile = z.infer<typeof TftpFileSchema>;

export const TftpServiceConfigSchema = ServiceBaseSchema.extend({
  type: z.literal("tftp"),
  port: z.number().int().min(1).max(65_535).default(69),
  files: z.array(TftpFileSchema).max(64).default([]),
}).strict();
export type TftpServiceConfig = z.infer<typeof TftpServiceConfigSchema>;

export const NtpServiceConfigSchema = ServiceBaseSchema.extend({
  type: z.literal("ntp"),
  port: z.number().int().min(1).max(65_535).default(123),
  offsetNs: z.number().int().default(0),
}).strict();
export type NtpServiceConfig = z.infer<typeof NtpServiceConfigSchema>;

export const SyslogServiceConfigSchema = ServiceBaseSchema.extend({
  type: z.literal("syslog"),
  port: z.number().int().min(1).max(65_535).default(514),
  retention: z.number().int().min(1).max(1_000).default(200),
}).strict();
export type SyslogServiceConfig = z.infer<typeof SyslogServiceConfigSchema>;

export const ServerServiceConfigSchema = z.discriminatedUnion("type", [
  DnsServiceConfigSchema,
  HttpServiceConfigSchema,
  TftpServiceConfigSchema,
  NtpServiceConfigSchema,
  SyslogServiceConfigSchema,
]);
export type ServerServiceConfig = z.infer<typeof ServerServiceConfigSchema>;

export const ServerDeviceConfigSchema = z.object({
  kind: z.literal("server"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(HostInterfaceConfigSchema).default([]),
  defaultGateway: Ipv4Schema.optional(),
  dhcpClientEnabled: z.boolean().default(false),
  dnsServer: Ipv4Schema.optional(),
  enabledServices: z.array(ServerServiceConfigSchema).max(16).default([]),
});
export type ServerDeviceConfig = z.infer<typeof ServerDeviceConfigSchema>;

export const HubDeviceConfigSchema = z.object({
  kind: z.literal("hub"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
});
export type HubDeviceConfig = z.infer<typeof HubDeviceConfigSchema>;

export const DEFAULT_BRIDGE_AGING_TIME_NS = 300_000_000_000;
export const BridgeDeviceConfigSchema = z.object({
  kind: z.literal("bridge"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  agingTimeNs: z.number().int().positive().default(DEFAULT_BRIDGE_AGING_TIME_NS),
});
export type BridgeDeviceConfig = z.infer<typeof BridgeDeviceConfigSchema>;

export const VlanConfigSchema = z.object({
  id: VlanIdSchema,
  name: z.string().min(1),
});
export type VlanConfig = z.infer<typeof VlanConfigSchema>;

export const SwitchInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  mode: z.enum(["access", "trunk"]).default("access"),
  accessVlan: VlanIdSchema.default(1),
  nativeVlan: VlanIdSchema.default(1),
  /** Omitted means every VLAN is allowed on the trunk. */
  allowedVlans: z.array(VlanIdSchema).optional(),
});
export type SwitchInterfaceConfig = z.infer<typeof SwitchInterfaceConfigSchema>;

export const SwitchDeviceConfigSchema = z.object({
  kind: z.literal("l2-switch"),
  hostname: z.string().min(1).optional(),
  vlans: z.array(VlanConfigSchema).default([]),
  interfaces: z.array(SwitchInterfaceConfigSchema).default([]),
});
export type SwitchDeviceConfig = z.infer<typeof SwitchDeviceConfigSchema>;

export const RouterPhysicalInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  /** Whether this physical port participates in layer 3. */
  routed: z.boolean().default(false),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
});
export type RouterPhysicalInterfaceConfig = z.infer<typeof RouterPhysicalInterfaceConfigSchema>;

export const RouterSubinterfaceConfigSchema = z.object({
  id: z.string().min(1),
  parentInterface: z.string().min(1),
  vlan: VlanIdSchema,
  native: z.boolean().default(false),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
});
export type RouterSubinterfaceConfig = z.infer<typeof RouterSubinterfaceConfigSchema>;

export const StaticRouteConfigSchema = z.object({
  network: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
  nextHop: Ipv4Schema,
});
export type StaticRouteConfig = z.infer<typeof StaticRouteConfigSchema>;

export const DhcpPoolConfigSchema = z.object({
  id: z.string().min(1),
  network: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
  defaultGateway: Ipv4Schema.optional(),
  rangeStart: Ipv4Schema,
  rangeEnd: Ipv4Schema,
  leaseSeconds: z.number().int().positive().default(86_400),
});
export type DhcpPoolConfigDocument = z.infer<typeof DhcpPoolConfigSchema>;

export const AclActionSchema = z.enum(["permit", "deny"]);
export const AclDirectionSchema = z.enum(["in", "out"]);
export const Ipv4AddressMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("host"), address: Ipv4Schema }).strict(),
  z.object({
    kind: z.literal("network"),
    address: Ipv4Schema,
    wildcard: Ipv4Schema,
  }).strict(),
]);
export const PortMatcherSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z.object({ kind: z.literal("eq"), port: z.number().int().min(1).max(65_535) }).strict(),
  z.object({
    kind: z.literal("range"),
    start: z.number().int().min(1).max(65_535),
    end: z.number().int().min(1).max(65_535),
  }).strict(),
]);
const StandardAclRuleSchema = z.object({
  sequence: z.number().int().nonnegative(),
  action: AclActionSchema,
  source: Ipv4AddressMatcherSchema,
}).strict();
const ExtendedAclRuleSchema = z.object({
  sequence: z.number().int().nonnegative(),
  action: AclActionSchema,
  protocol: z.union([z.literal("ip"), z.literal(1), z.literal(6), z.literal(17)]),
  source: Ipv4AddressMatcherSchema,
  destination: Ipv4AddressMatcherSchema,
  sourcePort: PortMatcherSchema.optional(),
  destinationPort: PortMatcherSchema.optional(),
}).strict();
export const Ipv4AclConfigSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1),
    type: z.literal("standard"),
    rules: z.array(StandardAclRuleSchema).max(256).default([]),
  }).strict(),
  z.object({
    id: z.string().min(1),
    type: z.literal("extended"),
    rules: z.array(ExtendedAclRuleSchema).max(256).default([]),
  }).strict(),
]);
export type Ipv4AclConfig = z.infer<typeof Ipv4AclConfigSchema>;

export const AclBindingConfigSchema = z.object({
  interfaceName: z.string().min(1),
  direction: AclDirectionSchema,
  aclId: z.string().min(1),
}).strict();
export type AclBindingConfig = z.infer<typeof AclBindingConfigSchema>;

export const NatPoolConfigSchema = z.object({
  id: z.string().min(1),
  startAddress: Ipv4Schema,
  endAddress: Ipv4Schema,
}).strict();
export type NatPoolConfig = z.infer<typeof NatPoolConfigSchema>;

export const NatRuleConfigSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    kind: z.literal("static"),
    insideLocal: Ipv4Schema,
    insideGlobal: Ipv4Schema,
  }).strict(),
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    kind: z.literal("dynamic"),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("any") }).strict(),
      z.object({ kind: z.literal("acl"), aclId: z.string().min(1) }).strict(),
    ]),
    poolId: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    kind: z.literal("pat"),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("any") }).strict(),
      z.object({ kind: z.literal("acl"), aclId: z.string().min(1) }).strict(),
    ]),
    outsideAddress: z.union([z.literal("interface"), Ipv4Schema]),
  }).strict(),
]);
export type NatRuleConfig = z.infer<typeof NatRuleConfigSchema>;

export const NatInterfaceRoleConfigSchema = z.object({
  interfaceName: z.string().min(1),
  role: z.enum(["inside", "outside"]),
}).strict();
export type NatInterfaceRoleConfig = z.infer<typeof NatInterfaceRoleConfigSchema>;

const RoutedSecurityConfigShape = {
  acls: z.array(Ipv4AclConfigSchema).max(64).default([]),
  aclBindings: z.array(AclBindingConfigSchema).max(128).default([]),
};

export const RouterDeviceConfigSchema = z.object({
  kind: z.literal("router"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(RouterPhysicalInterfaceConfigSchema).default([]),
  subinterfaces: z.array(RouterSubinterfaceConfigSchema).default([]),
  staticRoutes: z.array(StaticRouteConfigSchema).default([]),
  dhcpPools: z.array(DhcpPoolConfigSchema).default([]),
  ...RoutedSecurityConfigShape,
  natPools: z.array(NatPoolConfigSchema).max(32).default([]),
  natRules: z.array(NatRuleConfigSchema).max(128).default([]),
  natInterfaceRoles: z.array(NatInterfaceRoleConfigSchema).max(64).default([]),
});
export type RouterDeviceConfig = z.infer<typeof RouterDeviceConfigSchema>;

export const FirewallZoneConfigSchema = z.object({
  interfaceName: z.string().min(1),
  zone: z.string().min(1).max(64),
}).strict();
export type FirewallZoneConfig = z.infer<typeof FirewallZoneConfigSchema>;

export const FirewallPolicyConfigSchema = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  sourceZone: z.string().min(1).max(64),
  destinationZone: z.string().min(1).max(64),
  action: AclActionSchema,
  protocol: z.union([z.literal("ip"), z.literal(1), z.literal(6), z.literal(17)]),
  source: Ipv4AddressMatcherSchema.optional(),
  destination: Ipv4AddressMatcherSchema.optional(),
  sourcePort: PortMatcherSchema.optional(),
  destinationPort: PortMatcherSchema.optional(),
  states: z.array(z.enum(["NEW", "ESTABLISHED", "RELATED", "CLOSING", "EXPIRED"])).max(5).optional(),
}).strict();
export type FirewallPolicyConfig = z.infer<typeof FirewallPolicyConfigSchema>;

export const FirewallDeviceConfigSchema = RouterDeviceConfigSchema.extend({
  kind: z.literal("firewall"),
  zones: z.array(FirewallZoneConfigSchema).max(32).default([]),
  firewallPolicies: z.array(FirewallPolicyConfigSchema).max(256).default([]),
  defaultPolicy: AclActionSchema.default("deny"),
});
export type FirewallDeviceConfig = z.infer<typeof FirewallDeviceConfigSchema>;

export const CloudImpairmentConfigSchema = z.object({
  interfaceName: z.string().min(1),
  additionalLatencyNs: z.number().int().min(0).max(60_000_000_000),
  packetLossRate: z.number().min(0).max(1),
  note: z.string().max(512).optional(),
}).strict();
export type CloudImpairmentConfig = z.infer<typeof CloudImpairmentConfigSchema>;

export const CloudDeviceConfigSchema = RouterDeviceConfigSchema.extend({
  kind: z.literal("cloud"),
  impairments: z.array(CloudImpairmentConfigSchema).max(8).default([]),
});
export type CloudDeviceConfig = z.infer<typeof CloudDeviceConfigSchema>;

const TrafficFlowBaseSchema = z.object({
  id: z.string().min(1),
  destination: Ipv4Schema,
  count: z.number().int().min(1).max(1_024),
  intervalNs: z.number().int().min(0).max(60_000_000_000),
  payloadBytes: z.number().int().min(0).max(65_536).optional(),
});
export const TrafficFlowConfigSchema = z.discriminatedUnion("protocol", [
  TrafficFlowBaseSchema.extend({ protocol: z.literal("icmp") }).strict(),
  TrafficFlowBaseSchema.extend({
    protocol: z.literal("udp"),
    destinationPort: z.number().int().min(1).max(65_535),
    sourcePort: z.number().int().min(1).max(65_535).optional(),
  }).strict(),
  TrafficFlowBaseSchema.extend({
    protocol: z.literal("tcp"),
    destinationPort: z.number().int().min(1).max(65_535),
  }).strict(),
  TrafficFlowBaseSchema.extend({
    protocol: z.literal("http"),
    url: z.string().min(1).max(2_048),
  }).strict(),
]);
export type TrafficFlowConfig = z.infer<typeof TrafficFlowConfigSchema>;

export const TrafficGeneratorDeviceConfigSchema = PcDeviceConfigSchema.extend({
  kind: z.literal("traffic-generator"),
  flows: z.array(TrafficFlowConfigSchema).max(32).default([]),
});
export type TrafficGeneratorDeviceConfig = z.infer<typeof TrafficGeneratorDeviceConfigSchema>;

export const Layer3SwitchInterfaceConfigSchema = z.discriminatedUnion("mode", [
  SwitchInterfaceConfigSchema.extend({ mode: z.enum(["access", "trunk"]) }).strict(),
  PhysicalInterfaceConfigSchema.extend({
    mode: z.literal("routed"),
    ipv4: Ipv4InterfaceConfigSchema.optional(),
  }).strict(),
]);
export type Layer3SwitchInterfaceConfig = z.infer<typeof Layer3SwitchInterfaceConfigSchema>;

export const SviConfigSchema = z.object({
  vlanId: VlanIdSchema,
  ipAddress: Ipv4Schema.optional(),
  prefixLength: PrefixLengthSchema.optional(),
  adminUp: z.boolean().default(true),
  description: z.string().min(1).optional(),
});
export type SviConfig = z.infer<typeof SviConfigSchema>;

export const Layer3SwitchDeviceConfigSchema = z.object({
  kind: z.literal("l3-switch"),
  hostname: z.string().min(1).optional(),
  vlans: z.array(VlanConfigSchema).default([]),
  interfaces: z.array(Layer3SwitchInterfaceConfigSchema).default([]),
  svis: z.array(SviConfigSchema).default([]),
  staticRoutes: z.array(StaticRouteConfigSchema).default([]),
  ipRoutingEnabled: z.boolean().default(false),
  ...RoutedSecurityConfigShape,
});
export type Layer3SwitchDeviceConfig = z.infer<typeof Layer3SwitchDeviceConfigSchema>;

/**
 * Inert placeholder produced when a lab import contains a node SimulatorNet does
 * not simulate. It carries only source metadata and preserved (never executed)
 * startup text so the topology can still open, be inspected and be re-mapped.
 * It has no capabilities and never participates in the data plane.
 */
export const MAX_EXTERNAL_APPLIANCE_UNPARSED_CONFIG_CHARS = 20_000;
export const MAX_EXTERNAL_APPLIANCE_WARNINGS = 50;

export const ExternalApplianceAuthHintSchema = z.enum(["unknown", "likely-required", "none"]);
export type ExternalApplianceAuthHint = z.infer<typeof ExternalApplianceAuthHintSchema>;

export const ExternalApplianceDeviceConfigSchema = z.object({
  kind: z.literal("external-appliance"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  /** Platform the node was imported from, e.g. "pnetlab", "gns3", "containerlab". */
  sourcePlatform: z.string().min(1).max(64),
  sourceVendor: z.string().min(1).max(64).optional(),
  /** Original node type/kind string from the source platform. */
  sourceNodeKind: z.string().min(1).max(128).optional(),
  /** Original template/node-definition name from the source platform. */
  sourceTemplate: z.string().min(1).max(128).optional(),
  /** Presentation hint only; the renderer falls back to the generic icon. */
  sourceIconHint: z.string().min(1).max(128).optional(),
  /** Preserved startup text; never parsed as config and never executed. */
  unparsedConfig: z.string().max(MAX_EXTERNAL_APPLIANCE_UNPARSED_CONFIG_CHARS).optional(),
  importWarnings: z.array(z.string().max(512)).max(MAX_EXTERNAL_APPLIANCE_WARNINGS).default([]),
  authHint: ExternalApplianceAuthHintSchema.default("unknown"),
});
export type ExternalApplianceDeviceConfig = z.infer<typeof ExternalApplianceDeviceConfigSchema>;

export const DeviceConfigSchema = z.discriminatedUnion("kind", [
  PcDeviceConfigSchema,
  ServerDeviceConfigSchema,
  HubDeviceConfigSchema,
  BridgeDeviceConfigSchema,
  SwitchDeviceConfigSchema,
  Layer3SwitchDeviceConfigSchema,
  RouterDeviceConfigSchema,
  FirewallDeviceConfigSchema,
  CloudDeviceConfigSchema,
  TrafficGeneratorDeviceConfigSchema,
  ExternalApplianceDeviceConfigSchema,
]);
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

/**
 * Non-canonical provenance for a lab converted from another platform. It is
 * deliberately timestamp-free and never reaches the verifier (grading uses the
 * submission snapshot only), so it cannot perturb the deterministic grade.
 */
export const MAX_LAB_SOURCE_IMPORT_WARNINGS = 200;
export const LabSourceImportSchema = z.object({
  platform: z.string().min(1).max(64),
  originalFilename: z.string().min(1).max(255).optional(),
  sourceVersion: z.string().min(1).max(64).optional(),
  warnings: z.array(z.string().max(512)).max(MAX_LAB_SOURCE_IMPORT_WARNINGS).default([]),
}).strict();
export type LabSourceImport = z.infer<typeof LabSourceImportSchema>;

export const LabMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
  expectedOutcome: z.string().optional(),
  diagram: LabDiagramSchema.optional(),
  sourceImport: LabSourceImportSchema.optional(),
});
export type LabMetadata = z.infer<typeof LabMetadataSchema>;

export const LabSnapshotSchema = z.object({
  topology: TopologySchema,
  /** Device id -> structured, persistent configuration. */
  configurations: z.record(z.string(), DeviceConfigSchema).default({}),
});
export type LabSnapshot = z.infer<typeof LabSnapshotSchema>;

/**
 * Portable saved lab: metadata + topology + structured configuration + seed.
 * ARP/FDB caches, DHCP leases, queues, counters, trace and virtual time are
 * runtime state and deliberately never appear here.
 */
export const LabDocumentSchema = LabMetadataSchema.extend({
  schemaVersion: z.literal(CURRENT_LAB_SCHEMA_VERSION),
  simulation: z.object({ seed: z.number().int().nonnegative() }),
  topology: TopologySchema,
  configurations: z.record(z.string(), DeviceConfigSchema).default({}),
});
export type LabDocument = z.infer<typeof LabDocumentSchema>;

/** Browser-to-server submission boundary. Hidden grading rules live elsewhere. */
export const LabSubmissionDocumentSchema = z.object({
  labId: z.string().min(1),
  labVersion: z.number().int().nonnegative(),
  schemaVersion: z.literal(CURRENT_LAB_SCHEMA_VERSION),
  simulation: z.object({ seed: z.number().int().nonnegative() }),
  snapshot: LabSnapshotSchema,
  clientRevision: z.string().min(1).optional(),
});
export type LabSubmissionDocument = z.infer<typeof LabSubmissionDocumentSchema>;
