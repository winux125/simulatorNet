import { z } from "zod";
import {
  IpAddressSchema,
  Ipv4InterfaceConfigSchema,
  Ipv4Schema,
  Ipv6InterfaceAddressSchema,
  Ipv6PrefixLengthSchema,
  Ipv6Schema,
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

// --- BGPv4 and reusable route policy -------------------------------------

export const BgpAsnSchema = z.number().int().min(1).max(4_294_967_295);
export const BgpNetworkStatementSchema = z.object({
  network: Ipv4Schema,
  prefixLength: z.number().int().min(0).max(32),
}).strict();

/**
 * `address-family ipv6 unicast` settings for one neighbor. IPv4 unicast keeps
 * the flat fields it has always had, so a document written before M10.13 is
 * unchanged and this block is simply absent.
 */
export const BgpNeighborIpv6FamilyConfigSchema = z.object({
  activated: z.boolean().optional(),
  nextHopSelf: z.boolean().optional(),
  prefixListIn: z.string().min(1).max(64).optional(),
  prefixListOut: z.string().min(1).max(64).optional(),
  routeMapIn: z.string().min(1).max(64).optional(),
  routeMapOut: z.string().min(1).max(64).optional(),
  sendCommunityStandard: z.boolean().optional(),
  routeReflectorClient: z.boolean().optional(),
  defaultOriginate: z.boolean().optional(),
  defaultOriginateRouteMap: z.string().min(1).max(64).optional(),
}).strict();
export type BgpNeighborIpv6FamilyConfig = z.infer<typeof BgpNeighborIpv6FamilyConfigSchema>;

export const BgpNeighborConfigSchema = z.object({
  /** IPv4 or IPv6 transport address of the peer. */
  address: IpAddressSchema,
  remoteAs: BgpAsnSchema,
  description: z.string().max(256).optional(),
  updateSource: z.string().min(1).max(64).optional(),
  ebgpMultihop: z.number().int().min(1).max(255).optional(),
  enabled: z.boolean().optional(),
  nextHopSelf: z.boolean().optional(),
  prefixListIn: z.string().min(1).max(64).optional(),
  prefixListOut: z.string().min(1).max(64).optional(),
  routeMapIn: z.string().min(1).max(64).optional(),
  routeMapOut: z.string().min(1).max(64).optional(),
  vpnv4Activated: z.boolean().optional(),
  vpnv6Activated: z.boolean().optional(),
  /** `address-family l2vpn evpn` → `neighbor <a> activate`. */
  evpnActivated: z.boolean().optional(),
  sendCommunityExtended: z.boolean().optional(),
  /** `neighbor <a> send-community`: standard communities leave this device. */
  sendCommunityStandard: z.boolean().optional(),
  /** Reflection client; semantic validation rejects it on an eBGP neighbor. */
  routeReflectorClient: z.boolean().optional(),
  defaultOriginate: z.boolean().optional(),
  defaultOriginateRouteMap: z.string().min(1).max(64).optional(),
  ipv6: BgpNeighborIpv6FamilyConfigSchema.optional(),
}).strict();
export type BgpNeighborConfig = z.infer<typeof BgpNeighborConfigSchema>;

/** `65000:100` or a well-known name; the engine owns the canonical form. */
export const BgpCommunitySchema = z.string().min(1).max(32);

export const BgpAggregateConfigSchema = z.object({
  prefix: Ipv4Schema,
  prefixLength: z.number().int().min(0).max(31),
  summaryOnly: z.boolean().optional(),
  asSet: z.boolean().optional(),
}).strict();
export type BgpAggregateConfig = z.infer<typeof BgpAggregateConfigSchema>;

export const BgpIpv6NetworkStatementSchema = z.object({
  network: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
}).strict();

export const BgpProcessConfigSchema = z.object({
  localAs: BgpAsnSchema,
  routerId: Ipv4Schema.optional(),
  keepaliveSeconds: z.number().int().min(0).max(65_535).optional(),
  holdTimeSeconds: z.number().int().min(0).max(65_535).optional(),
  /** Route-reflection cluster identity; defaults to the BGP router ID. */
  clusterId: Ipv4Schema.optional(),
  neighbors: z.array(BgpNeighborConfigSchema).max(64).default([]),
  networks: z.array(BgpNetworkStatementSchema).max(4_096).default([]),
  /** `network` statements under `address-family ipv6 unicast`. */
  ipv6Networks: z.array(BgpIpv6NetworkStatementSchema).max(4_096).optional(),
  aggregates: z.array(BgpAggregateConfigSchema).max(64).optional(),
  vrfAddressFamilies: z.array(z.object({
    vrfId: z.string().min(1).max(64),
    redistributeConnected: z.boolean().optional(),
    redistributeStatic: z.boolean().optional(),
    /** `address-family ipv6 vrf <name>` redistribution into VPNv6. */
    redistributeConnectedIpv6: z.boolean().optional(),
    redistributeStaticIpv6: z.boolean().optional(),
  }).strict()).max(256).default([]),
}).strict();
export type BgpProcessConfig = z.infer<typeof BgpProcessConfigSchema>;

// --- MPLS, LDP and Layer 3 VPN ------------------------------------------

function validRouteDistinguisher(value: string): boolean {
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || separator === value.length - 1) return false;
  const administrator = value.slice(0, separator);
  const assignedText = value.slice(separator + 1);
  if (!/^\d+$/.test(assignedText)) return false;
  const assigned = Number(assignedText);
  if (!Number.isSafeInteger(assigned) || assigned < 0 || assigned > 0xffff_ffff) return false;
  if (administrator.includes(".")) {
    const octets = administrator.split(".");
    return octets.length === 4
      && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
      && assigned <= 0xffff;
  }
  if (!/^\d+$/.test(administrator)) return false;
  const asn = Number(administrator);
  return Number.isSafeInteger(asn) && asn >= 0 && asn <= 0xffff_ffff;
}

export const RouteDistinguisherSchema = z.string().min(3).max(64).refine(
  validRouteDistinguisher,
  "Invalid route distinguisher",
);
export const RouteTargetSchema = RouteDistinguisherSchema;

export const LdpConfigSchema = z.object({
  routerIdInterface: z.string().min(1).max(64).optional(),
}).strict();
export type LdpConfig = z.infer<typeof LdpConfigSchema>;

export const VrfStaticRouteConfigSchema = z.object({
  network: Ipv4Schema,
  prefixLength: z.number().int().min(0).max(32),
  nextHop: Ipv4Schema,
}).strict();

export const VrfIpv6StaticRouteConfigSchema = z.object({
  network: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
  nextHop: Ipv6Schema,
}).strict();

export const VrfConfigSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  routeDistinguisher: RouteDistinguisherSchema,
  importRouteTargets: z.array(RouteTargetSchema).max(64).default([]),
  exportRouteTargets: z.array(RouteTargetSchema).max(64).default([]),
  staticRoutes: z.array(VrfStaticRouteConfigSchema).max(4_096).default([]),
  /**
   * `address-family ipv6` inside `vrf definition`. Absent means the VRF is
   * IPv4 only, so every document written before M10.13 opens unchanged.
   */
  addressFamilyIpv6: z.boolean().optional(),
  ipv6StaticRoutes: z.array(VrfIpv6StaticRouteConfigSchema).max(4_096).optional(),
  /**
   * `address-family ipv4 vrf <name>` → `advertise l2vpn evpn` (M10.15).
   *
   * Origination into EVPN Type 5 is always explicit: without this flag the
   * tenant's connected and static routes stay local, so no redistribution is
   * ever hidden. Absent means off, so a pre-M10.15 document is unchanged.
   */
  advertiseEvpn: z.boolean().optional(),
}).strict();
export type VrfConfig = z.infer<typeof VrfConfigSchema>;

// --- VXLAN and BGP EVPN ---------------------------------------------------

/** A 24-bit VXLAN Network Identifier. VNI 0 is reserved and never accepted. */
export const VniSchema = z.number().int().min(1).max(16_777_215);

/**
 * How one VNI reaches the remote VTEPs that share its broadcast domain.
 *
 * `static` is a hand-written ingress-replication list; `bgp-evpn` defers the
 * list to Inclusive Multicast (Type 3) routes. Multicast underlay replication is
 * deliberately not modelled, so there is no third variant.
 */
export const NveReplicationConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("static"),
    peerAddresses: z.array(Ipv4Schema).max(64).default([]),
  }).strict(),
  z.object({ type: z.literal("bgp-evpn") }).strict(),
]);
export type NveReplicationConfig = z.infer<typeof NveReplicationConfigSchema>;

export const NveMemberConfigSchema = z.object({
  vni: VniSchema,
  vlanId: VlanIdSchema,
  replication: NveReplicationConfigSchema,
}).strict();
export type NveMemberConfig = z.infer<typeof NveMemberConfigSchema>;

/**
 * `member vni <vni> associate-vrf`: an **L3VNI**.
 *
 * It has no VLAN and no broadcast domain. It is the transit segment symmetric
 * IRB routes a tenant's packets through, and the VNI is what names the VRF on
 * the receiving VTEP.
 */
export const NveVrfMemberConfigSchema = z.object({
  vni: VniSchema,
  vrfId: z.string().min(1).max(64),
}).strict();
export type NveVrfMemberConfig = z.infer<typeof NveVrfMemberConfigSchema>;

/**
 * `interface nve1`: the one logical overlay interface a VTEP owns.
 *
 * It has an administrative state, an IPv4 source loopback and a set of VNI
 * members — but it is never a cable: it has no topology link, never appears in
 * the connection modal and never anchors a canvas edge. Only an L3 Switch may
 * carry one.
 */
export const NveInterfaceConfigSchema = z.object({
  id: z.literal("nve1"),
  sourceInterfaceId: z.string().min(1).max(64),
  shutdown: z.boolean().default(false),
  members: z.array(NveMemberConfigSchema).max(64).default([]),
  /**
   * M10.15 L3VNIs. Optional, so a pre-M10.15 lab opens unchanged and without a
   * migration; absent means the VTEP bridges only.
   */
  vrfMembers: z.array(NveVrfMemberConfigSchema).max(64).optional(),
}).strict();
export type NveInterfaceConfig = z.infer<typeof NveInterfaceConfigSchema>;

/** `evpn` → `vni <id> l2`: the RD and route targets one VNI advertises with. */
export const EvpnVniConfigSchema = z.object({
  vni: VniSchema,
  routeDistinguisher: RouteDistinguisherSchema,
  importRouteTargets: z.array(RouteTargetSchema).max(64).default([]),
  exportRouteTargets: z.array(RouteTargetSchema).max(64).default([]),
}).strict();
export type EvpnVniConfig = z.infer<typeof EvpnVniConfigSchema>;

/**
 * A MAC in the `0200.0000.0001` shape the fabric CLI uses for the one gateway
 * address every leaf answers with. It must be unicast: a host sends real
 * traffic to it, so a group bit could never be a usable next hop.
 */
export const AnycastGatewayMacSchema = z.string()
  .regex(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/iu, "Expected a MAC address")
  .refine((value) => (Number.parseInt(value.slice(0, 2), 16) & 0x01) === 0, "Anycast gateway MAC must be unicast")
  .refine((value) => !/^0{2}(:0{2}){5}$/u.test(value), "Anycast gateway MAC must not be all zeroes");

export const EvpnConfigSchema = z.object({
  vnis: z.array(EvpnVniConfigSchema).max(64).default([]),
  /**
   * `fabric forwarding anycast-gateway-mac`. Fabric-wide rather than per-SVI:
   * that is precisely what makes the gateway distributed, so a host keeps one
   * gateway MAC in its ARP cache no matter which leaf it is attached to.
   */
  anycastGatewayMac: AnycastGatewayMacSchema.optional(),
}).strict();
export type EvpnConfig = z.infer<typeof EvpnConfigSchema>;

export const PrefixListEntryConfigSchema = z.object({
  sequence: z.number().int().min(1).max(4_294_967_295),
  action: z.enum(["permit", "deny"]),
  prefix: Ipv4Schema,
  prefixLength: z.number().int().min(0).max(32),
  ge: z.number().int().min(0).max(32).optional(),
  le: z.number().int().min(0).max(32).optional(),
}).strict();
export const PrefixListConfigSchema = z.object({
  id: z.string().min(1).max(64),
  entries: z.array(PrefixListEntryConfigSchema).max(512).default([]),
}).strict();
export type PrefixListConfig = z.infer<typeof PrefixListConfigSchema>;

/** `ipv6 prefix-list`: prefix-only, with the same ge/le window as IPv4. */
export const Ipv6PrefixListEntryConfigSchema = z.object({
  sequence: z.number().int().min(1).max(4_294_967_295),
  action: z.enum(["permit", "deny"]),
  prefix: Ipv6Schema,
  prefixLength: Ipv6PrefixLengthSchema,
  ge: Ipv6PrefixLengthSchema.optional(),
  le: Ipv6PrefixLengthSchema.optional(),
}).strict();
export const Ipv6PrefixListConfigSchema = z.object({
  id: z.string().min(1).max(64),
  entries: z.array(Ipv6PrefixListEntryConfigSchema).max(512).default([]),
}).strict();
export type Ipv6PrefixListConfig = z.infer<typeof Ipv6PrefixListConfigSchema>;

export const CommunityListEntryConfigSchema = z.object({
  sequence: z.number().int().min(1).max(4_294_967_295),
  action: z.enum(["permit", "deny"]),
  /** Every listed community must be present for the entry to match. */
  communities: z.array(BgpCommunitySchema).min(1).max(32),
}).strict();
export const CommunityListConfigSchema = z.object({
  id: z.string().min(1).max(64),
  entries: z.array(CommunityListEntryConfigSchema).max(128).default([]),
}).strict();
export type CommunityListConfig = z.infer<typeof CommunityListConfigSchema>;

/**
 * A structured AS-path matcher. A configuration never stores a regular
 * expression: the CLI and the importer parse the educational Cisco-like
 * pattern subset into one of these variants, and only the variant is executed.
 */
export const AsPathMatcherConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("empty") }).strict(),
  z.object({ kind: z.literal("contains"), asn: BgpAsnSchema }).strict(),
  z.object({ kind: z.literal("starts-with"), asn: BgpAsnSchema }).strict(),
  z.object({ kind: z.literal("ends-with"), asn: BgpAsnSchema }).strict(),
  z.object({ kind: z.literal("exact"), asPath: z.array(BgpAsnSchema).min(1).max(32) }).strict(),
  z.object({
    kind: z.literal("length"),
    operator: z.enum(["eq", "le", "ge"]),
    length: z.number().int().min(0).max(256),
  }).strict(),
]);
export const AsPathListEntryConfigSchema = z.object({
  sequence: z.number().int().min(1).max(4_294_967_295),
  action: z.enum(["permit", "deny"]),
  matcher: AsPathMatcherConfigSchema,
}).strict();
export const AsPathListConfigSchema = z.object({
  id: z.string().min(1).max(64),
  entries: z.array(AsPathListEntryConfigSchema).max(128).default([]),
}).strict();
export type AsPathListConfig = z.infer<typeof AsPathListConfigSchema>;

export const RouteMapSequenceConfigSchema = z.object({
  sequence: z.number().int().min(1).max(4_294_967_295),
  action: z.enum(["permit", "deny"]),
  match: z.object({
    prefixListIds: z.array(z.string().min(1).max(64)).max(16).optional(),
    /** `match ipv6 address prefix-list`; only ever matches an IPv6 route. */
    ipv6PrefixListIds: z.array(z.string().min(1).max(64)).max(16).optional(),
    neighbor: Ipv4Schema.optional(),
    maximumAsPathLength: z.number().int().min(0).max(256).optional(),
    source: z.enum(["local", "ebgp", "ibgp"]).optional(),
    communityListIds: z.array(z.string().min(1).max(64)).max(16).optional(),
    communityMatchAll: z.boolean().optional(),
    asPathListIds: z.array(z.string().min(1).max(64)).max(16).optional(),
  }).strict().optional(),
  set: z.object({
    localPreference: z.number().int().min(0).max(4_294_967_295).optional(),
    med: z.number().int().min(0).max(4_294_967_295).optional(),
    weight: z.number().int().min(0).max(4_294_967_295).optional(),
    prependLocalAs: z.number().int().min(1).max(10).optional(),
    prependAsns: z.array(BgpAsnSchema).min(1).max(10).optional(),
    origin: z.enum(["igp", "egp", "incomplete"]).optional(),
    communities: z.array(BgpCommunitySchema).max(32).optional(),
    communityAdditive: z.boolean().optional(),
    communityNone: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type RouteMapSequenceConfig = z.infer<typeof RouteMapSequenceConfigSchema>;
export const RouteMapConfigSchema = z.object({
  id: z.string().min(1).max(64),
  sequences: z.array(RouteMapSequenceConfigSchema).max(512).default([]),
}).strict();
export type RouteMapConfig = z.infer<typeof RouteMapConfigSchema>;

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
  bgp: BgpProcessConfigSchema.optional(),
  prefixLists: z.array(PrefixListConfigSchema).max(128).optional(),
  ipv6PrefixLists: z.array(Ipv6PrefixListConfigSchema).max(128).optional(),
  routeMaps: z.array(RouteMapConfigSchema).max(128).optional(),
  communityLists: z.array(CommunityListConfigSchema).max(128).optional(),
  asPathLists: z.array(AsPathListConfigSchema).max(128).optional(),
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
