import type {
  DeviceCapability,
  DeviceType,
  HostIpConfiguration,
  HostIpv6Config,
  HostStaticConfiguration,
  LabDocument,
  DeviceConfig,
  PasswordVerifier,
  ServerServiceConfig,
  WirelessAccessPointConfiguration,
  WirelessAssociationStatus,
  WirelessNetworkSummary,
  WirelessSecurityConfiguration,
  WirelessStationConfiguration,
} from "@sim/contracts";
import type { CliMode } from "@sim/cli-engine";
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
  TrafficFlowResult,
} from "@sim/sim-core";
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

export interface LabUiSnapshot {
  labId: string;
  title: string;
  engineState: EngineUiState;
  virtualTime: number;
  queuedEvents: number;
  nodes: LabUiNode[];
  links: LabUiLink[];
  wirelessAssociations?: LabUiWirelessAssociation[];
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
    kind: "connected" | "static" | "ospf";
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
      kind: "connected" | "static" | "ospfv3";
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
    | "access-point-no-uplink";
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
  | SpanningTreeView
  | EtherChannelView
  | DiscoveryNeighborsView
  | OspfOverviewView
  | OspfNeighborsView
  | OspfInterfacesView
  | OspfDatabaseView
  | Ospfv3View
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
  SERIALIZE_LAB: LabDocument;
}

export type SimWorkerRequestInputOf<Type extends SimWorkerRequest["type"]> = Extract<
  SimWorkerRequestInput,
  { type: Type }
>;
