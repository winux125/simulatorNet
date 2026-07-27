import { z } from "zod";
import {
  Ipv4InterfaceConfigSchema,
  Ipv4Schema,
  Ipv6InterfaceAddressSchema,
  VlanIdSchema,
} from "./primitives";

/**
 * Serializable configuration for the layer-2/layer-3 control protocols added in
 * M10.4. Only *configuration* lives here. Elected roots, port roles and states,
 * received BPDUs, topology-change counters, LACP/PAgP negotiation state,
 * neighbour tables, OSPF adjacencies, DR/BDR results, the LSDB, the SPF tree and
 * learned routes are runtime and never reach a `LabDocument`.
 *
 * Timers are expressed in whole seconds because that is what a learner types;
 * the engine converts them to virtual nanoseconds when the lab is built.
 */

const multipleOf = (step: number, label: string) =>
  (value: number) => value % step === 0 || `${label} must be a multiple of ${step}`;

// --- spanning tree ---------------------------------------------------------

export const SpanningTreeModeSchema = z.enum(["disabled", "stp", "rstp"]);
export type SpanningTreeModeConfig = z.infer<typeof SpanningTreeModeSchema>;

export const DEFAULT_STP_HELLO_SECONDS = 2;
export const DEFAULT_STP_MAX_AGE_SECONDS = 20;
export const DEFAULT_STP_FORWARD_DELAY_SECONDS = 15;
export const DEFAULT_STP_BRIDGE_PRIORITY_VALUE = 32_768;
export const DEFAULT_STP_PORT_PRIORITY_VALUE = 128;

export const SpanningTreeVlanConfigSchema = z.object({
  vlanId: VlanIdSchema,
  priority: z.number().int().min(0).max(61_440)
    .refine(multipleOf(4_096, "Bridge priority"), "Bridge priority must be a multiple of 4096"),
}).strict();
export type SpanningTreeVlanConfig = z.infer<typeof SpanningTreeVlanConfigSchema>;

export const SpanningTreePortConfigSchema = z.object({
  interfaceId: z.string().min(1),
  cost: z.number().int().min(1).max(200_000_000).optional(),
  priority: z.number().int().min(0).max(240)
    .refine(multipleOf(16, "Port priority"), "Port priority must be a multiple of 16")
    .default(DEFAULT_STP_PORT_PRIORITY_VALUE),
  portFast: z.boolean().default(false),
  bpduGuard: z.boolean().default(false),
}).strict();
export type SpanningTreePortConfig = z.infer<typeof SpanningTreePortConfigSchema>;

export const SpanningTreeConfigSchema = z.object({
  mode: SpanningTreeModeSchema.default("disabled"),
  helloTimeSeconds: z.number().int().min(1).max(10).default(DEFAULT_STP_HELLO_SECONDS),
  maxAgeSeconds: z.number().int().min(6).max(40).default(DEFAULT_STP_MAX_AGE_SECONDS),
  forwardDelaySeconds: z.number().int().min(4).max(30).default(DEFAULT_STP_FORWARD_DELAY_SECONDS),
  /** Per-VLAN bridge priority; VLANs absent here use the default 32768. */
  vlans: z.array(SpanningTreeVlanConfigSchema).max(256).default([]),
  ports: z.array(SpanningTreePortConfigSchema).max(64).default([]),
}).strict();
export type SpanningTreeConfig = z.infer<typeof SpanningTreeConfigSchema>;

// --- EtherChannel ----------------------------------------------------------

export const EtherChannelModeSchema = z.enum(["on", "active", "passive", "desirable", "auto"]);
export type EtherChannelModeConfig = z.infer<typeof EtherChannelModeSchema>;

/** Switchport settings that live on the logical `Port-channel<n>` interface. */
export const PortChannelSwitchportConfigSchema = z.object({
  mode: z.enum(["access", "trunk"]).default("access"),
  accessVlan: VlanIdSchema.default(1),
  nativeVlan: VlanIdSchema.default(1),
  allowedVlans: z.array(VlanIdSchema).optional(),
}).strict();
export type PortChannelSwitchportConfig = z.infer<typeof PortChannelSwitchportConfigSchema>;

export const EtherChannelConfigSchema = z.object({
  channelId: z.number().int().min(1).max(64),
  mode: EtherChannelModeSchema,
  /** Physical member interfaces; the topology keeps every cable. */
  members: z.array(z.string().min(1)).min(1).max(8),
  minimumLinks: z.number().int().min(1).max(8).optional(),
  switchport: PortChannelSwitchportConfigSchema.optional(),
}).strict();
export type EtherChannelConfig = z.infer<typeof EtherChannelConfigSchema>;

// --- neighbour discovery ---------------------------------------------------

export const DiscoveryInterfaceConfigSchema = z.object({
  interfaceId: z.string().min(1),
  cdpEnabled: z.boolean().default(true),
  lldpTransmit: z.boolean().default(true),
  lldpReceive: z.boolean().default(true),
}).strict();
export type DiscoveryInterfaceConfig = z.infer<typeof DiscoveryInterfaceConfigSchema>;

export const DEFAULT_CDP_INTERVAL_SECONDS = 60;
export const DEFAULT_CDP_HOLD_SECONDS = 180;
export const DEFAULT_LLDP_INTERVAL_SECONDS = 30;
export const DEFAULT_LLDP_HOLD_SECONDS = 120;

export const NeighborDiscoveryConfigSchema = z.object({
  cdpEnabled: z.boolean().default(false),
  lldpEnabled: z.boolean().default(false),
  cdpIntervalSeconds: z.number().int().min(5).max(254).default(DEFAULT_CDP_INTERVAL_SECONDS),
  cdpHoldTimeSeconds: z.number().int().min(10).max(255).default(DEFAULT_CDP_HOLD_SECONDS),
  lldpIntervalSeconds: z.number().int().min(5).max(254).default(DEFAULT_LLDP_INTERVAL_SECONDS),
  lldpHoldTimeSeconds: z.number().int().min(10).max(255).default(DEFAULT_LLDP_HOLD_SECONDS),
  interfaces: z.array(DiscoveryInterfaceConfigSchema).max(64).default([]),
}).strict();
export type NeighborDiscoveryConfig = z.infer<typeof NeighborDiscoveryConfigSchema>;

// --- loopback interfaces ---------------------------------------------------

export const LoopbackInterfaceConfigSchema = z.object({
  /** `Loopback<id>`; a logical interface with no cable and no cable handle. */
  id: z.number().int().min(0).max(2_147_483_647),
  description: z.string().min(1).optional(),
  shutdown: z.boolean().default(false),
  ipv4: Ipv4InterfaceConfigSchema.optional(),
  ipv6: z.array(Ipv6InterfaceAddressSchema).max(16).optional(),
}).strict();
export type LoopbackInterfaceConfig = z.infer<typeof LoopbackInterfaceConfigSchema>;

// --- OSPFv2 ----------------------------------------------------------------

/** Only the backbone area is supported in this release. */
export const OspfAreaSchema = z.literal(0);

export const OspfNetworkStatementSchema = z.object({
  network: Ipv4Schema,
  wildcard: Ipv4Schema,
  area: OspfAreaSchema,
}).strict();
export type OspfNetworkStatementConfig = z.infer<typeof OspfNetworkStatementSchema>;

export const OspfNetworkTypeSchema = z.enum(["broadcast", "point-to-point"]);

export const OspfInterfaceConfigSchema = z.object({
  interfaceId: z.string().min(1),
  area: OspfAreaSchema.optional(),
  cost: z.number().int().min(1).max(65_535).optional(),
  priority: z.number().int().min(0).max(255).optional(),
  networkType: OspfNetworkTypeSchema.optional(),
  helloIntervalSeconds: z.number().int().min(1).max(65_535).optional(),
  deadIntervalSeconds: z.number().int().min(1).max(65_535).optional(),
  /** `ip ospf <process> area 0`; overrides the network statements. */
  enabled: z.boolean().optional(),
}).strict();
export type OspfInterfaceConfig = z.infer<typeof OspfInterfaceConfigSchema>;

export const OspfProcessConfigSchema = z.object({
  processId: z.number().int().min(1).max(65_535).default(1),
  routerId: Ipv4Schema.optional(),
  networks: z.array(OspfNetworkStatementSchema).max(64).default([]),
  passiveInterfaces: z.array(z.string().min(1)).max(64).default([]),
  interfaces: z.array(OspfInterfaceConfigSchema).max(64).default([]),
}).strict();
export type OspfProcessConfig = z.infer<typeof OspfProcessConfigSchema>;

// --- OSPFv3 ---------------------------------------------------------------

export const Ospfv3InterfaceConfigSchema = z.object({
  interfaceId: z.string().min(1),
  area: OspfAreaSchema.optional(),
  cost: z.number().int().min(1).max(65_535).optional(),
  priority: z.number().int().min(0).max(255).optional(),
  networkType: OspfNetworkTypeSchema.optional(),
  helloIntervalSeconds: z.number().int().min(1).max(65_535).optional(),
  deadIntervalSeconds: z.number().int().min(1).max(65_535).optional(),
  enabled: z.boolean().optional(),
}).strict();
export type Ospfv3InterfaceConfig = z.infer<typeof Ospfv3InterfaceConfigSchema>;

export const Ospfv3ProcessConfigSchema = z.object({
  processId: z.number().int().min(1).max(65_535).default(1),
  routerId: Ipv4Schema.optional(),
  passiveInterfaces: z.array(z.string().min(1)).max(64).default([]),
  interfaces: z.array(Ospfv3InterfaceConfigSchema).max(64).default([]),
}).strict();
export type Ospfv3ProcessConfig = z.infer<typeof Ospfv3ProcessConfigSchema>;

/**
 * Layer-2 control protocols shared by the L2 and L3 switch.
 *
 * Every block is optional so that a document written before M10.4 — or a demo
 * lab that simply does not use a protocol — stays valid without spelling out
 * `spanningTree: { mode: "disabled" }`. Canonicalization always fills them in,
 * so a canonical document carries a complete, deterministic configuration.
 */
export const SwitchControlProtocolShape = {
  spanningTree: SpanningTreeConfigSchema.optional(),
  etherChannels: z.array(EtherChannelConfigSchema).max(64).optional(),
  discovery: NeighborDiscoveryConfigSchema.optional(),
};

/** Routing-plane protocols shared by the router and the L3 switch. */
export const RoutedControlProtocolShape = {
  loopbacks: z.array(LoopbackInterfaceConfigSchema).max(32).optional(),
  ospf: OspfProcessConfigSchema.optional(),
  ospfv3: Ospfv3ProcessConfigSchema.optional(),
};

/** Canonical defaults applied when a document omits a protocol block. */
export const DEFAULT_SPANNING_TREE_CONFIG: SpanningTreeConfig = Object.freeze({
  mode: "disabled",
  helloTimeSeconds: DEFAULT_STP_HELLO_SECONDS,
  maxAgeSeconds: DEFAULT_STP_MAX_AGE_SECONDS,
  forwardDelaySeconds: DEFAULT_STP_FORWARD_DELAY_SECONDS,
  vlans: [],
  ports: [],
});

export const DEFAULT_NEIGHBOR_DISCOVERY_CONFIG: NeighborDiscoveryConfig = Object.freeze({
  cdpEnabled: false,
  lldpEnabled: false,
  cdpIntervalSeconds: DEFAULT_CDP_INTERVAL_SECONDS,
  cdpHoldTimeSeconds: DEFAULT_CDP_HOLD_SECONDS,
  lldpIntervalSeconds: DEFAULT_LLDP_INTERVAL_SECONDS,
  lldpHoldTimeSeconds: DEFAULT_LLDP_HOLD_SECONDS,
  interfaces: [],
});
