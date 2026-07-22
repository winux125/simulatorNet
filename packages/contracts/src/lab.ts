import { z } from "zod";
import { TopologySchema } from "./topology";

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
});
export type PcDeviceConfig = z.infer<typeof PcDeviceConfigSchema>;

export const HostInterfaceConfigSchema = PhysicalInterfaceConfigSchema.extend({
  ipv4: Ipv4InterfaceConfigSchema.optional(),
});
export type HostInterfaceConfig = z.infer<typeof HostInterfaceConfigSchema>;

export const ServerServiceConfigSchema = z.object({
  type: z.literal("dhcp-server"),
}).strict();
export type ServerServiceConfig = z.infer<typeof ServerServiceConfigSchema>;

export const ServerDeviceConfigSchema = z.object({
  kind: z.literal("server"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(HostInterfaceConfigSchema).default([]),
  defaultGateway: Ipv4Schema.optional(),
  dhcpClientEnabled: z.boolean().default(false),
  /** Reserved registry; simulation support intentionally begins in M10.2. */
  enabledServices: z.array(ServerServiceConfigSchema).max(0).default([]),
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

export const RouterDeviceConfigSchema = z.object({
  kind: z.literal("router"),
  hostname: z.string().min(1).optional(),
  interfaces: z.array(RouterPhysicalInterfaceConfigSchema).default([]),
  subinterfaces: z.array(RouterSubinterfaceConfigSchema).default([]),
  staticRoutes: z.array(StaticRouteConfigSchema).default([]),
  dhcpPools: z.array(DhcpPoolConfigSchema).default([]),
});
export type RouterDeviceConfig = z.infer<typeof RouterDeviceConfigSchema>;

export const Layer3SwitchInterfaceConfigSchema = z.discriminatedUnion("mode", [
  SwitchInterfaceConfigSchema.extend({ mode: z.enum(["access", "trunk"]) }),
  PhysicalInterfaceConfigSchema.extend({
    mode: z.literal("routed"),
    ipv4: Ipv4InterfaceConfigSchema.optional(),
  }),
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
});
export type Layer3SwitchDeviceConfig = z.infer<typeof Layer3SwitchDeviceConfigSchema>;

export const DeviceConfigSchema = z.discriminatedUnion("kind", [
  PcDeviceConfigSchema,
  ServerDeviceConfigSchema,
  HubDeviceConfigSchema,
  BridgeDeviceConfigSchema,
  SwitchDeviceConfigSchema,
  Layer3SwitchDeviceConfigSchema,
  RouterDeviceConfigSchema,
]);
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

export const LabMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
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
