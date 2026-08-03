import { z } from "zod";
import { TopologySchema } from "./topology";
import { LabDiagramSchema } from "./diagram";
import { LabPhysicalLayoutSchema } from "./physical";
import { ConsoleAccessConfigurationSchema } from "./console";
import { ManagementSviConfigSchema, RemoteAccessConfigurationSchema } from "./management";
import { AaaConfigurationSchema, RadiusServiceConfigSchema, TacacsServiceConfigSchema } from "./aaa";
import { NetworkManagementServiceConfigSchema, SnmpAgentConfigurationSchema } from "./snmp";
import {
  Ipv4AddressMatcherSchema,
  Ipv4InterfaceConfigSchema,
  Ipv4Schema,
  IpAddressSchema,
  Ipv6AddressMatcherSchema,
  Ipv6InterfaceAddressSchema,
  Ipv6PrefixLengthSchema,
  Ipv6Schema,
  PortMatcherSchema,
  PrefixLengthSchema,
  VlanIdSchema,
} from "./primitives";
import {
  LdpConfigSchema,
  NeighborDiscoveryConfigSchema,
  RoutedControlProtocolShape,
  SwitchControlProtocolShape,
  VrfConfigSchema,
} from "./protocols";
import {
  WirelessAccessPointConfigurationSchema,
  WirelessRadioSettingsSchema,
  WirelessStationConfigurationSchema,
} from "./wireless";
import { CosValueSchema, DscpValueSchema, QosConfigurationSchema } from "./qos";
import { VpnConfigurationSchema } from "./vpn";

/** The only lab JSON schema understood by this release. */
export const CURRENT_LAB_SCHEMA_VERSION = 1 as const;

export {
  Ipv4AddressMatcherSchema,
  Ipv4InterfaceConfigSchema,
  Ipv4Schema,
  Ipv6AddressMatcherSchema,
  Ipv6CidrSchema,
  Ipv6PrefixLengthSchema,
  Ipv6Schema,
  PortMatcherSchema,
  PrefixLengthSchema,
  VlanIdSchema,
  type Ipv4InterfaceConfig,
  type Ipv6InterfaceAddress,
} from "./primitives";

export const PhysicalInterfaceConfigSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).optional(),
  shutdown: z.boolean().default(false),
});
export type PhysicalInterfaceConfig = z.infer<typeof PhysicalInterfaceConfigSchema>;

export const HostIpv6ConfigSchema = z.object({
  mode: z.enum(["static", "slaac", "dhcpv6"]).default("static"),
  address: Ipv6Schema.optional(),
  prefixLength: Ipv6PrefixLengthSchema.optional(),
  defaultRouter: Ipv6Schema.optional(),
  dnsServer: Ipv6Schema.optional(),
}).strict();
export type HostIpv6Config = z.infer<typeof HostIpv6ConfigSchema>;

export const Dhcpv6PoolConfigSchema = z.object({
  id: z.string().min(1),
  prefix: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
  rangeStart: Ipv6Schema,
  rangeEnd: Ipv6Schema,
  dnsServers: z.array(Ipv6Schema).max(4).default([]),
  preferredLifetimeSeconds: z.number().int().positive().default(3_600),
  validLifetimeSeconds: z.number().int().positive().default(7_200),
}).strict();
export type Dhcpv6PoolConfigDocument = z.infer<typeof Dhcpv6PoolConfigSchema>;

export const PcDeviceConfigSchema = z.object({
  kind: z.literal("pc"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  ipv4: Ipv4InterfaceConfigSchema.extend({
    defaultGateway: Ipv4Schema.optional(),
  }).optional(),
  dhcpEnabled: z.boolean().default(false),
  dnsServer: Ipv4Schema.optional(),
  ipv6: HostIpv6ConfigSchema.optional(),
});
export type PcDeviceConfig = z.infer<typeof PcDeviceConfigSchema>;

export const HostInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  ipv4: Ipv4InterfaceConfigSchema.optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
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
  address: IpAddressSchema,
  recordType: z.enum(["A", "AAAA"]).optional(),
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
  RadiusServiceConfigSchema,
  TacacsServiceConfigSchema,
  NetworkManagementServiceConfigSchema,
]);
export type ServerServiceConfig = z.infer<typeof ServerServiceConfigSchema>;

export const ServerDeviceConfigSchema = z.object({
  kind: z.literal("server"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(HostInterfaceConfigSchema).default([]),
  defaultGateway: Ipv4Schema.optional(),
  dhcpClientEnabled: z.boolean().default(false),
  dnsServer: Ipv4Schema.optional(),
  ipv6: HostIpv6ConfigSchema.optional(),
  dhcpv6Pools: z.array(Dhcpv6PoolConfigSchema).max(32).optional(),
  enabledServices: z.array(ServerServiceConfigSchema).max(16).default([]),
  /** A server is a vendor-neutral station: LLDP only, never CDP. */
  discovery: NeighborDiscoveryConfigSchema.optional(),
  consoleAccess: ConsoleAccessConfigurationSchema.optional(),
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
  consoleAccess: ConsoleAccessConfigurationSchema.optional(),
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
  ...SwitchControlProtocolShape,
  consoleAccess: ConsoleAccessConfigurationSchema.optional(),
  /** `interface vlan <id>`: the single management interface of an L2 switch. */
  managementSvi: ManagementSviConfigSchema.optional(),
  /** `ip default-gateway`: a host default route for management replies only. */
  managementDefaultGateway: Ipv4Schema.optional(),
  remoteAccess: RemoteAccessConfigurationSchema.optional(),
  aaa: AaaConfigurationSchema.optional(),
  snmp: SnmpAgentConfigurationSchema.optional(),
});
export type SwitchDeviceConfig = z.infer<typeof SwitchDeviceConfigSchema>;

export const RouterPhysicalInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  /** Whether this physical port participates in layer 3. */
  routed: z.boolean().default(false),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
  mplsEnabled: z.boolean().optional(),
  vrfId: z.string().min(1).max(64).optional(),
});
export type RouterPhysicalInterfaceConfig = z.infer<typeof RouterPhysicalInterfaceConfigSchema>;

export const RouterSubinterfaceConfigSchema = z.object({
  id: z.string().min(1),
  parentInterface: z.string().min(1),
  vlan: VlanIdSchema,
  native: z.boolean().default(false),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
  vrfId: z.string().min(1).max(64).optional(),
});
export type RouterSubinterfaceConfig = z.infer<typeof RouterSubinterfaceConfigSchema>;

export const StaticRouteConfigSchema = z.object({
  network: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
  nextHop: Ipv4Schema,
});
export type StaticRouteConfig = z.infer<typeof StaticRouteConfigSchema>;

export const Ipv6StaticRouteConfigSchema = z.object({
  network: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
  nextHop: Ipv6Schema,
}).strict();
export type Ipv6StaticRouteConfig = z.infer<typeof Ipv6StaticRouteConfigSchema>;

export const RouterAdvertisementConfigSchema = z.object({
  interfaceName: z.string().min(1),
  managed: z.boolean().default(false),
  otherConfiguration: z.boolean().default(false),
  routerLifetimeSeconds: z.number().int().nonnegative().default(1_800),
  dnsServers: z.array(Ipv6Schema).max(4).default([]),
  prefixes: z.array(z.object({
    prefix: Ipv6Schema,
    prefixLength: Ipv6PrefixLengthSchema,
    autonomous: z.boolean().default(true),
    onLink: z.boolean().default(true),
    validLifetimeSeconds: z.number().int().positive().default(2_592_000),
    preferredLifetimeSeconds: z.number().int().positive().default(604_800),
  }).strict()).max(16).default([]),
}).strict();
export type RouterAdvertisementConfigDocument = z.infer<typeof RouterAdvertisementConfigSchema>;

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
const StandardAclRuleSchema = z.object({
  sequence: z.number().int().nonnegative(),
  action: AclActionSchema,
  source: Ipv4AddressMatcherSchema,
}).strict();
/**
 * `ip`, `icmp`, `tcp`, `udp`, plus the two tunnel protocols a site-to-site VPN
 * puts on the underlay: `gre` (47) and `esp` (50). Matching those is what lets
 * a lab deliberately block a VPN and observe the failure.
 */
const AclProtocolSchema = z.union([
  z.literal("ip"),
  z.literal(1),
  z.literal(6),
  z.literal(17),
  z.literal(47),
  z.literal(50),
]);

const ExtendedAclRuleSchema = z.object({
  sequence: z.number().int().nonnegative(),
  action: AclActionSchema,
  protocol: AclProtocolSchema,
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

export const Ipv6AclConfigSchema = z.object({
  id: z.string().min(1),
  type: z.literal("ipv6"),
  rules: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    action: AclActionSchema,
    protocol: z.union([z.literal("ipv6"), z.literal(6), z.literal(17), z.literal(58)]),
    source: Ipv6AddressMatcherSchema,
    destination: Ipv6AddressMatcherSchema,
    sourcePort: PortMatcherSchema.optional(),
    destinationPort: PortMatcherSchema.optional(),
  }).strict()).max(256).default([]),
}).strict();
export type Ipv6AclConfig = z.infer<typeof Ipv6AclConfigSchema>;

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
  ipv6Acls: z.array(Ipv6AclConfigSchema).max(64).optional(),
  ipv6AclBindings: z.array(AclBindingConfigSchema).max(128).optional(),
};

/**
 * Quality of Service configuration. Optional so a schema-v1 lab written before
 * M10.8 still opens, with defaults and no policies.
 */
const RoutedQosConfigShape = {
  qos: QosConfigurationSchema.optional(),
};

/**
 * Site-to-site VPN configuration. Optional so a schema-v1 lab written before
 * M10.9 still opens with no tunnels and no crypto configuration.
 */
const RoutedVpnConfigShape = {
  vpn: VpnConfigurationSchema.optional(),
};

const RoutedIpv6ConfigShape = {
  ipv6UnicastRoutingEnabled: z.boolean().optional(),
  ipv6StaticRoutes: z.array(Ipv6StaticRouteConfigSchema).max(256).optional(),
  routerAdvertisements: z.array(RouterAdvertisementConfigSchema).max(64).optional(),
  dhcpv6Pools: z.array(Dhcpv6PoolConfigSchema).max(32).optional(),
};

export const RouterDeviceConfigSchema = z.object({
  kind: z.literal("router"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(RouterPhysicalInterfaceConfigSchema).default([]),
  subinterfaces: z.array(RouterSubinterfaceConfigSchema).default([]),
  staticRoutes: z.array(StaticRouteConfigSchema).default([]),
  dhcpPools: z.array(DhcpPoolConfigSchema).default([]),
  ...RoutedIpv6ConfigShape,
  ...RoutedSecurityConfigShape,
  ...RoutedQosConfigShape,
  ...RoutedVpnConfigShape,
  natPools: z.array(NatPoolConfigSchema).max(32).default([]),
  natRules: z.array(NatRuleConfigSchema).max(128).default([]),
  natInterfaceRoles: z.array(NatInterfaceRoleConfigSchema).max(64).default([]),
  ldp: LdpConfigSchema.optional(),
  vrfs: z.array(VrfConfigSchema).max(256).optional(),
  ...RoutedControlProtocolShape,
  discovery: NeighborDiscoveryConfigSchema.optional(),
  consoleAccess: ConsoleAccessConfigurationSchema.optional(),
  remoteAccess: RemoteAccessConfigurationSchema.optional(),
  aaa: AaaConfigurationSchema.optional(),
  snmp: SnmpAgentConfigurationSchema.optional(),
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
  protocol: AclProtocolSchema,
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
  /** DSCP the generator stamps on the packets it originates. */
  dscp: DscpValueSchema.optional(),
  /** 802.1p CoS requested for a tagged egress path; ignored when untagged. */
  cos: CosValueSchema.optional(),
});
export const TrafficFlowConfigSchema = z.discriminatedUnion("protocol", [
  TrafficFlowBaseSchema.extend({ protocol: z.literal("icmp") }).strict(),
  TrafficFlowBaseSchema.extend({
    protocol: z.literal("udp"),
    destinationPort: z.number().int().min(1).max(65_535),
    sourcePort: z.number().int().min(1).max(65_535).optional(),
  }).strict(),
  // A TCP flow uses a deterministic ephemeral source port, exactly like the
  // host stack does; only the destination port is configurable.
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
    ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
  }).strict(),
]);
export type Layer3SwitchInterfaceConfig = z.infer<typeof Layer3SwitchInterfaceConfigSchema>;

export const SviConfigSchema = z.object({
  vlanId: VlanIdSchema,
  ipAddress: Ipv4Schema.optional(),
  prefixLength: PrefixLengthSchema.optional(),
  adminUp: z.boolean().default(true),
  description: z.string().min(1).optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
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
  ...RoutedIpv6ConfigShape,
  ...RoutedSecurityConfigShape,
  ...RoutedQosConfigShape,
  ...SwitchControlProtocolShape,
  ...RoutedControlProtocolShape,
  consoleAccess: ConsoleAccessConfigurationSchema.optional(),
  remoteAccess: RemoteAccessConfigurationSchema.optional(),
  aaa: AaaConfigurationSchema.optional(),
  snmp: SnmpAgentConfigurationSchema.optional(),
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

export const AccessPointDeviceConfigSchema = z.object({
  kind: z.literal("access-point"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  radio: WirelessRadioSettingsSchema,
  accessPoint: WirelessAccessPointConfigurationSchema,
});
export type AccessPointDeviceConfig = z.infer<typeof AccessPointDeviceConfigSchema>;

export const LaptopDeviceConfigSchema = PcDeviceConfigSchema.extend({
  kind: z.literal("laptop"),
  wireless: WirelessStationConfigurationSchema,
});
export type LaptopDeviceConfig = z.infer<typeof LaptopDeviceConfigSchema>;

export const SmartphoneDeviceConfigSchema = PcDeviceConfigSchema.extend({
  kind: z.literal("smartphone"),
  wireless: WirelessStationConfigurationSchema,
});
export type SmartphoneDeviceConfig = z.infer<typeof SmartphoneDeviceConfigSchema>;

export const WirelessRouterLanConfigSchema = z.object({
  address: Ipv4Schema,
  prefixLength: PrefixLengthSchema,
  dhcpEnabled: z.boolean().default(true),
  dhcpRangeStart: Ipv4Schema,
  dhcpRangeEnd: Ipv4Schema,
  ipv6Address: Ipv6Schema.optional(),
  ipv6PrefixLength: Ipv6PrefixLengthSchema.optional(),
  routerAdvertisementEnabled: z.boolean().default(false),
  dhcpv6Enabled: z.boolean().default(false),
}).strict();
export type WirelessRouterLanConfig = z.infer<typeof WirelessRouterLanConfigSchema>;

export const WirelessRouterWanConfigSchema = z.object({
  mode: z.enum(["static", "dhcp"]).default("dhcp"),
  address: Ipv4Schema.optional(),
  prefixLength: PrefixLengthSchema.optional(),
  defaultGateway: Ipv4Schema.optional(),
  dnsServer: IpAddressSchema.optional(),
}).strict();
export type WirelessRouterWanConfig = z.infer<typeof WirelessRouterWanConfigSchema>;

export const WirelessRouterDeviceConfigSchema = z.object({
  kind: z.literal("wireless-router"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(PhysicalInterfaceConfigSchema).default([]),
  radio: WirelessRadioSettingsSchema,
  accessPoint: WirelessAccessPointConfigurationSchema,
  lan: WirelessRouterLanConfigSchema,
  wan: WirelessRouterWanConfigSchema,
  natEnabled: z.boolean().default(true),
  firewallEnabled: z.boolean().default(true),
});
export type WirelessRouterDeviceConfig = z.infer<typeof WirelessRouterDeviceConfigSchema>;

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
  AccessPointDeviceConfigSchema,
  LaptopDeviceConfigSchema,
  SmartphoneDeviceConfigSchema,
  WirelessRouterDeviceConfigSchema,
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
  /**
   * Optional physical placement (sites, rooms, racks). Presentation only, like
   * `diagram`: it never affects topology, protocol behavior or grading, and a
   * lab written before M10.8.1 simply omits it.
   */
  physical: LabPhysicalLayoutSchema.optional(),
  sourceImport: LabSourceImportSchema.optional(),
});
export type LabMetadata = z.infer<typeof LabMetadataSchema>;

/**
 * One device's saved startup configuration.
 *
 * `absent` is the deliberate result of `erase startup-config`: the NVRAM is
 * empty and a reload boots factory defaults. A device with no entry at all is
 * *implicit* — the state of every lab written before startup snapshots existed —
 * and its startup configuration is by definition the configuration the document
 * was saved with.
 *
 * A startup snapshot stores configuration only. ARP/MAC tables, learned routes,
 * DHCP leases, TCP sessions, NAT translations, VPN security associations, QoS
 * queues, protocol neighbours and packet trace are runtime and never appear
 * here — exactly as they never appear in `configurations`.
 */
export const DeviceStartupConfigurationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z.object({ state: z.literal("saved"), configuration: DeviceConfigSchema }),
]);
export type DeviceStartupConfiguration = z.infer<typeof DeviceStartupConfigurationSchema>;

export const LabStartupConfigurationsSchema = z.record(z.string(), DeviceStartupConfigurationSchema);
export type LabStartupConfigurations = z.infer<typeof LabStartupConfigurationsSchema>;

export const LabSnapshotSchema = z.object({
  topology: TopologySchema,
  /** Device id -> structured, persistent configuration (the running config). */
  configurations: z.record(z.string(), DeviceConfigSchema).default({}),
  /**
   * Device id -> saved startup configuration. Optional: an omitted map means
   * every device's startup configuration equals its running configuration.
   */
  startupConfigurations: LabStartupConfigurationsSchema.optional(),
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
  /**
   * Saved startup configuration per device. Absent — as in every lab written
   * before M10.9.1 — means startup equals running, so an older document keeps
   * opening without a migration and without a false "unsaved changes" state.
   */
  startupConfigurations: LabStartupConfigurationsSchema.optional(),
});
export type LabDocument = z.infer<typeof LabDocumentSchema>;

/** Device configuration as it may be *written*: schema defaults may be omitted. */
export type DeviceConfigInput = z.input<typeof DeviceConfigSchema>;

/**
 * A lab document that is about to be canonicalized. The topology is already
 * complete, but device configuration may omit anything with a schema default —
 * so a demo lab does not have to spell out `spanningTree: { mode: "disabled" }`
 * on every switch. `canonicalizeLabDocument` fills the defaults and returns a
 * fully-populated `LabDocument`.
 */
export type LabDocumentDraft = Omit<LabDocument, "configurations"> & {
  readonly configurations: Record<string, DeviceConfigInput>;
};

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
