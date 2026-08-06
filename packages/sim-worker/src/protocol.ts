import type {
  AaaConfiguration,
  DeviceCapability,
  DeviceType,
  SnmpAgentConfiguration,
  HostIpConfiguration,
  HostIpv6Config,
  HostStaticConfiguration,
  LabDocument,
  DeviceConfig,
  PasswordVerifier,
  QosConfiguration,
  VpnConfiguration,
  ServerServiceConfig,
  WirelessAccessPointConfiguration,
  WirelessAssociationStatus,
  WirelessNetworkSummary,
  WirelessSecurityConfiguration,
  WirelessStationConfiguration,
} from "@sim/contracts";
import type { CliMode, ConfigurationDrift } from "@sim/cli-engine";
import type {
  DiscoveryInterfaceStatus,
  DiscoveryNeighbor,
  DnsResolutionResult,
  EtherChannelSummary,
  HttpClientResult,
  NtpClientResult,
  OspfInterfaceSummary,
  OspfLsdbEntry,
  OspfNeighborSummary,
  OspfOverview,
  OspfRoute,
  Ospfv3LsdbEntry,
  Ospfv3NeighborSummary,
  Ospfv3Overview,
  Ospfv3Route,
  SpanningTreeSummary,
  ServerServiceRuntimeSnapshot,
  ServerServiceSummary,
  TcpConnectionInspection,
  TftpClientResult,
  UdpSocketInspection,
  AclCounter,
  FirewallConnection,
  NatTranslation,
  NmsRuntimeSnapshot,
  SnmpVarBind,
  TrafficFlowResult,
  QosClassCounter,
  QosProblem,
  AsPathList,
  BgpAggregateSummary,
  BgpNeighborSummary,
  BgpRoute,
  BgpRibEntry,
  BgpSuppressedRoute,
  CommunityList,
  RoutePolicyCounter,
  MplsForwardingEntry,
  LdpNeighborSummary,
  LdpLabelBinding,
  Vpnv4Route,
  VrfRoute,
  BgpUnicastAddressFamily,
  Vpnv6Route,
  VrfIpv6Route,
} from "@sim/sim-core";
export type { BgpUnicastAddressFamily } from "@sim/sim-core";
export type { ServerServiceRuntimeSnapshot } from "@sim/sim-core";

export type EngineUiState = "idle" | "running" | "paused" | "error";
export type PacketExecutionMode = "auto" | "step";

export interface LabUiInterface {
  id: string;
  adminUp: boolean;
  operationalUp: boolean;
  ipAddress?: string;
  mode?: "access" | "trunk" | "routed";
}

export interface LabUiNode {
  id: string;
  type: DeviceType;
  hostname: string;
  position: { x: number; y: number };
  status: "up" | "down";
  interfaces: LabUiInterface[];
  serviceBadges?: string[];
}

export interface LabUiLink {
  id: string;
  sourceNode: string;
  sourceInterface: string;
  targetNode: string;
  targetInterface: string;
  /** Deterministic link performance; simulation configuration, not presentation. */
  performance: {
    capacityBps: number;
    propagationDelayNs: number;
    queueLimitPackets: number;
  };
}

/** Runtime-only WLAN association overlay. It is never a structural LabDocument link. */
export interface LabUiWirelessAssociation {
  id: string;
  stationDeviceId: string;
  accessPointDeviceId: string;
  ssid: string;
  bssid: string;
  state: WirelessAssociationStatus["state"];
}

/**
 * Runtime-only site-to-site VPN overlay: a logical tunnel between two peers
 * that the canvas may draw. Like a wireless association it is derived from
 * worker state and is never a structural `LabDocument.topology.links` entry.
 */
export interface LabUiVpnTunnel {
  id: string;
  localDeviceId: string;
  remoteDeviceId: string;
  /** Tunnel interface name on the local device, e.g. "Tunnel0". */
  interfaceId: string;
  label: string;
  state: "gre" | "protected" | "negotiating" | "failed";
}

/** Runtime-derived label operations shown on physical topology links. */
export interface LabUiMplsLinkLabel {
  linkId: string;
  label: string;
}

/**
 * Logical PE-to-PE L3VPN relation. This is a presentation overlay only: it is
 * not a physical link and carries no interface identity.
 */
export interface LabUiL3VpnRelation {
  id: string;
  localDeviceId: string;
  remoteDeviceId: string;
  label: string;
  state: "operational" | "control-plane-only" | "unavailable";
}

/**
 * A derived VXLAN tunnel between two VTEPs, drawn like a wireless association:
 * presentation only. It is never a `topology.links` entry, never opens the cable
 * modal and never changes `LabDocument` connectivity.
 */
export interface LabUiVxlanTunnel {
  id: string;
  localDeviceId: string;
  remoteDeviceId: string;
  label: string;
  source: "static" | "bgp-evpn";
  /** `rt-mismatch` means both sides run EVPN but import no shared route target. */
  state: "operational" | "down" | "rt-mismatch";
}

export interface LabUiSnapshot {
  labId: string;
  title: string;
  engineState: EngineUiState;
  virtualTime: number;
  queuedEvents: number;
  nodes: LabUiNode[];
  links: LabUiLink[];
  wirelessAssociations?: LabUiWirelessAssociation[];
  vpnTunnels?: LabUiVpnTunnel[];
  mplsLinkLabels?: LabUiMplsLinkLabel[];
  l3VpnRelations?: LabUiL3VpnRelation[];
  vxlanTunnels?: LabUiVxlanTunnel[];
}

export interface SimulationTraceEvent {
  sequence: number;
  virtualTime: number;
  type: string;
  deviceId: string;
  interfaceId?: string;
  description: string;
  detail?: Readonly<Record<string, unknown>>;
}

export interface SerializedWorkerError {
  name: string;
  code: string;
  message: string;
  path?: string;
  context?: Readonly<Record<string, unknown>>;
}

export interface CliExecutionResult {
  sessionId: string;
  deviceId: string;
  output: string;
  prompt: string;
  mode: CliMode;
  /** True while the terminal is waiting for Step or Run All to finish it. */
  deferred: boolean;
  /**
   * The next submitted line is a credential for a remote login. The terminal
   * must suppress echo, keep it out of history/transcript/Problems, and send
   * only the fingerprint derived against `credentialScope`.
   */
  secret?: boolean;
  credentialScope?: string;
  /** Present while a Telnet/SSH session owns this terminal. */
  remote?: { label: string };
}

export interface SimulationRunResult {
  processedEvents: number;
  virtualTime: number;
  snapshot: LabUiSnapshot;
}

export interface DeviceInspectionInterface {
  id: string;
  adminUp: boolean;
  operationalUp: boolean;
  description?: string;
  mode?: "access" | "trunk" | "routed";
  vlan?: number;
  nativeVlan?: number;
  allowedVlans?: number[] | "all";
  ipAddress?: string;
  prefixLength?: number;
}

export interface DeviceInspection {
  deviceId: string;
  hostname: string;
  type: LabUiNode["type"];
  interfaces: DeviceInspectionInterface[];
  arpEntries: Array<{ ipAddress: string; macAddress: string }>;
  capabilities: DeviceCapability[];
  macEntries: Array<{ vlan?: number; macAddress: string; interfaceId: string }>;
  routes: Array<{
    kind: "connected" | "static" | "ospf" | "bgp";
    network: string;
    prefixLength: number;
    nextHop?: string;
    interfaceId: string;
    administrativeDistance?: number;
    metric?: number;
  }>;
  ipv6?: {
    forwardingEnabled?: boolean;
    addresses: Array<{
      interfaceId: string;
      address: string;
      prefixLength: number;
      source: "link-local" | "static" | "slaac" | "dhcpv6";
      state: "tentative" | "preferred" | "deprecated" | "duplicate";
    }>;
    neighbors: Array<{
      interfaceId: string;
      address: string;
      macAddress: string;
      state: string;
    }>;
    routes: Array<{
      kind: "connected" | "static" | "ospfv3" | "bgp";
      network: string;
      prefixLength: number;
      nextHop?: string;
      interfaceId: string;
      administrativeDistance: number;
      metric: number;
    }>;
    problems: string[];
  };
  vlans: Array<{ id: number; name: string; interfaces: string[] }>;
  svis?: Array<{
    vlanId: number;
    interfaceId: string;
    ipAddress?: string;
    prefixLength?: number;
    adminUp: boolean;
    operationalUp: boolean;
    description?: string;
  }>;
  ipRoutingEnabled?: boolean;
  counters?: { repeatedFrames?: number; droppedFrames?: number };
  services?: ServerServiceSummary[];
  serviceRuntime?: ServerServiceRuntimeSnapshot;
  transport?: {
    udpSockets: UdpSocketInspection[];
    tcpConnections: TcpConnectionInspection[];
  };
  applications?: {
    dnsServer?: string;
    dnsResults: DnsResolutionResult[];
    httpResults: HttpClientResult[];
    tftpResults: TftpClientResult[];
    downloadedFiles: Array<{ filename: string; content: string }>;
    ntpResults: NtpClientResult[];
    clockOffsetNs: number;
    clockTimeNs: number;
  };
  dhcp?: {
    enabled?: boolean;
    state?: string;
    bound?: boolean;
    lease?: {
      ipAddress: string;
      gateway?: string;
      serverIp?: string;
      leaseSeconds?: number;
    };
    pools?: Array<{
      id: string;
      network: string;
      prefixLength: number;
      gateway?: string;
      rangeStart: string;
      rangeEnd: string;
      leaseSeconds: number;
    }>;
  };
}

export interface ServerServicesView {
  deviceId: string;
  configurations: ServerServiceConfig[];
  services: ServerServiceSummary[];
}

export interface HostNetworkWarning {
  code:
    | "duplicate-ip"
    | "wireless-authentication-failed"
    | "wireless-no-access-point"
    | "wireless-incompatible-radio"
    | "wireless-client-limit"
    | "wireless-interface-disabled"
    | "wireless-no-dhcp"
    | "access-point-no-uplink"
    | "management-plane"
    | "qos-policy"
    | "qos-queue-overflow"
    | "qos-policer-drop"
    | "mpls-interface-down"
    | "ldp-router-id-unavailable"
    | "vpnv4-extended-community-disabled"
    | "l3vpn-transport-label-unavailable"
    | "bgp"
    | "bgp-policy"
    // --- M10.13 MP-BGP IPv6 unicast and MPLS VPNv6 ---
    | "bgp-ipv6-neighbor-unreachable"
    | "bgp-ipv6-address-family-inactive"
    | "bgp-ipv6-network-route-missing"
    | "vpnv6-extended-community-disabled"
    | "vpnv6-label-unavailable"
    | "vrf-overlapping-ipv6-prefix"
    // --- M10.14 VXLAN and BGP EVPN Layer 2 overlays ---
    | "vxlan-evpn";
  message: string;
  address?: string;
  deviceIds: readonly string[];
}

export interface HostNetworkStatus {
  deviceId: string;
  configuration: HostIpConfiguration;
  runtime: {
    address?: string;
    prefixLength: number;
    defaultGateway?: string;
    dnsServer?: string;
    dhcpState: string;
    dhcpBound: boolean;
    lease?: {
      address: string;
      gateway?: string;
      serverAddress?: string;
      leaseSeconds?: number;
    };
  };
  warnings: HostNetworkWarning[];
  guidance?: string;
}

export interface HostIpv6NetworkStatus {
  deviceId: string;
  configuration: HostIpv6Config;
  runtime: {
    mode: "static" | "slaac" | "dhcpv6";
    linkLocal?: string;
    addresses: Array<{
      address: string;
      prefixLength: number;
      source: "link-local" | "static" | "slaac" | "dhcpv6";
      state: "tentative" | "preferred" | "deprecated" | "duplicate";
    }>;
    defaultRouter?: string;
    dnsServer?: string;
    dhcpv6State: string;
    lease?: {
      address: string;
      prefixLength: number;
      dnsServers: readonly string[];
    };
    neighbors: Array<{
      address: string;
      macAddress: string;
      state: string;
    }>;
    problems: string[];
  };
}

export interface WirelessStationView {
  deviceId: string;
  configuration: WirelessStationConfiguration;
  status: WirelessAssociationStatus;
  networks: WirelessNetworkSummary[];
  document: LabDocument;
}

export interface WirelessAccessPointClientView {
  deviceId: string;
  hostname: string;
  macAddress: string;
  associatedAtNs: number;
  ipv4Address?: string;
  ipv6Addresses: string[];
  security: "open" | "wpa2-personal";
}

export interface WirelessAccessPointView {
  deviceId: string;
  configuration: WirelessAccessPointConfiguration;
  clients: WirelessAccessPointClientView[];
  document: LabDocument;
}

export type SecurityDeviceConfiguration = Extract<
  DeviceConfig,
  { kind: "router" | "l3-switch" | "firewall" | "cloud" | "traffic-generator" }
>;

export interface SecurityConfigurationView {
  deviceId: string;
  configuration: SecurityDeviceConfiguration;
  document: LabDocument;
  runtime: {
    aclCounters: AclCounter[];
    natTranslations: NatTranslation[];
    firewallConnections: FirewallConnection[];
    trafficResults: TrafficFlowResult[];
  };
}

/** One interface's live egress queue state. Runtime only; never persisted. */
export interface QosInterfaceQueueView {
  interfaceName: string;
  policyMapId?: string;
  depthPackets: number;
  depthBytes: number;
  droppedPackets: number;
  dropsByReason: Readonly<Record<string, number>>;
  maximumWaitingTimeNs: number;
  capacityBps: number;
  classes: Array<{
    className: string;
    depthPackets: number;
    limitPackets: number;
    dequeuedPackets: number;
    dequeuedBytes: number;
    droppedPackets: number;
  }>;
}

export interface QosConfigurationView {
  deviceId: string;
  configuration: QosConfiguration;
  document: LabDocument;
  runtime: {
    counters: QosClassCounter[];
    queues: QosInterfaceQueueView[];
    problems: QosProblem[];
  };
}

/**
 * One tunnel row for the VPN panel. Configuration comes from the document; the
 * operational verdict is recomputed from the engine and is never persisted.
 */
export interface VpnTunnelView {
  name: string;
  tunnelId: number;
  source: { type: "interface"; interfaceId: string } | { type: "address"; address: string };
  sourceAddress?: string;
  destinationAddress: string;
  mode: "gre-ipv4";
  mtu: number;
  ttl: number;
  adminUp: boolean;
  operationalUp: boolean;
  /** Why the tunnel is down; absent while it is operational. */
  reason?: string;
  ipv4?: { address: string; prefixLength: number };
  ipv6: Array<{ address: string; prefixLength: number }>;
  ipsecProfileId?: string;
  protected: boolean;
}

/**
 * IKE and IPsec runtime. It never carries a pre-shared key or a verifier: the
 * panel only ever learns *that* a key is configured.
 */
export interface VpnIkePeerView {
  peerId: string;
  remoteAddress: string;
  localAddress?: string;
  state: "DOWN" | "INITIATING" | "NEGOTIATING" | "ESTABLISHED" | "REKEYING" | "FAILED" | "EXPIRED";
  role?: "initiator" | "responder";
  proposalId: string;
  lifetimeSeconds: number;
  establishedAtNs?: number;
  expiresAtNs?: number;
  failureReason?: string;
  tunnelId?: string;
  /** True when a key is stored. The key and its verifier are never sent. */
  preSharedKeyConfigured: boolean;
}

export interface VpnSecurityAssociationView {
  id: string;
  direction: "inbound" | "outbound";
  peerAddress: string;
  spi: number;
  proposalId: string;
  sequenceNumber: number;
  state: "active" | "rekeying" | "expired";
  generation: number;
  /** Virtual age in nanoseconds, so the panel never shows a wall clock. */
  ageNs: number;
  expiresInNs: number;
  packetCount: number;
  byteCount: number;
}

export interface VpnConfigurationView {
  deviceId: string;
  configuration: VpnConfiguration;
  document: LabDocument;
  runtime: {
    tunnels: VpnTunnelView[];
    peers: VpnIkePeerView[];
    associations: VpnSecurityAssociationView[];
    problems: Array<{ code: string; message: string; tunnelId?: string; peerId?: string }>;
  };
}

/**
 * One device's configuration lifecycle, as the workspace sees it.
 *
 * Both text projections are rendered by the worker from structured state, so
 * the UI never renders configuration itself and can never show something the
 * engine does not actually hold. Neither text ever contains a secret.
 */
export interface DeviceConfigurationView {
  deviceId: string;
  hostname: string;
  deviceType: DeviceType;
  /** Interface ids the device actually has, for parsing pasted text. */
  interfaceIds: string[];
  /** Structured running configuration — the canonical source of truth. */
  configuration: DeviceConfig;
  runningConfigurationText: string;
  startupConfigurationText: string;
  drift: ConfigurationDrift;
  runningDigest: string;
  startupDigest?: string;
  /** False for a host, which is configured through Desktop / IP Configuration. */
  supportsConfigurationText: boolean;
  /** False when text can be read and exported but not applied back. */
  supportsConfigurationApply: boolean;
  document: LabDocument;
}

/** Configuration status for every device, for badges and Save All. */
export interface LabConfigurationStatusView {
  devices: Array<{
    deviceId: string;
    hostname: string;
    deviceType: DeviceType;
    drift: ConfigurationDrift;
    supportsConfigurationText: boolean;
  }>;
  document: LabDocument;
}

/** The result of changing one cable's deterministic performance. */
export interface LinkPerformanceView {
  linkId: string;
  performance: {
    capacityBps: number;
    propagationDelayNs: number;
    queueLimitPackets: number;
  };
  document: LabDocument;
  snapshot: LabUiSnapshot;
}

/**
 * Read-only control-protocol views. Everything here is runtime state that never
 * reaches a `LabDocument`; the UI renders it and the worker recomputes it from
 * the engine on demand.
 */
export interface SpanningTreeView {
  deviceId: string;
  summary: SpanningTreeSummary;
}

export interface EtherChannelView {
  deviceId: string;
  channels: EtherChannelSummary[];
}

export interface DiscoveryNeighborsView {
  deviceId: string;
  neighbors: DiscoveryNeighbor[];
  interfaces: DiscoveryInterfaceStatus[];
  cdpRunning: boolean;
  lldpRunning: boolean;
}

export interface OspfOverviewView {
  deviceId: string;
  overview: OspfOverview;
}

export interface OspfNeighborsView {
  deviceId: string;
  neighbors: OspfNeighborSummary[];
}

export interface OspfInterfacesView {
  deviceId: string;
  interfaces: OspfInterfaceSummary[];
}

export interface OspfDatabaseView {
  deviceId: string;
  entries: OspfLsdbEntry[];
  routes: OspfRoute[];
}

export interface Ospfv3View {
  deviceId: string;
  overview: Ospfv3Overview;
  neighbors: Ospfv3NeighborSummary[];
  database: Ospfv3LsdbEntry[];
  routes: Ospfv3Route[];
}

export interface BgpStateView {
  deviceId: string;
  configuration?: import("@sim/contracts").BgpProcessConfig;
  neighbors: BgpNeighborSummary[];
  routes: BgpRibEntry[];
  adjRibIn: BgpRoute[];
  adjRibOut: BgpRoute[];
  ribFailures: Array<{ routeId: string; reason: string }>;
  policyCounters: RoutePolicyCounter[];
  /**
   * M10.12 route reflection, communities, policy lists and aggregation. Every
   * field is derived runtime state rebuilt from configuration; none of it is
   * persisted in a `LabDocument` or trusted from the browser.
   */
  routeReflection: {
    clusterId: string;
    isRouteReflector: boolean;
    clients: string[];
    nonClients: string[];
    reflectedRoutes: number;
    originatorLoopsRejected: number;
    clusterLoopsRejected: number;
  };
  communities: Array<{ community: string; routes: number }>;
  communityLists: CommunityList[];
  asPathLists: AsPathList[];
  aggregates: BgpAggregateSummary[];
  suppressedRoutes: BgpSuppressedRoute[];
  /**
   * M10.13 address families. One BGP process and one TCP session can carry
   * several activated families, so the RIBs are reported per family instead of
   * being duplicated into a second view. `ipv4Unicast` stays in the flat fields
   * above so an older panel keeps working unchanged.
   */
  ipv6Unicast: BgpUnicastFamilyView;
  /** Which families this device has activated on at least one neighbor. */
  addressFamilies: BgpUnicastAddressFamily[];
}

/** Per-address-family RIB snapshot. Runtime only: never persisted or trusted. */
export interface BgpUnicastFamilyView {
  addressFamily: BgpUnicastAddressFamily;
  routes: BgpRibEntry[];
  adjRibIn: BgpRoute[];
  adjRibOut: BgpRoute[];
  ribFailures: Array<{ routeId: string; reason: string }>;
  /** Neighbors that negotiated this family, by transport address. */
  neighbors: string[];
  communities: Array<{ community: string; routes: number }>;
}

/** Router-only MPLS/LDP/L3VPN inspection. Runtime tables are never persisted. */
export interface MplsL3VpnView {
  deviceId: string;
  interfaces: Array<{ interfaceId: string; enabled: boolean; operational: boolean }>;
  forwardingTable: MplsForwardingEntry[];
  ldpRouterId?: string;
  ldpNeighbors: LdpNeighborSummary[];
  ldpBindings: LdpLabelBinding[];
  vrfs: Array<{
    id: string;
    name: string;
    routeDistinguisher: string;
    importRouteTargets: string[];
    exportRouteTargets: string[];
  }>;
  vrfRoutes: Record<string, VrfRoute[]>;
  vpnv4Routes: Vpnv4Route[];
  /**
   * M10.13: a VPN label is allocated per VRF *and* address family, so IPv4 and
   * IPv6 delivery on the same VRF are explicitly separate label values.
   */
  vpnLabelBindings: Array<{ label: number; vrfId: string; addressFamily: "ipv4" | "ipv6" }>;
  /** M10.13 VRF IPv6 tables, keyed by VRF id exactly like `vrfRoutes`. */
  vrfIpv6Routes: Record<string, VrfIpv6Route[]>;
  vpnv6Routes: Vpnv6Route[];
}

/**
 * L3-Switch VXLAN/EVPN inspection, as plain JSON.
 *
 * Every table here is runtime: the remote MAC table, EVPN-derived membership
 * and the EVPN RIB are rebuilt from structured configuration by the browser
 * worker and the verifier alike, and none of them reaches a `LabDocument`.
 */
export interface VxlanEvpnView {
  deviceId: string;
  nve: Array<{
    id: string;
    sourceInterfaceId: string;
    adminUp: boolean;
    vniCount: number;
    up: boolean;
    sourceAddress?: string;
    reason?: string;
  }>;
  vnis: Array<{
    vni: number;
    vlanId: number;
    replication: "static" | "bgp-evpn";
    up: boolean;
    sourceAddress?: string;
    reason?: string;
    /** The RD and route targets this VNI advertises with, when configured. */
    routeDistinguisher?: string;
    importRouteTargets: string[];
    exportRouteTargets: string[];
  }>;
  peers: Array<{
    vni: number;
    address: string;
    source: "static" | "bgp-evpn";
    reachable: boolean;
  }>;
  remoteMacs: Array<{
    vni: number;
    mac: string;
    remoteVtep: string;
    source: "data-plane" | "bgp-evpn";
    lastSeenNs: number;
  }>;
  evpnRoutes: Array<{
    type: 2 | 3 | 5;
    routeDistinguisher: string;
    /** The L2VNI of a Type 2/3; the transit L3VNI of a Type 5. */
    vni: number;
    best: boolean;
    nextHop: string;
    routeTargets: string[];
    /** Type 2 only. */
    macAddress?: string;
    ipAddress?: string;
    /** Type 3 only. */
    originatingVtep?: string;
    /** Type 5 only: the advertised tenant prefix and the VTEP that owns it. */
    network?: string;
    prefixLength?: number;
    nextHopVtep?: string;
    originatorId?: string;
    clusterList: string[];
    source: string;
    neighborAddress?: string;
  }>;
  evpnAddressFamilyActive: boolean;
  problems: string[];
}

/**
 * Read-only management views. Everything here is runtime state recomputed from
 * the engine on demand: it never reaches a `LabDocument`, a submission or the
 * database, and it never carries a password, shared key or community string.
 */
export interface RemoteSessionsView {
  deviceId: string;
  sessions: Array<{
    id: string;
    line: number;
    protocol: "telnet" | "ssh";
    clientDeviceId: string;
    clientHostname: string;
    peerAddress: string;
    username?: string;
    privilegeLevel: number;
    authenticated: boolean;
    openedAtNs: number;
    idleForNs: number;
  }>;
  lines: Array<{
    index: number;
    state: string;
    protocol?: "telnet" | "ssh";
    username?: string;
    peerAddress?: string;
    idleForNs?: number;
    transports: string[];
    loginMode: string;
    execTimeoutSeconds: number;
  }>;
  telnetEnabled: boolean;
  sshEnabled: boolean;
  hostKeyFingerprint?: string;
}

export interface AaaStatusResponse {
  deviceId: string;
  enabled: boolean;
  configuration: AaaConfiguration;
  servers: Array<{
    name: string;
    protocol: "radius" | "tacacs+";
    address: string;
    reachable?: boolean;
    lastResultAtNs?: number;
    failures: number;
  }>;
  lastAuthentication?: { username: string; method: string; result: "accept" | "reject"; atNs: number };
  sessions: Array<{ sessionId: string; username: string; privilegeLevel: number; method: string; startedAtNs: number }>;
}

export interface SnmpAgentStatusView {
  deviceId: string;
  configuration: SnmpAgentConfiguration;
  /** Every readable object of the built-in MIB, in canonical OID order. */
  mib: SnmpVarBind[];
}

export interface SnmpOperationView {
  deviceId: string;
  runtime: NmsRuntimeSnapshot;
}

export type SimWorkerRequest =
  | { type: "INITIALIZE_LAB"; requestId: string; document: LabDocument }
  | { type: "REBUILD_LAB"; requestId: string; document: LabDocument }
  | {
      type: "EXECUTE_CLI";
      requestId: string;
      sessionId: string;
      deviceId: string;
      input: string;
      /** Opaque credential fingerprint answering a remote credential prompt. */
      credential?: string;
    }
  | { type: "CLOSE_CLI_SESSION"; requestId: string; sessionId: string }
  | { type: "RUN_UNTIL_IDLE"; requestId: string }
  | { type: "STEP_NEXT_EVENT"; requestId: string }
  | { type: "SET_EXECUTION_MODE"; requestId: string; mode: PacketExecutionMode }
  | { type: "ADVANCE_TIME"; requestId: string; milliseconds: number }
  | { type: "SET_PAUSED"; requestId: string; paused: boolean }
  | { type: "RESET_RUNTIME"; requestId: string }
  | { type: "GET_SNAPSHOT"; requestId: string }
  | { type: "GET_DEVICE_INSPECTION"; requestId: string; deviceId: string }
  | { type: "GET_HOST_IP_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "SET_HOST_STATIC_CONFIGURATION"; requestId: string; deviceId: string; configuration: HostStaticConfiguration }
  | { type: "SET_HOST_DHCP_MODE"; requestId: string; deviceId: string; startImmediately: boolean }
  | { type: "RENEW_HOST_DHCP"; requestId: string; deviceId: string }
  | { type: "RELEASE_HOST_DHCP"; requestId: string; deviceId: string }
  | { type: "GET_HOST_NETWORK_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_HOST_IPV6_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "SET_HOST_IPV6_STATIC_CONFIGURATION"; requestId: string; deviceId: string; configuration: HostIpv6Config }
  | { type: "SET_HOST_IPV6_MODE"; requestId: string; deviceId: string; mode: "slaac" | "dhcpv6"; startImmediately: boolean }
  | { type: "RENEW_HOST_DHCPV6"; requestId: string; deviceId: string }
  | { type: "RELEASE_HOST_DHCPV6"; requestId: string; deviceId: string }
  | { type: "GET_HOST_IPV6_NETWORK_STATUS"; requestId: string; deviceId: string }
  | { type: "SCAN_WIRELESS_NETWORKS"; requestId: string; deviceId: string; explicitSsid?: string }
  | {
      type: "CONNECT_WIRELESS_NETWORK";
      requestId: string;
      deviceId: string;
      ssid: string;
      securityMode: "open" | "wpa2-personal";
      preferredBssid?: string;
      credentialVerifier?: PasswordVerifier;
      saveNetwork: boolean;
    }
  | { type: "DISCONNECT_WIRELESS_NETWORK"; requestId: string; deviceId: string }
  | { type: "FORGET_WIRELESS_NETWORK"; requestId: string; deviceId: string; profileId: string }
  | { type: "GET_WIRELESS_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_AP_CLIENTS"; requestId: string; deviceId: string }
  | { type: "CONFIGURE_ACCESS_POINT"; requestId: string; deviceId: string; configuration: WirelessAccessPointConfiguration }
  | { type: "SET_WIRELESS_SECURITY"; requestId: string; deviceId: string; security: WirelessSecurityConfiguration }
  | { type: "DISCONNECT_AP_CLIENT"; requestId: string; deviceId: string; stationDeviceId: string }
  | { type: "GET_SERVER_SERVICES"; requestId: string; deviceId: string }
  | { type: "CONFIGURE_SERVER_SERVICE"; requestId: string; deviceId: string; configuration: ServerServiceConfig }
  | { type: "ENABLE_SERVER_SERVICE"; requestId: string; deviceId: string; serviceId: string }
  | { type: "DISABLE_SERVER_SERVICE"; requestId: string; deviceId: string; serviceId: string }
  | { type: "GET_SERVER_SERVICE_RUNTIME"; requestId: string; deviceId: string }
  | { type: "CLEAR_SYSLOG_RUNTIME"; requestId: string; deviceId: string }
  | { type: "GET_SECURITY_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "SET_SECURITY_CONFIGURATION"; requestId: string; deviceId: string; configuration: SecurityDeviceConfiguration }
  | { type: "RUN_TRAFFIC_FLOW"; requestId: string; deviceId: string; flowId: string }
  | { type: "CLEAR_SECURITY_RUNTIME"; requestId: string; deviceId: string }
  // --- M10.8 quality of service ---
  | { type: "GET_QOS_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "SET_QOS_CONFIGURATION"; requestId: string; deviceId: string; configuration: QosConfiguration }
  | { type: "CLEAR_QOS_RUNTIME"; requestId: string; deviceId: string }
  // --- M10.9 site-to-site VPN (inspection + bounded runtime actions) ---
  | { type: "GET_TUNNEL_INTERFACES"; requestId: string; deviceId: string }
  | { type: "GET_IKE_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_IPSEC_SAS"; requestId: string; deviceId: string }
  | { type: "RESTART_IKE_PEER"; requestId: string; deviceId: string; peerId?: string }
  | { type: "CLEAR_IPSEC_SAS"; requestId: string; deviceId: string }
  /**
   * Store a pre-shared key from an already-derived, scope-bound verifier. The
   * plaintext key is derived in the main thread and never crosses this boundary.
   */
  | {
      type: "SET_IKE_PRE_SHARED_KEY";
      requestId: string;
      deviceId: string;
      peerId: string;
      verifier: PasswordVerifier;
    }
  | {
      type: "SET_LINK_PERFORMANCE";
      requestId: string;
      linkId: string;
      performance: {
        capacityBps?: number;
        propagationDelayNs?: number;
        queueLimitPackets?: number;
      };
    }
  // --- M10.4 control protocols (inspection + bounded runtime actions) ---
  | { type: "GET_SPANNING_TREE_STATE"; requestId: string; deviceId: string }
  | { type: "RESET_BPDU_GUARD_PORT"; requestId: string; deviceId: string; interfaceId: string }
  | { type: "GET_ETHERCHANNEL_STATE"; requestId: string; deviceId: string }
  | { type: "GET_DISCOVERY_NEIGHBORS"; requestId: string; deviceId: string }
  | { type: "CLEAR_DISCOVERY_NEIGHBORS"; requestId: string; deviceId: string; protocol?: "cdp" | "lldp" }
  | { type: "GET_OSPF_OVERVIEW"; requestId: string; deviceId: string }
  | { type: "GET_OSPF_NEIGHBORS"; requestId: string; deviceId: string }
  | { type: "GET_OSPF_INTERFACES"; requestId: string; deviceId: string }
  | { type: "GET_OSPF_DATABASE"; requestId: string; deviceId: string }
  | { type: "RESTART_OSPF_PROCESS"; requestId: string; deviceId: string }
  | { type: "GET_OSPFV3_STATE"; requestId: string; deviceId: string }
  | { type: "RESTART_OSPFV3_PROCESS"; requestId: string; deviceId: string }
  | { type: "GET_BGP_STATE"; requestId: string; deviceId: string }
  | { type: "RESET_BGP_SESSION"; requestId: string; deviceId: string; neighbor?: string }
  | { type: "GET_BGP_OVERVIEW"; requestId: string; deviceId: string }
  | { type: "GET_BGP_SUMMARY"; requestId: string; deviceId: string }
  | { type: "GET_BGP_NEIGHBORS"; requestId: string; deviceId: string }
  | { type: "GET_BGP_TABLE"; requestId: string; deviceId: string }
  | { type: "GET_BGP_ROUTE"; requestId: string; deviceId: string; network: string; prefixLength: number }
  | { type: "GET_PREFIX_LIST_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_ROUTE_MAP_STATUS"; requestId: string; deviceId: string }
  | { type: "RESET_BGP_NEIGHBOR"; requestId: string; deviceId: string; neighbor: string }
  | { type: "RESET_BGP_PROCESS"; requestId: string; deviceId: string }
  | { type: "GET_BGP_ROUTE_REFLECTION_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_BGP_COMMUNITIES"; requestId: string; deviceId: string }
  | { type: "GET_BGP_AGGREGATES"; requestId: string; deviceId: string }
  | { type: "GET_BGP_SUPPRESSED_ROUTES"; requestId: string; deviceId: string }
  | { type: "GET_BGP_POLICY_COUNTERS"; requestId: string; deviceId: string }
  | {
    type: "SOFT_RESET_BGP_NEIGHBOR";
    requestId: string;
    deviceId: string;
    neighbor?: string;
    direction?: "in" | "out" | "both";
  }
  // --- M10.13 MP-BGP IPv6 unicast inspection ---
  | { type: "GET_BGP_IPV6_TABLE"; requestId: string; deviceId: string }
  | { type: "GET_BGP_IPV6_NEIGHBORS"; requestId: string; deviceId: string }
  // --- M10.11 Router-only MPLS, LDP and L3VPN inspection ---
  | { type: "GET_MPLS_INTERFACES"; requestId: string; deviceId: string }
  | { type: "GET_MPLS_FORWARDING_TABLE"; requestId: string; deviceId: string }
  | { type: "GET_LDP_NEIGHBORS"; requestId: string; deviceId: string }
  | { type: "GET_LDP_BINDINGS"; requestId: string; deviceId: string }
  | { type: "GET_VRFS"; requestId: string; deviceId: string }
  | { type: "GET_VRF_ROUTES"; requestId: string; deviceId: string; vrfId?: string }
  | { type: "GET_VPNV4_TABLE"; requestId: string; deviceId: string }
  | { type: "GET_VPN_LABEL_BINDINGS"; requestId: string; deviceId: string }
  // --- M10.13 VRF IPv6 and VPNv6 inspection ---
  | { type: "GET_VRF_IPV6_ROUTES"; requestId: string; deviceId: string; vrfId?: string }
  | { type: "GET_VPNV6_TABLE"; requestId: string; deviceId: string }
  | { type: "GET_VPNV6_LABEL_BINDINGS"; requestId: string; deviceId: string }
  | { type: "RESTART_LDP"; requestId: string; deviceId: string }
  | { type: "RESET_MPLS_RUNTIME"; requestId: string; deviceId: string }
  // --- M10.14 VXLAN and BGP EVPN inspection (runtime, never persisted) ---
  | { type: "GET_NVE_INTERFACES"; requestId: string; deviceId: string }
  | { type: "GET_VXLAN_VNIS"; requestId: string; deviceId: string }
  | { type: "GET_VXLAN_PEERS"; requestId: string; deviceId: string }
  | { type: "GET_VXLAN_REMOTE_MACS"; requestId: string; deviceId: string }
  | { type: "GET_EVPN_ROUTES"; requestId: string; deviceId: string }
  | { type: "GET_EVPN_VNI_MEMBERS"; requestId: string; deviceId: string }
  | { type: "CLEAR_VXLAN_RUNTIME"; requestId: string; deviceId: string }
  | { type: "RESTART_NVE"; requestId: string; deviceId: string }
  // --- M10.7 management plane (inspection + bounded runtime actions) ---
  | { type: "GET_REMOTE_SESSIONS"; requestId: string; deviceId: string }
  | { type: "CLEAR_REMOTE_LINE"; requestId: string; deviceId: string; line: number }
  | { type: "GET_AAA_STATUS"; requestId: string; deviceId: string }
  | { type: "GET_SNMP_AGENT_STATUS"; requestId: string; deviceId: string }
  | { type: "SNMP_GET"; requestId: string; deviceId: string; targetId: string; oid: string }
  | { type: "SNMP_GETNEXT"; requestId: string; deviceId: string; targetId: string; oid: string }
  | { type: "SNMP_WALK"; requestId: string; deviceId: string; targetId: string; oid: string }
  | { type: "GET_NMS_TRAPS"; requestId: string; deviceId: string }
  | { type: "CLEAR_NMS_TRAPS"; requestId: string; deviceId: string }
  // --- M10.9.1 running / startup configuration lifecycle ---
  | { type: "GET_DEVICE_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "SAVE_DEVICE_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "ERASE_DEVICE_STARTUP_CONFIGURATION"; requestId: string; deviceId: string }
  | { type: "RELOAD_DEVICE"; requestId: string; deviceId: string; save: boolean }
  /**
   * Install structured configuration parsed from text. `running` rebuilds the
   * device from it; `startup` writes only the NVRAM snapshot, leaving the
   * running configuration alone until a reload.
   */
  | {
      type: "APPLY_DEVICE_CONFIGURATION";
      requestId: string;
      deviceId: string;
      configuration: DeviceConfig;
      target: "running" | "startup";
    }
  | { type: "GET_LAB_CONFIGURATION_STATUS"; requestId: string }
  | { type: "SAVE_ALL_DEVICE_CONFIGURATIONS"; requestId: string }
  | { type: "SERIALIZE_LAB"; requestId: string };

export type SimWorkerPayload =
  | LabUiSnapshot
  | CliExecutionResult
  | SimulationRunResult
  | DeviceInspection
  | HostIpConfiguration
  | HostNetworkStatus
  | HostIpv6Config
  | HostIpv6NetworkStatus
  | WirelessStationView
  | WirelessAccessPointView
  | ServerServicesView
  | ServerServiceRuntimeSnapshot
  | SecurityConfigurationView
  | QosConfigurationView
  | VpnConfigurationView
  | LinkPerformanceView
  | SpanningTreeView
  | EtherChannelView
  | DiscoveryNeighborsView
  | OspfOverviewView
  | OspfNeighborsView
  | OspfInterfacesView
  | OspfDatabaseView
  | Ospfv3View
  | BgpStateView
  | MplsL3VpnView
  | VxlanEvpnView
  | RemoteSessionsView
  | AaaStatusResponse
  | SnmpAgentStatusView
  | SnmpOperationView
  | DeviceConfigurationView
  | LabConfigurationStatusView
  | LabDocument
  | { closed: boolean }
  | { paused: boolean; snapshot: LabUiSnapshot };

export type SimWorkerResponse =
  | { type: "REQUEST_SUCCEEDED"; requestId: string; payload: SimWorkerPayload }
  | { type: "REQUEST_FAILED"; requestId: string; error: SerializedWorkerError };

export type SimWorkerEvent =
  | { type: "LAB_READY"; snapshot: LabUiSnapshot }
  | { type: "STATE_CHANGED"; snapshot: LabUiSnapshot }
  | { type: "TRACE_BATCH"; events: SimulationTraceEvent[] }
  | { type: "RUNTIME_WARNING"; warnings: HostNetworkWarning[] }
  | ({ type: "CLI_OUTPUT" } & CliExecutionResult)
  | { type: "RUNTIME_ERROR"; error: SerializedWorkerError };

export type SimWorkerOutboundMessage = SimWorkerResponse | SimWorkerEvent;

export type SimWorkerRequestInput = SimWorkerRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, "requestId">
    : never
  : never;

export interface SimWorkerPayloadByType {
  INITIALIZE_LAB: LabUiSnapshot;
  REBUILD_LAB: LabUiSnapshot;
  EXECUTE_CLI: CliExecutionResult;
  CLOSE_CLI_SESSION: { closed: boolean };
  RUN_UNTIL_IDLE: SimulationRunResult;
  STEP_NEXT_EVENT: SimulationRunResult;
  SET_EXECUTION_MODE: SimulationRunResult;
  ADVANCE_TIME: SimulationRunResult;
  SET_PAUSED: { paused: boolean; snapshot: LabUiSnapshot };
  RESET_RUNTIME: LabUiSnapshot;
  GET_SNAPSHOT: LabUiSnapshot;
  GET_DEVICE_INSPECTION: DeviceInspection;
  GET_HOST_IP_CONFIGURATION: HostIpConfiguration;
  SET_HOST_STATIC_CONFIGURATION: HostNetworkStatus;
  SET_HOST_DHCP_MODE: HostNetworkStatus;
  RENEW_HOST_DHCP: HostNetworkStatus;
  RELEASE_HOST_DHCP: HostNetworkStatus;
  GET_HOST_NETWORK_STATUS: HostNetworkStatus;
  GET_HOST_IPV6_CONFIGURATION: HostIpv6Config;
  SET_HOST_IPV6_STATIC_CONFIGURATION: HostIpv6NetworkStatus;
  SET_HOST_IPV6_MODE: HostIpv6NetworkStatus;
  RENEW_HOST_DHCPV6: HostIpv6NetworkStatus;
  RELEASE_HOST_DHCPV6: HostIpv6NetworkStatus;
  GET_HOST_IPV6_NETWORK_STATUS: HostIpv6NetworkStatus;
  SCAN_WIRELESS_NETWORKS: WirelessStationView;
  CONNECT_WIRELESS_NETWORK: WirelessStationView;
  DISCONNECT_WIRELESS_NETWORK: WirelessStationView;
  FORGET_WIRELESS_NETWORK: WirelessStationView;
  GET_WIRELESS_STATUS: WirelessStationView;
  GET_AP_CLIENTS: WirelessAccessPointView;
  CONFIGURE_ACCESS_POINT: WirelessAccessPointView;
  SET_WIRELESS_SECURITY: WirelessAccessPointView;
  DISCONNECT_AP_CLIENT: WirelessAccessPointView;
  GET_SERVER_SERVICES: ServerServicesView;
  CONFIGURE_SERVER_SERVICE: ServerServicesView;
  ENABLE_SERVER_SERVICE: ServerServicesView;
  DISABLE_SERVER_SERVICE: ServerServicesView;
  GET_SERVER_SERVICE_RUNTIME: ServerServiceRuntimeSnapshot;
  CLEAR_SYSLOG_RUNTIME: ServerServiceRuntimeSnapshot;
  GET_SECURITY_CONFIGURATION: SecurityConfigurationView;
  SET_SECURITY_CONFIGURATION: SecurityConfigurationView;
  RUN_TRAFFIC_FLOW: SecurityConfigurationView;
  CLEAR_SECURITY_RUNTIME: SecurityConfigurationView;
  GET_QOS_CONFIGURATION: QosConfigurationView;
  SET_QOS_CONFIGURATION: QosConfigurationView;
  CLEAR_QOS_RUNTIME: QosConfigurationView;
  GET_TUNNEL_INTERFACES: VpnConfigurationView;
  GET_IKE_STATUS: VpnConfigurationView;
  GET_IPSEC_SAS: VpnConfigurationView;
  RESTART_IKE_PEER: VpnConfigurationView;
  CLEAR_IPSEC_SAS: VpnConfigurationView;
  SET_IKE_PRE_SHARED_KEY: VpnConfigurationView;
  SET_LINK_PERFORMANCE: LinkPerformanceView;
  GET_SPANNING_TREE_STATE: SpanningTreeView;
  RESET_BPDU_GUARD_PORT: SpanningTreeView;
  GET_ETHERCHANNEL_STATE: EtherChannelView;
  GET_DISCOVERY_NEIGHBORS: DiscoveryNeighborsView;
  CLEAR_DISCOVERY_NEIGHBORS: DiscoveryNeighborsView;
  GET_OSPF_OVERVIEW: OspfOverviewView;
  GET_OSPF_NEIGHBORS: OspfNeighborsView;
  GET_OSPF_INTERFACES: OspfInterfacesView;
  GET_OSPF_DATABASE: OspfDatabaseView;
  RESTART_OSPF_PROCESS: OspfOverviewView;
  GET_OSPFV3_STATE: Ospfv3View;
  RESTART_OSPFV3_PROCESS: Ospfv3View;
  GET_BGP_STATE: BgpStateView;
  RESET_BGP_SESSION: BgpStateView;
  GET_BGP_OVERVIEW: BgpStateView;
  GET_BGP_SUMMARY: BgpStateView;
  GET_BGP_NEIGHBORS: BgpStateView;
  GET_BGP_TABLE: BgpStateView;
  GET_BGP_ROUTE: BgpStateView;
  GET_PREFIX_LIST_STATUS: BgpStateView;
  GET_ROUTE_MAP_STATUS: BgpStateView;
  RESET_BGP_NEIGHBOR: BgpStateView;
  RESET_BGP_PROCESS: BgpStateView;
  GET_BGP_ROUTE_REFLECTION_STATUS: BgpStateView;
  GET_BGP_COMMUNITIES: BgpStateView;
  GET_BGP_AGGREGATES: BgpStateView;
  GET_BGP_SUPPRESSED_ROUTES: BgpStateView;
  GET_BGP_POLICY_COUNTERS: BgpStateView;
  SOFT_RESET_BGP_NEIGHBOR: BgpStateView;
  GET_BGP_IPV6_TABLE: BgpStateView;
  GET_BGP_IPV6_NEIGHBORS: BgpStateView;
  GET_MPLS_INTERFACES: MplsL3VpnView;
  GET_MPLS_FORWARDING_TABLE: MplsL3VpnView;
  GET_LDP_NEIGHBORS: MplsL3VpnView;
  GET_LDP_BINDINGS: MplsL3VpnView;
  GET_VRFS: MplsL3VpnView;
  GET_VRF_ROUTES: MplsL3VpnView;
  GET_VPNV4_TABLE: MplsL3VpnView;
  GET_VPN_LABEL_BINDINGS: MplsL3VpnView;
  GET_VRF_IPV6_ROUTES: MplsL3VpnView;
  GET_VPNV6_TABLE: MplsL3VpnView;
  GET_VPNV6_LABEL_BINDINGS: MplsL3VpnView;
  RESTART_LDP: MplsL3VpnView;
  RESET_MPLS_RUNTIME: MplsL3VpnView;
  GET_NVE_INTERFACES: VxlanEvpnView;
  GET_VXLAN_VNIS: VxlanEvpnView;
  GET_VXLAN_PEERS: VxlanEvpnView;
  GET_VXLAN_REMOTE_MACS: VxlanEvpnView;
  GET_EVPN_ROUTES: VxlanEvpnView;
  GET_EVPN_VNI_MEMBERS: VxlanEvpnView;
  CLEAR_VXLAN_RUNTIME: VxlanEvpnView;
  RESTART_NVE: VxlanEvpnView;
  GET_REMOTE_SESSIONS: RemoteSessionsView;
  CLEAR_REMOTE_LINE: RemoteSessionsView;
  GET_AAA_STATUS: AaaStatusResponse;
  GET_SNMP_AGENT_STATUS: SnmpAgentStatusView;
  SNMP_GET: SnmpOperationView;
  SNMP_GETNEXT: SnmpOperationView;
  SNMP_WALK: SnmpOperationView;
  GET_NMS_TRAPS: SnmpOperationView;
  CLEAR_NMS_TRAPS: SnmpOperationView;
  GET_DEVICE_CONFIGURATION: DeviceConfigurationView;
  SAVE_DEVICE_CONFIGURATION: DeviceConfigurationView;
  ERASE_DEVICE_STARTUP_CONFIGURATION: DeviceConfigurationView;
  RELOAD_DEVICE: DeviceConfigurationView;
  APPLY_DEVICE_CONFIGURATION: DeviceConfigurationView;
  GET_LAB_CONFIGURATION_STATUS: LabConfigurationStatusView;
  SAVE_ALL_DEVICE_CONFIGURATIONS: LabConfigurationStatusView;
  SERIALIZE_LAB: LabDocument;
}

export type SimWorkerRequestInputOf<Type extends SimWorkerRequest["type"]> = Extract<
  SimWorkerRequestInput,
  { type: Type }
>;
