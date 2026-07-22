import type { DeviceCapability, DeviceType, LabDocument, ServerServiceConfig } from "@sim/contracts";
import type { CliMode } from "@sim/cli-engine";
import type {
  DnsResolutionResult,
  HttpClientResult,
  NtpClientResult,
  ServerServiceRuntimeSnapshot,
  ServerServiceSummary,
  TcpConnectionInspection,
  TftpClientResult,
  UdpSocketInspection,
} from "@sim/sim-core";
export type { ServerServiceRuntimeSnapshot } from "@sim/sim-core";

export type EngineUiState = "idle" | "running" | "paused" | "error";

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

export interface LabUiSnapshot {
  labId: string;
  title: string;
  engineState: EngineUiState;
  virtualTime: number;
  nodes: LabUiNode[];
  links: LabUiLink[];
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
    kind: "connected" | "static";
    network: string;
    prefixLength: number;
    nextHop?: string;
    interfaceId: string;
  }>;
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

export type SimWorkerRequest =
  | { type: "INITIALIZE_LAB"; requestId: string; document: LabDocument }
  | { type: "REBUILD_LAB"; requestId: string; document: LabDocument }
  | { type: "EXECUTE_CLI"; requestId: string; sessionId: string; deviceId: string; input: string }
  | { type: "CLOSE_CLI_SESSION"; requestId: string; sessionId: string }
  | { type: "RUN_UNTIL_IDLE"; requestId: string }
  | { type: "ADVANCE_TIME"; requestId: string; milliseconds: number }
  | { type: "SET_PAUSED"; requestId: string; paused: boolean }
  | { type: "RESET_RUNTIME"; requestId: string }
  | { type: "GET_SNAPSHOT"; requestId: string }
  | { type: "GET_DEVICE_INSPECTION"; requestId: string; deviceId: string }
  | { type: "GET_SERVER_SERVICES"; requestId: string; deviceId: string }
  | { type: "CONFIGURE_SERVER_SERVICE"; requestId: string; deviceId: string; configuration: ServerServiceConfig }
  | { type: "ENABLE_SERVER_SERVICE"; requestId: string; deviceId: string; serviceId: string }
  | { type: "DISABLE_SERVER_SERVICE"; requestId: string; deviceId: string; serviceId: string }
  | { type: "GET_SERVER_SERVICE_RUNTIME"; requestId: string; deviceId: string }
  | { type: "CLEAR_SYSLOG_RUNTIME"; requestId: string; deviceId: string }
  | { type: "SERIALIZE_LAB"; requestId: string };

export type SimWorkerPayload =
  | LabUiSnapshot
  | CliExecutionResult
  | SimulationRunResult
  | DeviceInspection
  | ServerServicesView
  | ServerServiceRuntimeSnapshot
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
  ADVANCE_TIME: SimulationRunResult;
  SET_PAUSED: { paused: boolean; snapshot: LabUiSnapshot };
  RESET_RUNTIME: LabUiSnapshot;
  GET_SNAPSHOT: LabUiSnapshot;
  GET_DEVICE_INSPECTION: DeviceInspection;
  GET_SERVER_SERVICES: ServerServicesView;
  CONFIGURE_SERVER_SERVICE: ServerServicesView;
  ENABLE_SERVER_SERVICE: ServerServicesView;
  DISABLE_SERVER_SERVICE: ServerServicesView;
  GET_SERVER_SERVICE_RUNTIME: ServerServiceRuntimeSnapshot;
  CLEAR_SYSLOG_RUNTIME: ServerServiceRuntimeSnapshot;
  SERIALIZE_LAB: LabDocument;
}

export type SimWorkerRequestInputOf<Type extends SimWorkerRequest["type"]> = Extract<
  SimWorkerRequestInput,
  { type: Type }
>;
