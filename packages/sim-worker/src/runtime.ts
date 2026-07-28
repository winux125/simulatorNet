import { createCliSession, type CliSession } from "@sim/cli-engine";
import {
  HostStaticConfigurationSchema,
  HostIpv6ConfigSchema,
  PasswordVerifierSchema,
  WirelessAccessPointConfigurationSchema,
  WirelessSecurityConfigurationSchema,
  DeviceConfigSchema,
  ServerServiceConfigSchema,
  type DeviceConfig,
  type HostIpConfiguration,
  type HostIpv6Config,
  type LabDocument,
  type LabMetadata,
  type NodeSpec,
} from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  findDuplicateHostAddresses,
  migrateLabDocument,
  parseLabDocument,
  serializeLabDocument,
  type BuiltLab,
} from "@sim/lab-format";
import {
  AccessPoint,
  EndHost,
  EthernetBridge,
  Hub,
  L2Switch,
  Layer3Switch,
  Router,
  Server,
  TrafficGenerator,
  WirelessRouter,
  WirelessEndHost,
  Firewall,
  IspCloud,
  type Device,
  type Mac,
  type TraceEntry,
} from "@sim/sim-core";
import { SimulationWorkerError, serializeWorkerError } from "./errors";
import type {
  CliExecutionResult,
  EngineUiState,
  DeviceInspection,
  HostNetworkStatus,
  HostNetworkWarning,
  HostIpv6NetworkStatus,
  LabUiInterface,
  LabUiNode,
  LabUiSnapshot,
  PacketExecutionMode,
  SimWorkerEvent,
  SimWorkerOutboundMessage,
  SimWorkerPayload,
  SimWorkerRequest,
  SimWorkerResponse,
  SimulationRunResult,
  SimulationTraceEvent,
  ServerServicesView,
  SecurityConfigurationView,
  SecurityDeviceConfiguration,
  Ospfv3View,
  WirelessAccessPointView,
  WirelessStationView,
} from "./protocol";

interface CliSessionEntry {
  readonly deviceId: string;
  readonly session: CliSession;
}

type EmitMessage = (message: SimWorkerEvent) => void;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function requestIdOf(value: unknown): string {
  const requestId = recordOf(value)?.requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "uncorrelated";
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new SimulationWorkerError("invalid-request", `Request field '${key}' must be a string`);
  return value;
}

function describeTrace(entry: TraceEntry): string {
  const detail = entry.detail ?? {};
  const fragments = Object.entries(detail).slice(0, 3).map(([key, value]) => `${key}=${String(value)}`);
  return fragments.length > 0 ? `${entry.type}: ${fragments.join(", ")}` : entry.type;
}

function wirelessFailureCode(
  reason: string | undefined,
): HostNetworkWarning["code"] {
  if (reason === "authentication-failed") return "wireless-authentication-failed";
  if (reason === "incompatible-band-or-channel") return "wireless-incompatible-radio";
  if (reason === "access-point-client-limit") return "wireless-client-limit";
  if (reason === "wireless-interface-disabled") return "wireless-interface-disabled";
  return "wireless-no-access-point";
}

function wirelessFailureMessage(reason: string | undefined): string | undefined {
  if (reason === "authentication-failed") {
    return "Authentication failed. The wireless security key is incorrect.";
  }
  if (reason === "no-access-point") return "No access point with the requested SSID was found.";
  if (reason === "incompatible-band-or-channel") {
    return "No compatible access point is available on this radio band and channel set.";
  }
  if (reason === "access-point-client-limit") return "The access point client limit has been reached.";
  if (reason === "wireless-interface-disabled") return "The wireless interface is disabled.";
  return undefined;
}

export class SimulationWorkerRuntime {
  private builtLab: BuiltLab | undefined;
  private document: LabDocument | undefined;
  private metadata: LabMetadata | undefined;
  private readonly sessions = new Map<string, CliSessionEntry>();
  private traceCursor = 0;
  private engineState: EngineUiState = "idle";
  private executionMode: PacketExecutionMode = "auto";

  constructor(private readonly emit: EmitMessage = () => undefined) {}

  handleRequest(input: unknown): SimWorkerResponse {
    const requestId = requestIdOf(input);
    try {
      const payload = this.dispatch(input);
      return { type: "REQUEST_SUCCEEDED", requestId, payload };
    } catch (error) {
      const serialized = serializeWorkerError(error);
      if (requestId === "uncorrelated") this.emit({ type: "RUNTIME_ERROR", error: serialized });
      return { type: "REQUEST_FAILED", requestId, error: serialized };
    }
  }

  private dispatch(input: unknown): SimWorkerPayload {
    const request = recordOf(input);
    if (!request) throw new SimulationWorkerError("invalid-request", "Worker request must be an object");
    requireString(request, "requestId");
    const type = requireString(request, "type");
    switch (type) {
      case "INITIALIZE_LAB":
      case "REBUILD_LAB":
        return this.initialize(request.document, type === "INITIALIZE_LAB");
      case "EXECUTE_CLI":
        return this.executeCli(
          requireString(request, "sessionId"),
          requireString(request, "deviceId"),
          requireString(request, "input"),
          typeof request.credential === "string" ? request.credential : undefined,
        );
      case "CLOSE_CLI_SESSION":
        return { closed: this.closeCliSession(requireString(request, "sessionId")) };
      case "RUN_UNTIL_IDLE":
        return this.runUntilIdle();
      case "STEP_NEXT_EVENT":
        return this.stepNextEvent();
      case "SET_EXECUTION_MODE":
        return this.setExecutionMode(request.mode);
      case "ADVANCE_TIME":
        return this.advanceTime(request.milliseconds);
      case "SET_PAUSED":
        return this.setPaused(request.paused);
      case "RESET_RUNTIME":
        return this.resetRuntime();
      case "GET_SNAPSHOT":
        return this.snapshot();
      case "GET_DEVICE_INSPECTION":
        return this.inspectDevice(requireString(request, "deviceId"));
      case "GET_HOST_IP_CONFIGURATION":
        return this.hostIpConfiguration(requireString(request, "deviceId"));
      case "SET_HOST_STATIC_CONFIGURATION":
        return this.setHostStaticConfiguration(requireString(request, "deviceId"), request.configuration);
      case "SET_HOST_DHCP_MODE":
        return this.setHostDhcpMode(requireString(request, "deviceId"), request.startImmediately);
      case "RENEW_HOST_DHCP":
        return this.renewHostDhcp(requireString(request, "deviceId"));
      case "RELEASE_HOST_DHCP":
        return this.releaseHostDhcp(requireString(request, "deviceId"));
      case "GET_HOST_NETWORK_STATUS":
        return this.hostNetworkStatus(requireString(request, "deviceId"));
      case "GET_HOST_IPV6_CONFIGURATION":
        return this.hostIpv6Configuration(requireString(request, "deviceId"));
      case "SET_HOST_IPV6_STATIC_CONFIGURATION":
        return this.setHostIpv6StaticConfiguration(requireString(request, "deviceId"), request.configuration);
      case "SET_HOST_IPV6_MODE":
        return this.setHostIpv6Mode(requireString(request, "deviceId"), request.mode, request.startImmediately);
      case "RENEW_HOST_DHCPV6":
        return this.renewHostDhcpv6(requireString(request, "deviceId"));
      case "RELEASE_HOST_DHCPV6":
        return this.releaseHostDhcpv6(requireString(request, "deviceId"));
      case "GET_HOST_IPV6_NETWORK_STATUS":
        return this.hostIpv6NetworkStatus(requireString(request, "deviceId"));
      case "SCAN_WIRELESS_NETWORKS":
        return this.scanWirelessNetworks(requireString(request, "deviceId"), request.explicitSsid);
      case "CONNECT_WIRELESS_NETWORK":
        return this.connectWirelessNetwork(requireString(request, "deviceId"), request);
      case "DISCONNECT_WIRELESS_NETWORK":
        return this.disconnectWirelessNetwork(requireString(request, "deviceId"));
      case "FORGET_WIRELESS_NETWORK":
        return this.forgetWirelessNetwork(
          requireString(request, "deviceId"),
          requireString(request, "profileId"),
        );
      case "GET_WIRELESS_STATUS":
        return this.wirelessStationView(requireString(request, "deviceId"));
      case "GET_AP_CLIENTS":
        return this.wirelessAccessPointView(requireString(request, "deviceId"));
      case "CONFIGURE_ACCESS_POINT":
        return this.configureAccessPoint(requireString(request, "deviceId"), request.configuration);
      case "SET_WIRELESS_SECURITY":
        return this.setWirelessSecurity(requireString(request, "deviceId"), request.security);
      case "DISCONNECT_AP_CLIENT":
        return this.disconnectAccessPointClient(
          requireString(request, "deviceId"),
          requireString(request, "stationDeviceId"),
        );
      case "GET_SERVER_SERVICES":
        return this.serverServices(requireString(request, "deviceId"));
      case "CONFIGURE_SERVER_SERVICE":
        return this.configureServerService(requireString(request, "deviceId"), request.configuration);
      case "ENABLE_SERVER_SERVICE":
        return this.setServerServiceEnabled(requireString(request, "deviceId"), requireString(request, "serviceId"), true);
      case "DISABLE_SERVER_SERVICE":
        return this.setServerServiceEnabled(requireString(request, "deviceId"), requireString(request, "serviceId"), false);
      case "GET_SERVER_SERVICE_RUNTIME":
        return this.requireServer(requireString(request, "deviceId")).serviceRuntimeSnapshot();
      case "CLEAR_SYSLOG_RUNTIME": {
        const server = this.requireServer(requireString(request, "deviceId"));
        server.services.clearSyslog();
        return server.serviceRuntimeSnapshot();
      }
      case "GET_SECURITY_CONFIGURATION":
        return this.securityConfiguration(requireString(request, "deviceId"));
      case "SET_SECURITY_CONFIGURATION":
        return this.setSecurityConfiguration(requireString(request, "deviceId"), request.configuration);
      case "RUN_TRAFFIC_FLOW":
        return this.runTrafficFlow(requireString(request, "deviceId"), requireString(request, "flowId"));
      case "CLEAR_SECURITY_RUNTIME":
        return this.clearSecurityRuntime(requireString(request, "deviceId"));
      case "GET_SPANNING_TREE_STATE":
        return this.spanningTreeState(requireString(request, "deviceId"));
      case "RESET_BPDU_GUARD_PORT": {
        const deviceId = requireString(request, "deviceId");
        const interfaceId = requireString(request, "interfaceId");
        const device = this.requireSwitch(deviceId);
        if (!device.spanningTree.resetErrorDisabled(interfaceId)) {
          throw new SimulationWorkerError(
            "port-not-error-disabled",
            `Interface '${interfaceId}' on '${deviceId}' is not error-disabled`,
          );
        }
        this.runProtocolConvergence();
        return this.spanningTreeState(deviceId);
      }
      case "GET_ETHERCHANNEL_STATE": {
        const deviceId = requireString(request, "deviceId");
        return { deviceId, channels: this.requireSwitch(deviceId).etherChannelSummaries() };
      }
      case "GET_DISCOVERY_NEIGHBORS":
        return this.discoveryNeighbors(requireString(request, "deviceId"));
      case "CLEAR_DISCOVERY_NEIGHBORS": {
        const deviceId = requireString(request, "deviceId");
        const protocol = request.protocol;
        if (protocol !== undefined && protocol !== "cdp" && protocol !== "lldp") {
          throw new SimulationWorkerError("invalid-request", "protocol must be 'cdp' or 'lldp'");
        }
        this.requireDiscovery(deviceId).clearNeighbors(protocol);
        this.emitStateChanged();
        return this.discoveryNeighbors(deviceId);
      }
      case "GET_OSPF_OVERVIEW": {
        const deviceId = requireString(request, "deviceId");
        return { deviceId, overview: this.requireOspf(deviceId).ospf.overview() };
      }
      case "GET_OSPF_NEIGHBORS": {
        const deviceId = requireString(request, "deviceId");
        return { deviceId, neighbors: this.requireOspf(deviceId).ospf.neighborSummaries() };
      }
      case "GET_OSPF_INTERFACES": {
        const deviceId = requireString(request, "deviceId");
        return { deviceId, interfaces: this.requireOspf(deviceId).ospf.interfaceSummaries() };
      }
      case "GET_OSPF_DATABASE": {
        const deviceId = requireString(request, "deviceId");
        const device = this.requireOspf(deviceId);
        return { deviceId, entries: device.ospf.database(), routes: device.ospf.routeTable() };
      }
      case "RESTART_OSPF_PROCESS": {
        const deviceId = requireString(request, "deviceId");
        const device = this.requireOspf(deviceId);
        device.ospf.restart();
        this.runProtocolConvergence();
        return { deviceId, overview: device.ospf.overview() };
      }
      case "GET_OSPFV3_STATE":
        return this.ospfv3State(requireString(request, "deviceId"));
      case "RESTART_OSPFV3_PROCESS": {
        const deviceId = requireString(request, "deviceId");
        this.requireOspf(deviceId).ospfv3.restart();
        this.runProtocolConvergence();
        return this.ospfv3State(deviceId);
      }
      case "SERIALIZE_LAB":
        return this.serialize();
      default:
        throw new SimulationWorkerError("unknown-request-type", `Unknown worker request type '${type}'`);
    }
  }

  private initialize(input: unknown, isInitial: boolean): LabUiSnapshot {
    const migrated = migrateLabDocument(input);
    const parsed = parseLabDocument(migrated);
    const canonical = canonicalizeLabDocument(parsed);
    this.document = canonical;
    this.metadata = {
      id: canonical.id,
      title: canonical.title,
      description: canonical.description,
      instructions: canonical.instructions,
      expectedOutcome: canonical.expectedOutcome,
      diagram: canonical.diagram,
    };
    if (isInitial) this.executionMode = "auto";
    this.rebuildEngine(canonical);
    const snapshot = this.snapshot();
    this.emit({ type: isInitial ? "LAB_READY" : "STATE_CHANGED", snapshot });
    this.emitHostWarnings();
    this.flushTrace();
    return snapshot;
  }

  private rebuildEngine(document: LabDocument): void {
    // A rebuild replaces every device instance, so no remote session can
    // survive it: close them explicitly instead of leaking sockets and lines.
    this.builtLab?.management.closeAll("cleared-by-administrator");
    for (const entry of this.sessions.values()) entry.session.closeRemoteSession();
    this.builtLab = buildLabFromDocument(document);
    this.sessions.clear();
    this.traceCursor = 0;
    this.engineState = "idle";
    this.builtLab.engine.enableTrace();
    for (const node of document.topology.nodes) {
      const config = document.configurations[node.id];
      if (config?.kind === "pc" && config.dhcpEnabled) this.builtLab.getPc(node.id)?.requestDhcp();
      if (config?.kind === "server" && config.dhcpClientEnabled) this.builtLab.getServer(node.id)?.requestDhcp();
    }
    // Wireless stations resume DHCP/SLAAC/DHCPv6 from the medium's
    // association-complete callback, identically in worker and verifier.
    this.builtLab.engine.runUntilIdle();
  }

  private executeCli(sessionId: string, deviceId: string, input: string, credential?: string) {
    const built = this.requireBuiltLab();
    const existing = this.sessions.get(sessionId);
    if (existing && existing.deviceId !== deviceId) {
      throw new SimulationWorkerError(
        "cli-session-device-mismatch",
        `CLI session '${sessionId}' belongs to '${existing.deviceId}', not '${deviceId}'`,
      );
    }
    const device = built.getDevice(deviceId);
    if (!device) throw new SimulationWorkerError("unknown-device", `Unknown device '${deviceId}'`);
    if (!device.profile.cliProfile) {
      throw new SimulationWorkerError("cli-not-supported", `${device.profile.displayName} does not provide an interactive CLI`);
    }
    let entry = existing;
    if (!entry) {
      const session = createCliSession(device, built.engine);
      // Remote CLI is opened from a host terminal; the opener is owned by the
      // runtime so the CLI itself never reaches into the management plane.
      session.useRemoteSessionOpener(built.management);
      entry = { deviceId, session };
    }
    entry.session.setExecutionMode(this.executionMode);
    this.sessions.set(sessionId, entry);
    const output = entry.session.execute(input, credential);
    this.emitStateChanged();
    this.flushTrace();
    return this.cliResult(sessionId, entry, output);
  }

  private cliResult(sessionId: string, entry: CliSessionEntry, output: string): CliExecutionResult {
    const remote = entry.session.remoteSession();
    return {
      sessionId,
      deviceId: entry.deviceId,
      output,
      prompt: entry.session.prompt(),
      mode: entry.session.mode,
      deferred: entry.session.hasPendingOperation(),
      secret: entry.session.expectsSecret(),
      credentialScope: entry.session.credentialScope(),
      remote: remote ? { label: remote.label } : undefined,
    };
  }

  /** Closing a terminal tab also ends whatever remote session it carried. */
  private closeCliSession(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.session.closeRemoteSession();
    this.sessions.delete(sessionId);
    return true;
  }

  private runUntilIdle(): SimulationRunResult {
    const built = this.requireRunnable();
    // Each Auto run is one bounded operation, so the control-protocol event
    // budget starts fresh; a long session can never exhaust it by accident.
    built.engine.controlProtocolBudget.reset();
    this.engineState = "running";
    let processedEvents = 0;
    try {
      for (let phase = 0; phase < 16; phase++) {
        processedEvents += built.engine.runUntilIdle();
        this.emitCompletedCliOperations();
        if (built.engine.pendingEventCount() === 0) break;
        if (phase === 15) {
          throw new SimulationWorkerError("operation-phase-limit", "Queued operation exceeded its deterministic phase limit");
        }
      }
    } finally {
      this.engineState = "idle";
    }
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    this.flushTrace();
    return { processedEvents, virtualTime: built.engine.now(), snapshot };
  }

  private stepNextEvent(): SimulationRunResult {
    const built = this.requireRunnable();
    this.engineState = "running";
    const processedEvents = built.engine.runNextEvent() ? 1 : 0;
    this.engineState = "idle";
    this.emitCompletedCliOperations();
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    this.flushTrace();
    return { processedEvents, virtualTime: built.engine.now(), snapshot };
  }

  private setExecutionMode(input: unknown): SimulationRunResult {
    if (input !== "auto" && input !== "step") {
      throw new SimulationWorkerError("invalid-execution-mode", "Execution mode must be 'auto' or 'step'");
    }
    this.executionMode = input;
    for (const entry of this.sessions.values()) entry.session.setExecutionMode(input);
    if (input === "auto") return this.runUntilIdle();
    const built = this.requireBuiltLab();
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    return { processedEvents: 0, virtualTime: built.engine.now(), snapshot };
  }

  private advanceTime(milliseconds: unknown): SimulationRunResult {
    if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new SimulationWorkerError("invalid-time-step", "milliseconds must be a finite non-negative number");
    }
    const built = this.requireRunnable();
    built.engine.controlProtocolBudget.reset();
    this.engineState = "running";
    const target = built.engine.now() + Math.round(milliseconds * 1_000_000);
    const processedEvents = built.engine.advanceTo(target);
    this.engineState = "idle";
    // An explicit time advance is when a VTY `exec-timeout` becomes observable.
    built.management.enforceIdleTimeouts();
    this.emitCompletedCliOperations();
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    this.flushTrace();
    return { processedEvents, virtualTime: built.engine.now(), snapshot };
  }

  private setPaused(paused: unknown) {
    if (typeof paused !== "boolean") throw new SimulationWorkerError("invalid-request", "paused must be a boolean");
    this.engineState = paused ? "paused" : "idle";
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    return { paused, snapshot };
  }

  private resetRuntime(): LabUiSnapshot {
    const current = this.serialize();
    this.document = current;
    this.rebuildEngine(current);
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    this.flushTrace();
    return snapshot;
  }

  private serialize(): LabDocument {
    const built = this.requireBuiltLab();
    if (!this.metadata) throw new SimulationWorkerError("lab-not-initialized", "Lab metadata is unavailable");
    const document = serializeLabDocument(built, this.metadata);
    this.document = document;
    return document;
  }

  private securityConfiguration(deviceId: string): SecurityConfigurationView {
    const built = this.requireBuiltLab();
    const device = built.getDevice(deviceId);
    if (!device) throw new SimulationWorkerError("unknown-device", `Unknown device '${deviceId}'`);
    const document = this.serialize();
    const configuration = document.configurations[deviceId];
    if (!configuration || !isSecurityConfiguration(configuration)) {
      throw new SimulationWorkerError("security-not-supported", `Device '${deviceId}' has no security/tool configuration`);
    }
    return {
      deviceId,
      configuration,
      document,
      runtime: {
        aclCounters: device instanceof Router || device instanceof Layer3Switch ? device.aclCounters() : [],
        natTranslations: device instanceof Router ? device.natTranslations() : [],
        firewallConnections: device instanceof Firewall ? device.connectionTable() : [],
        trafficResults: device instanceof TrafficGenerator ? device.flowResults() : [],
      },
    };
  }

  private setSecurityConfiguration(deviceId: string, input: unknown): SecurityConfigurationView {
    const parsed = DeviceConfigSchema.safeParse(input);
    if (!parsed.success || !isSecurityConfiguration(parsed.data)) {
      throw new SimulationWorkerError("invalid-security-configuration", "Security/tool configuration validation failed");
    }
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!device) throw new SimulationWorkerError("unknown-device", `Unknown device '${deviceId}'`);
    if (device.deviceType !== parsed.data.kind) {
      throw new SimulationWorkerError(
        "configuration-type-mismatch",
        `Configuration kind '${parsed.data.kind}' does not match '${device.deviceType}'`,
      );
    }
    replaceSecurityConfiguration(device, parsed.data);
    this.emitStateChanged();
    this.flushTrace();
    return this.securityConfiguration(deviceId);
  }

  private runTrafficFlow(deviceId: string, flowId: string): SecurityConfigurationView {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!(device instanceof TrafficGenerator)) {
      throw new SimulationWorkerError("traffic-generator-required", `Device '${deviceId}' is not a Traffic Generator`);
    }
    device.startFlow(flowId);
    if (this.executionMode === "auto") this.runUntilIdle();
    else {
      this.emitStateChanged();
      this.flushTrace();
    }
    return this.securityConfiguration(deviceId);
  }

  private clearSecurityRuntime(deviceId: string): SecurityConfigurationView {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!device) throw new SimulationWorkerError("unknown-device", `Unknown device '${deviceId}'`);
    if (device instanceof Firewall) device.resetSecurityRuntime();
    else {
      if (device instanceof Router || device instanceof Layer3Switch) device.resetAclCounters();
      if (device instanceof Router) device.resetNatRuntime();
      if (device instanceof TrafficGenerator) device.resetFlowRuntime();
    }
    this.emitStateChanged();
    return this.securityConfiguration(deviceId);
  }

  private snapshot(): LabUiSnapshot {
    const built = this.requireBuiltLab();
    const document = this.document;
    if (!document) throw new SimulationWorkerError("lab-not-initialized", "Lab document is unavailable");
    return {
      labId: document.id,
      title: document.title,
      engineState: this.engineState,
      virtualTime: built.engine.now(),
      queuedEvents: built.engine.pendingEventCount(),
      nodes: document.topology.nodes.map((node, index) => this.nodeSnapshot(node, index)),
      links: document.topology.links.map((link) => ({
        id: link.id,
        sourceNode: link.a.node,
        sourceInterface: link.a.iface,
        targetNode: link.b.node,
        targetInterface: link.b.iface,
      })),
      wirelessAssociations: document.topology.nodes.flatMap((node) => {
        const device = built.getDevice(node.id);
        if (!(device instanceof WirelessEndHost)) return [];
        const status = device.wirelessStatus();
        if (
          status.state !== "associated"
          || !status.accessPointDeviceId
          || !status.ssid
          || !status.bssid
        ) return [];
        return [{
          id: `wireless:${node.id}:${status.accessPointDeviceId}`,
          stationDeviceId: node.id,
          accessPointDeviceId: status.accessPointDeviceId,
          ssid: status.ssid,
          bssid: status.bssid,
          state: status.state,
        }];
      }),
    };
  }

  private inspectDevice(deviceId: string): DeviceInspection {
    const built = this.requireBuiltLab();
    const device = built.getDevice(deviceId);
    if (!device) throw new SimulationWorkerError("unknown-device", `Unknown device '${deviceId}'`);
    const base = {
      deviceId,
      hostname: device.name,
      capabilities: [...device.profile.capabilities],
      arpEntries: [] as DeviceInspection["arpEntries"],
      macEntries: [] as DeviceInspection["macEntries"],
      routes: [] as DeviceInspection["routes"],
      vlans: [] as DeviceInspection["vlans"],
    };
    if (device instanceof Server) {
      return {
        ...base,
        type: "server",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
          mode: "routed" as const,
          ipAddress: iface === device.primary ? device.ip : undefined,
          prefixLength: iface === device.primary ? prefixLength(device.maskInt) : undefined,
        })),
        arpEntries: [...device.arpTable].map(([ipAddress, macAddress]) => ({ ipAddress, macAddress })),
        dhcp: {
          enabled: device.dhcpEnabled,
          state: device.dhcpState,
          bound: device.dhcpBound,
          lease: device.lease ? {
            ipAddress: device.lease.ip,
            gateway: device.lease.gateway,
            serverIp: device.lease.serverIp,
            leaseSeconds: device.lease.leaseSeconds,
          } : undefined,
        },
        services: device.listServices(),
        serviceRuntime: device.serviceRuntimeSnapshot(),
        transport: {
          udpSockets: device.transport.udp.inspect(),
          tcpConnections: device.transport.tcp.inspect(),
        },
        applications: applicationInspection(device),
        ipv6: hostIpv6Inspection(device),
      };
    }
    if (device instanceof TrafficGenerator) {
      return {
        ...base,
        type: "traffic-generator",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
          mode: "routed" as const,
          ipAddress: device.ip,
          prefixLength: prefixLength(device.maskInt),
        })),
        arpEntries: [...device.arpTable].map(([ipAddress, macAddress]) => ({ ipAddress, macAddress })),
        dhcp: {
          enabled: device.dhcpEnabled,
          state: device.dhcpState,
          bound: device.dhcpBound,
        },
        transport: {
          udpSockets: device.transport.udp.inspect(),
          tcpConnections: device.transport.tcp.inspect(),
        },
        applications: applicationInspection(device),
        ipv6: hostIpv6Inspection(device),
      };
    }
    if (device instanceof EndHost) {
      return {
        ...base,
        type: device.deviceType,
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
          mode: "routed" as const,
          ipAddress: device.ip,
          prefixLength: prefixLength(device.maskInt),
        })),
        arpEntries: [...device.arpTable].map(([ipAddress, macAddress]) => ({ ipAddress, macAddress })),
        dhcp: {
          enabled: device.dhcpEnabled,
          state: device.dhcpState,
          bound: device.dhcpBound,
          lease: device.lease ? {
            ipAddress: device.lease.ip,
            gateway: device.lease.gateway,
            serverIp: device.lease.serverIp,
            leaseSeconds: device.lease.leaseSeconds,
          } : undefined,
        },
        transport: {
          udpSockets: device.transport.udp.inspect(),
          tcpConnections: device.transport.tcp.inspect(),
        },
        applications: applicationInspection(device),
        ipv6: hostIpv6Inspection(device),
      };
    }
    if (device instanceof AccessPoint) {
      return {
        ...base,
        type: "access-point",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
        })),
      };
    }
    if (device instanceof WirelessRouter) {
      return {
        ...base,
        type: "wireless-router",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
        })),
      };
    }
    if (device instanceof L2Switch) {
      if (device instanceof Layer3Switch) {
        const routed = new Map(device.routedInterfaceSummaries().map((row) => [row.name, row]));
        return {
          ...base,
          type: "l3-switch",
          interfaces: device.portSummaries().map((row) => ({
            id: row.name,
            adminUp: row.adminUp,
            operationalUp: row.operUp,
            description: row.description,
            mode: device.isRoutedPort(row.name) ? "routed" as const : row.mode,
            vlan: !device.isRoutedPort(row.name) && row.mode === "access" ? row.accessVlan : undefined,
            nativeVlan: !device.isRoutedPort(row.name) && row.mode === "trunk" ? row.nativeVlan : undefined,
            allowedVlans: !device.isRoutedPort(row.name) && row.mode === "trunk" ? row.allowedVlans : undefined,
            ipAddress: routed.get(row.name)?.ip,
            prefixLength: routed.get(row.name)?.ip ? prefixLength(routed.get(row.name)!.maskInt) : undefined,
          })),
          macEntries: device.macAddressTable().map((row) => ({ vlan: row.vlan, macAddress: row.mac, interfaceId: row.port })),
          vlans: device.vlanBrief().map((row) => ({ id: row.id, name: row.name, interfaces: row.ports })),
          svis: device.sviSummaries().map((svi) => ({
            vlanId: svi.vlanId,
            interfaceId: svi.name,
            ipAddress: svi.ip,
            prefixLength: svi.ip ? prefixLength(svi.maskInt) : undefined,
            adminUp: svi.adminUp,
            operationalUp: svi.operUp,
            description: svi.description,
          })),
          routes: device.routingTable().map((row) => ({
            kind: row.kind,
            network: row.network,
            prefixLength: prefixLength(row.maskInt),
            nextHop: row.viaIp,
            interfaceId: row.egressName,
          })),
          arpEntries: [...device.arpTable].map(([ipAddress, macAddress]) => ({ ipAddress, macAddress })),
          ipRoutingEnabled: device.ipRoutingEnabled,
          ipv6: routedIpv6Inspection(device),
        };
      }
      return {
        ...base,
        type: "l2-switch",
        interfaces: device.portSummaries().map((row) => ({
          id: row.name,
          adminUp: row.adminUp,
          operationalUp: row.operUp,
          description: row.description,
          mode: row.mode,
          vlan: row.mode === "access" ? row.accessVlan : undefined,
          nativeVlan: row.nativeVlan,
          allowedVlans: row.allowedVlans,
        })),
        macEntries: device.macAddressTable().map((row) => ({
          vlan: row.vlan,
          macAddress: row.mac,
          interfaceId: row.port,
        })),
        vlans: device.vlanBrief().map((row) => ({ id: row.id, name: row.name, interfaces: row.ports })),
      };
    }
    if (device instanceof Hub) {
      return {
        ...base,
        type: "hub",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
        })),
        counters: { repeatedFrames: device.repeatedFrameCount, droppedFrames: device.droppedFrameCount },
      };
    }
    if (device instanceof EthernetBridge) {
      return {
        ...base,
        type: "bridge",
        interfaces: [...device.interfaces.values()].map((iface) => ({
          id: iface.name,
          adminUp: iface.adminUp,
          operationalUp: iface.operationalUp,
          description: iface.description,
        })),
        macEntries: device.macAddressTable().map((row) => ({ macAddress: row.mac, interfaceId: row.port })),
      };
    }
    if (device instanceof Router) {
      return {
        ...base,
        type: device.deviceType,
        interfaces: device.interfaceSummaries().map((row) => ({
          id: row.name,
          adminUp: row.adminUp,
          operationalUp: row.operUp,
          description: row.description,
          mode: "routed" as const,
          vlan: row.vlan,
          ipAddress: row.ip,
          prefixLength: prefixLength(row.maskInt),
        })),
        arpEntries: [...device.arpTable].map(([ipAddress, macAddress]) => ({ ipAddress, macAddress })),
        routes: device.routingTable().map((row) => ({
          kind: row.kind,
          network: row.network,
          prefixLength: prefixLength(row.maskInt),
          nextHop: row.viaIp,
          interfaceId: row.egressName,
        })),
        dhcp: {
          pools: device.dhcpPoolConfigurations().map((pool) => ({
            id: pool.id,
            network: pool.network,
            prefixLength: prefixLength(pool.maskInt),
            gateway: pool.gateway,
            rangeStart: pool.rangeStart,
            rangeEnd: pool.rangeEnd,
            leaseSeconds: pool.leaseSeconds,
          })),
        },
        ipv6: routedIpv6Inspection(device),
      };
    }
    throw new SimulationWorkerError("unsupported-device", `Unsupported device '${deviceId}'`);
  }

  private requireHost(deviceId: string): EndHost {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!(device instanceof EndHost)) {
      throw new SimulationWorkerError("not-an-end-host", `Device '${deviceId}' does not support host IP configuration`);
    }
    return device;
  }

  private hostIpConfiguration(deviceId: string): HostIpConfiguration {
    const host = this.requireHost(deviceId);
    const configuration = host.configurationSnapshot();
    return {
      mode: configuration.dhcpEnabled ? "dhcp" : "static",
      address: configuration.ip,
      prefixLength: prefixLength(configuration.maskInt),
      defaultGateway: configuration.gateway,
      dnsServer: configuration.dnsServer,
    };
  }

  private hostNetworkStatus(deviceId: string): HostNetworkStatus {
    const host = this.requireHost(deviceId);
    const warnings = this.hostWarnings().filter((warning) => warning.deviceIds.includes(deviceId));
    return {
      deviceId,
      configuration: this.hostIpConfiguration(deviceId),
      runtime: {
        address: host.ip,
        prefixLength: prefixLength(host.maskInt),
        defaultGateway: host.gateway,
        dnsServer: host.applications.dnsServer,
        dhcpState: host.dhcpState,
        dhcpBound: host.dhcpBound,
        lease: host.lease ? {
          address: host.lease.ip,
          gateway: host.lease.gateway,
          serverAddress: host.lease.serverIp,
          leaseSeconds: host.lease.leaseSeconds,
        } : undefined,
      },
      warnings,
      guidance: host.dhcpEnabled && host.dhcpState === "failed"
        ? "No DHCP offer received.\n\nAn L2 switch forwards Ethernet frames but does not assign IP addresses.\n\nConfigure a static address or add a Router/Server with an enabled DHCP service."
        : undefined,
    };
  }

  private hostIpv6Configuration(deviceId: string): HostIpv6Config {
    const configuration = this.requireHost(deviceId).ipv6ConfigurationSnapshot();
    return {
      mode: configuration.mode,
      address: configuration.staticAddress,
      prefixLength: configuration.prefixLength,
      defaultRouter: configuration.defaultRouter,
      dnsServer: configuration.dnsServer,
    };
  }

  private hostIpv6NetworkStatus(deviceId: string): HostIpv6NetworkStatus {
    const host = this.requireHost(deviceId);
    const addresses = host.ipv6AddressSummaries();
    return {
      deviceId,
      configuration: this.hostIpv6Configuration(deviceId),
      runtime: {
        mode: host.ipv6Mode,
        linkLocal: addresses.find((entry) => entry.source === "link-local")?.address,
        addresses,
        defaultRouter: host.ipv6DefaultRouter,
        dnsServer: host.ipv6DnsServer,
        dhcpv6State: host.dhcpv6State,
        lease: host.dhcpv6Lease ? {
          address: host.dhcpv6Lease.address,
          prefixLength: host.dhcpv6Lease.prefixLength,
          dnsServers: host.dhcpv6Lease.dnsServers,
        } : undefined,
        neighbors: host.ipv6NeighborEntries().map((entry) => ({
          address: entry.address,
          macAddress: entry.mac,
          state: entry.state,
        })),
        problems: [...host.ipv6Problems],
      },
    };
  }

  private setHostIpv6StaticConfiguration(deviceId: string, input: unknown): HostIpv6NetworkStatus {
    const parsed = HostIpv6ConfigSchema.safeParse(input);
    if (!parsed.success || parsed.data.mode !== "static" || !parsed.data.address || parsed.data.prefixLength === undefined) {
      throw new SimulationWorkerError(
        "invalid-host-ipv6-configuration",
        parsed.success
          ? "Static IPv6 address and prefix length are required"
          : parsed.error.issues[0]?.message ?? "Invalid host IPv6 configuration",
      );
    }
    const host = this.requireHost(deviceId);
    host.configureIpv6Static(
      parsed.data.address,
      parsed.data.prefixLength,
      parsed.data.defaultRouter,
      parsed.data.dnsServer,
    );
    this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.flushTrace();
    return this.hostIpv6NetworkStatus(deviceId);
  }

  private setHostIpv6Mode(
    deviceId: string,
    modeInput: unknown,
    startImmediately: unknown,
  ): HostIpv6NetworkStatus {
    if ((modeInput !== "slaac" && modeInput !== "dhcpv6") || typeof startImmediately !== "boolean") {
      throw new SimulationWorkerError(
        "invalid-request",
        "mode must be 'slaac' or 'dhcpv6' and startImmediately must be boolean",
      );
    }
    const host = this.requireHost(deviceId);
    host.setIpv6Mode(modeInput);
    if (startImmediately) {
      this.requireBuiltLab().engine.runUntilIdle();
    }
    this.serialize();
    this.emitStateChanged();
    this.flushTrace();
    return this.hostIpv6NetworkStatus(deviceId);
  }

  private renewHostDhcpv6(deviceId: string): HostIpv6NetworkStatus {
    const host = this.requireHost(deviceId);
    host.renewDhcpv6();
    this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.flushTrace();
    return this.hostIpv6NetworkStatus(deviceId);
  }

  private releaseHostDhcpv6(deviceId: string): HostIpv6NetworkStatus {
    this.requireHost(deviceId).releaseDhcpv6();
    this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.flushTrace();
    return this.hostIpv6NetworkStatus(deviceId);
  }

  private setHostStaticConfiguration(deviceId: string, input: unknown): HostNetworkStatus {
    const parsed = HostStaticConfigurationSchema.safeParse(input);
    if (!parsed.success) {
      throw new SimulationWorkerError("invalid-host-ip-configuration", parsed.error.issues[0]?.message ?? "Invalid host IP configuration");
    }
    this.requireHost(deviceId).setStaticConfiguration(parsed.data);
    this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.emitHostWarnings();
    this.flushTrace();
    return this.hostNetworkStatus(deviceId);
  }

  private setHostDhcpMode(deviceId: string, startImmediately: unknown): HostNetworkStatus {
    if (typeof startImmediately !== "boolean") {
      throw new SimulationWorkerError("invalid-request", "startImmediately must be a boolean");
    }
    const host = this.requireHost(deviceId);
    if (startImmediately) {
      host.requestDhcp();
      this.requireBuiltLab().engine.runUntilIdle();
    } else {
      host.setDhcpEnabled(true);
    }
    this.serialize();
    this.emitStateChanged();
    this.emitHostWarnings();
    this.flushTrace();
    return this.hostNetworkStatus(deviceId);
  }

  private renewHostDhcp(deviceId: string): HostNetworkStatus {
    const host = this.requireHost(deviceId);
    host.requestDhcp();
    this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.emitHostWarnings();
    this.flushTrace();
    return this.hostNetworkStatus(deviceId);
  }

  private releaseHostDhcp(deviceId: string): HostNetworkStatus {
    this.requireHost(deviceId).releaseDhcp();
    this.serialize();
    this.emitStateChanged();
    this.emitHostWarnings();
    this.flushTrace();
    return this.hostNetworkStatus(deviceId);
  }

  private hostWarnings() {
    const document = this.document;
    if (!document) return [];
    const records = [...this.requireBuiltLab().devices.values()]
      .filter((device): device is EndHost => device instanceof EndHost && device.ip !== undefined)
      .map((device) => ({ deviceId: device.id, address: device.ip! }));
    const warnings: HostNetworkWarning[] = findDuplicateHostAddresses(document, records);
    for (const device of this.requireBuiltLab().devices.values()) {
      if (device instanceof WirelessEndHost) {
        const status = device.wirelessStatus();
        const message = wirelessFailureMessage(status.failureReason);
        if (message) {
          warnings.push({
            code: wirelessFailureCode(status.failureReason),
            message,
            deviceIds: [device.id],
          });
        }
        if (status.state === "associated" && device.dhcpEnabled && device.dhcpState === "failed") {
          warnings.push({
            code: "wireless-no-dhcp",
            message: "No DHCP server responded after wireless association.",
            deviceIds: [device.id],
          });
        }
      }
      if (
        device instanceof AccessPoint
        && device.associatedClients().length > 0
        && !device.getInterface("eth0")?.operationalUp
      ) {
        warnings.push({
          code: "access-point-no-uplink",
          message: "Access Point has associated clients but no operational wired uplink.",
          deviceIds: [device.id],
        });
      }
    }
    return warnings;
  }

  private emitHostWarnings(): void {
    this.emit({ type: "RUNTIME_WARNING", warnings: this.hostWarnings() });
  }

  private nodeSnapshot(node: NodeSpec, index: number): LabUiNode {
    const built = this.requireBuiltLab();
    const device = built.getDevice(node.id)!;
    const routerRows = device instanceof Router
      ? new Map(device.interfaceSummaries().map((row) => [row.name, row]))
      : undefined;
    const switchRows = device instanceof L2Switch
      ? new Map(device.portSummaries().map((row) => [row.name, row]))
      : undefined;
    const layer3Rows = device instanceof Layer3Switch
      ? new Map(device.routedInterfaceSummaries().map((row) => [row.name, row]))
      : undefined;
    const interfaces: LabUiInterface[] = node.interfaces.map((spec) => {
      const iface = device.getInterface(spec.id)!;
      const router = routerRows?.get(spec.id);
      const sw = switchRows?.get(spec.id);
      return {
        id: spec.id,
        adminUp: iface.adminUp,
        operationalUp: iface.operationalUp,
        ipAddress: device instanceof EndHost && iface === device.primary ? device.ip : router?.ip ?? layer3Rows?.get(spec.id)?.ip,
        mode: device instanceof Layer3Switch && device.isRoutedPort(spec.id) ? "routed" : sw?.mode,
      };
    });
    return {
      id: node.id,
      type: node.kind,
      hostname: device.name,
      position: node.position ?? { x: (index % 3) * 240, y: Math.floor(index / 3) * 180 },
      status: interfaces.some((iface) => iface.operationalUp) ? "up" : "down",
      interfaces,
      serviceBadges: device instanceof Server
        ? device.listServices().filter((service) => service.state === "listening").map((service) => service.type.toUpperCase())
        : undefined,
    };
  }

  private requireWirelessStation(deviceId: string): WirelessEndHost {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!(device instanceof WirelessEndHost)) {
      throw new SimulationWorkerError(
        "wireless-station-required",
        `Device '${deviceId}' is not a wireless station`,
      );
    }
    return device;
  }

  private requireAccessPointDevice(deviceId: string): AccessPoint | WirelessRouter {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (!(device instanceof AccessPoint) && !(device instanceof WirelessRouter)) {
      throw new SimulationWorkerError(
        "access-point-required",
        `Device '${deviceId}' is not an Access Point or Wireless Router`,
      );
    }
    return device;
  }

  private runWirelessAction(): void {
    if (this.executionMode === "auto") this.requireBuiltLab().engine.runUntilIdle();
    this.serialize();
    this.emitStateChanged();
    this.emitHostWarnings();
    this.flushTrace();
  }

  private wirelessStationView(deviceId: string): WirelessStationView {
    const station = this.requireWirelessStation(deviceId);
    return {
      deviceId,
      configuration: station.wirelessConfigurationSnapshot(),
      status: station.wirelessStatus(),
      networks: station.wirelessScanResults(),
      document: this.serialize(),
    };
  }

  private scanWirelessNetworks(deviceId: string, explicitSsid: unknown): WirelessStationView {
    if (explicitSsid !== undefined && (typeof explicitSsid !== "string" || explicitSsid.length > 32)) {
      throw new SimulationWorkerError("invalid-ssid", "Explicit SSID must be a string of at most 32 characters");
    }
    this.requireWirelessStation(deviceId).scanWirelessNetworks(explicitSsid as string | undefined);
    this.runWirelessAction();
    return this.wirelessStationView(deviceId);
  }

  private connectWirelessNetwork(
    deviceId: string,
    input: Record<string, unknown>,
  ): WirelessStationView {
    const station = this.requireWirelessStation(deviceId);
    const ssid = requireString(input, "ssid");
    if (ssid.length === 0 || ssid.length > 32) {
      throw new SimulationWorkerError("invalid-ssid", "SSID must contain between 1 and 32 characters");
    }
    const securityMode = input.securityMode;
    if (securityMode !== "open" && securityMode !== "wpa2-personal") {
      throw new SimulationWorkerError("invalid-wireless-security", "Wireless security must be open or wpa2-personal");
    }
    const preferredBssid = input.preferredBssid;
    if (preferredBssid !== undefined && typeof preferredBssid !== "string") {
      throw new SimulationWorkerError("invalid-bssid", "Preferred BSSID must be a string");
    }
    const saveNetwork = input.saveNetwork;
    if (typeof saveNetwork !== "boolean") {
      throw new SimulationWorkerError("invalid-request", "saveNetwork must be a boolean");
    }
    const verifier = input.credentialVerifier === undefined
      ? undefined
      : PasswordVerifierSchema.safeParse(input.credentialVerifier);
    if (verifier && !verifier.success) {
      throw new SimulationWorkerError("invalid-wireless-credential", "Wireless credential verifier is invalid");
    }
    if (securityMode === "wpa2-personal" && !verifier?.success) {
      throw new SimulationWorkerError(
        "wireless-credential-required",
        "A configured WPA2 security key is required",
      );
    }
    if (saveNetwork) {
      station.saveWirelessNetwork({
        id: `saved:${ssid}`,
        ssid,
        securityMode,
        credentialVerifier: verifier?.success ? verifier.data : undefined,
        autoConnect: true,
        preferredBssid: preferredBssid as string | undefined,
      });
      station.setWirelessPreferences({
        autoConnect: true,
        preferredSsid: ssid,
        preferredBssid: preferredBssid as string | undefined,
      });
    }
    station.connectWireless({
      ssid,
      preferredBssid: preferredBssid as Mac | undefined,
      securityMode,
      credentialFingerprint: verifier?.success ? verifier.data.hashBase64 : undefined,
    });
    this.runWirelessAction();
    return this.wirelessStationView(deviceId);
  }

  private disconnectWirelessNetwork(deviceId: string): WirelessStationView {
    this.requireWirelessStation(deviceId).disconnectWireless();
    this.runWirelessAction();
    return this.wirelessStationView(deviceId);
  }

  private forgetWirelessNetwork(deviceId: string, profileId: string): WirelessStationView {
    this.requireWirelessStation(deviceId).forgetWirelessNetwork(profileId);
    this.runWirelessAction();
    return this.wirelessStationView(deviceId);
  }

  private wirelessAccessPointView(deviceId: string): WirelessAccessPointView {
    const accessPoint = this.requireAccessPointDevice(deviceId);
    const configuration = accessPoint instanceof AccessPoint
      ? accessPoint.configurationSnapshot().accessPoint
      : accessPoint.configurationSnapshot().accessPoint;
    const clients = accessPoint.associatedClients().map((client) => {
      const device = this.requireBuiltLab().getDevice(client.deviceId);
      const host = device instanceof EndHost ? device : undefined;
      return {
        deviceId: client.deviceId,
        hostname: device?.name ?? client.deviceId,
        macAddress: client.macAddress,
        associatedAtNs: client.associatedAtNs,
        ipv4Address: host?.ip,
        ipv6Addresses: host?.ipv6AddressSummaries().map((entry) => entry.address) ?? [],
        security: configuration.security.mode,
      };
    });
    return {
      deviceId,
      configuration,
      clients,
      document: this.serialize(),
    };
  }

  private configureAccessPoint(deviceId: string, input: unknown): WirelessAccessPointView {
    const parsed = WirelessAccessPointConfigurationSchema.safeParse(input);
    if (!parsed.success) {
      throw new SimulationWorkerError(
        "invalid-access-point-configuration",
        parsed.error.issues[0]?.message ?? "Access Point configuration is invalid",
      );
    }
    this.requireAccessPointDevice(deviceId).updateWireless(parsed.data);
    this.runWirelessAction();
    return this.wirelessAccessPointView(deviceId);
  }

  private setWirelessSecurity(deviceId: string, input: unknown): WirelessAccessPointView {
    const parsed = WirelessSecurityConfigurationSchema.safeParse(input);
    if (!parsed.success) {
      throw new SimulationWorkerError("invalid-wireless-security", "Wireless security configuration is invalid");
    }
    const accessPoint = this.requireAccessPointDevice(deviceId);
    const current = accessPoint instanceof AccessPoint
      ? accessPoint.configurationSnapshot().accessPoint
      : accessPoint.configurationSnapshot().accessPoint;
    accessPoint.updateWireless({ ...current, security: parsed.data });
    this.runWirelessAction();
    return this.wirelessAccessPointView(deviceId);
  }

  private disconnectAccessPointClient(
    deviceId: string,
    stationDeviceId: string,
  ): WirelessAccessPointView {
    const accessPoint = this.requireAccessPointDevice(deviceId);
    if (!accessPoint.disconnectClient(stationDeviceId)) {
      throw new SimulationWorkerError(
        "wireless-client-not-associated",
        `Device '${stationDeviceId}' is not associated with '${deviceId}'`,
      );
    }
    this.runWirelessAction();
    return this.wirelessAccessPointView(deviceId);
  }

  private serverServices(deviceId: string): ServerServicesView {
    const server = this.requireServer(deviceId);
    return {
      deviceId,
      configurations: server.services.configurations(),
      services: server.listServices(),
    };
  }

  private configureServerService(deviceId: string, input: unknown): ServerServicesView {
    const parsed = ServerServiceConfigSchema.safeParse(input);
    if (!parsed.success) {
      throw new SimulationWorkerError("invalid-service-configuration", parsed.error.issues[0]?.message ?? "Invalid service configuration");
    }
    const server = this.requireServer(deviceId);
    server.configureService(parsed.data);
    this.requireBuiltLab().engine.runUntilIdle();
    this.emitStateChanged();
    this.flushTrace();
    return this.serverServices(deviceId);
  }

  private setServerServiceEnabled(deviceId: string, serviceId: string, enabled: boolean): ServerServicesView {
    const server = this.requireServer(deviceId);
    if (enabled) server.enableService(serviceId);
    else server.disableService(serviceId);
    this.requireBuiltLab().engine.runUntilIdle();
    this.emitStateChanged();
    this.flushTrace();
    return this.serverServices(deviceId);
  }

  private requireServer(deviceId: string): Server {
    const server = this.requireBuiltLab().getServer(deviceId);
    if (!server) throw new SimulationWorkerError("not-a-server", `Device '${deviceId}' is not a server`);
    return server;
  }

  // --- M10.4 control protocols -------------------------------------------

  private requireSwitch(deviceId: string): L2Switch {
    const device = this.requireBuiltLab().getSwitch(deviceId);
    if (!device) {
      throw new SimulationWorkerError("not-a-switch", `Device '${deviceId}' does not run layer-2 control protocols`);
    }
    return device;
  }

  private requireOspf(deviceId: string): Router | Layer3Switch {
    const device = this.requireBuiltLab().getDevice(deviceId);
    if (device instanceof Layer3Switch) return device;
    if (device instanceof Router && device.deviceType === "router") return device;
    throw new SimulationWorkerError("ospf-not-supported", `Device '${deviceId}' cannot run an OSPF process`);
  }

  private ospfv3State(deviceId: string): Ospfv3View {
    const ospfv3 = this.requireOspf(deviceId).ospfv3;
    return {
      deviceId,
      overview: ospfv3.overview(),
      neighbors: ospfv3.neighborSummaries(),
      database: ospfv3.database(),
      routes: ospfv3.routeTable(),
    };
  }

  private requireDiscovery(deviceId: string) {
    const device = this.requireBuiltLab().getDevice(deviceId) as { discovery?: Router["discovery"] } | undefined;
    if (!device?.discovery) {
      throw new SimulationWorkerError("discovery-not-supported", `Device '${deviceId}' has no neighbour discovery`);
    }
    return device.discovery;
  }

  private spanningTreeState(deviceId: string) {
    return { deviceId, summary: this.requireSwitch(deviceId).spanningTreeSummary() };
  }

  private discoveryNeighbors(deviceId: string) {
    const discovery = this.requireDiscovery(deviceId);
    return {
      deviceId,
      neighbors: discovery.neighborTable(),
      interfaces: discovery.interfaceStatuses(),
      cdpRunning: discovery.cdpRunning,
      lldpRunning: discovery.lldpRunning,
    };
  }

  /**
   * Let the protocols reconverge after a bounded runtime action. In Step mode
   * the events stay queued so the learner can walk through them instead.
   */
  private runProtocolConvergence(): void {
    if (this.executionMode === "auto") this.runUntilIdle();
    else {
      this.emitStateChanged();
      this.flushTrace();
    }
  }

  private flushTrace(): void {
    const built = this.requireBuiltLab();
    const entries = built.engine.traceLog.slice(this.traceCursor);
    if (entries.length === 0) return;
    const events: SimulationTraceEvent[] = entries.map((entry, index) => {
      const interfaceValue = entry.detail?.iface
        ?? entry.detail?.port
        ?? entry.detail?.egress
        ?? entry.detail?.ingress
        ?? entry.detail?.interface;
      return {
        sequence: this.traceCursor + index + 1,
        virtualTime: entry.time,
        type: entry.type,
        deviceId: entry.device,
        interfaceId: typeof interfaceValue === "string" ? interfaceValue : undefined,
        description: describeTrace(entry),
        detail: entry.detail,
      };
    });
    this.traceCursor += entries.length;
    this.emit({ type: "TRACE_BATCH", events });
  }

  private emitStateChanged(): void {
    this.emit({ type: "STATE_CHANGED", snapshot: this.snapshot() });
  }

  private emitCompletedCliOperations(): void {
    // Remote devices answer first: a queued Telnet/SSH command produces its
    // output on the managed device before the originating terminal renders it.
    this.builtLab?.management.completeDeferredOperations();
    for (const [sessionId, entry] of this.sessions) {
      const output = entry.session.completePendingOperation();
      if (output === undefined) continue;
      this.emit({ type: "CLI_OUTPUT", ...this.cliResult(sessionId, entry, output), deferred: false });
    }
  }

  private requireRunnable(): BuiltLab {
    if (this.engineState === "paused") throw new SimulationWorkerError("runtime-paused", "Simulation is paused");
    return this.requireBuiltLab();
  }

  private requireBuiltLab(): BuiltLab {
    if (!this.builtLab) throw new SimulationWorkerError("lab-not-initialized", "Initialize a lab first");
    return this.builtLab;
  }
}

function isSecurityConfiguration(config: DeviceConfig): config is SecurityDeviceConfiguration {
  return config.kind === "router"
    || config.kind === "l3-switch"
    || config.kind === "firewall"
    || config.kind === "cloud"
    || config.kind === "traffic-generator";
}

function replaceAclConfiguration(
  device: Router | Layer3Switch,
  config: Extract<SecurityDeviceConfiguration, { kind: "router" | "l3-switch" | "firewall" | "cloud" }>,
): void {
  for (const acl of device.aclConfigurations()) device.removeAcl(acl.id);
  for (const acl of config.acls) device.defineAcl(acl);
  for (const binding of config.aclBindings) {
    device.applyAcl(binding.interfaceName, binding.direction, binding.aclId);
  }
}

function replaceSecurityConfiguration(device: Device, config: SecurityDeviceConfiguration): void {
  if (device instanceof TrafficGenerator && config.kind === "traffic-generator") {
    for (const flow of device.flowConfigurations()) device.removeFlow(flow.id);
    device.resetFlowRuntime();
    for (const flow of config.flows) device.configureFlow(flow);
    return;
  }
  if (device instanceof Layer3Switch && config.kind === "l3-switch") {
    replaceAclConfiguration(device, config);
    return;
  }
  if (!(device instanceof Router)
    || (config.kind !== "router" && config.kind !== "firewall" && config.kind !== "cloud")) {
    throw new SimulationWorkerError("security-not-supported", `Device '${device.id}' has no routed security configuration`);
  }

  replaceAclConfiguration(device, config);
  for (const rule of device.natRuleConfigurations()) device.removeNatRule(rule.id);
  for (const pool of device.natPoolConfigurations()) device.removeNatPool(pool.id);
  for (const iface of device.interfaceSummaries()) device.setNatRole(iface.name, undefined);
  for (const pool of config.natPools) device.defineNatPool(pool);
  for (const role of config.natInterfaceRoles) device.setNatRole(role.interfaceName, role.role);
  for (const rule of config.natRules) device.defineNatRule(rule);

  if (device instanceof Firewall && config.kind === "firewall") {
    for (const policy of device.policyConfigurations()) device.removePolicy(policy.id);
    for (const zone of device.zoneConfigurations()) device.removeZone(zone.interfaceName);
    device.resetSecurityRuntime();
    for (const zone of config.zones) device.setZone(zone.interfaceName, zone.zone);
    for (const policy of config.firewallPolicies) device.definePolicy(policy);
    device.setDefaultPolicy(config.defaultPolicy);
  }
  if (device instanceof IspCloud && config.kind === "cloud") {
    device.clearImpairments();
    for (const impairment of config.impairments) device.configureImpairment(impairment);
  }
}

function prefixLength(mask: number): number {
  let value = mask >>> 0;
  let count = 0;
  while (value !== 0) {
    count += value & 1;
    value >>>= 1;
  }
  return count;
}

function applicationInspection(device: EndHost): NonNullable<DeviceInspection["applications"]> {
  return {
    dnsServer: device.applications.dnsServer,
    dnsResults: device.applications.dnsResults.map((result) => ({ ...result })),
    httpResults: device.applications.httpResults.map((result) => ({ ...result, headers: result.headers ? { ...result.headers } : undefined })),
    tftpResults: device.applications.tftpResults.map((result) => ({ ...result })),
    downloadedFiles: [...device.applications.downloadedFiles].map(([filename, content]) => ({ filename, content })),
    ntpResults: device.applications.ntpResults.map((result) => ({ ...result })),
    clockOffsetNs: device.applications.clockOffsetNs,
    clockTimeNs: device.applications.clockNow(),
  };
}

function hostIpv6Inspection(device: EndHost): NonNullable<DeviceInspection["ipv6"]> {
  return {
    addresses: device.ipv6AddressSummaries().map((address) => ({
      interfaceId: device.primary.name,
      ...address,
    })),
    neighbors: device.ipv6NeighborEntries().map((entry) => ({
      interfaceId: device.primary.name,
      address: entry.address,
      macAddress: entry.mac,
      state: entry.state,
    })),
    routes: [],
    problems: [...device.ipv6Problems],
  };
}

function routedIpv6Inspection(device: Router | Layer3Switch): NonNullable<DeviceInspection["ipv6"]> {
  return {
    forwardingEnabled: device.ipv6UnicastRoutingEnabled,
    addresses: device.ipv6InterfaceSummaries().flatMap((row) =>
      row.addresses.map((address) => ({ interfaceId: row.name, ...address }))),
    neighbors: device.ipv6NeighborEntries().map((entry) => ({
      interfaceId: entry.interfaceName,
      address: entry.address,
      macAddress: entry.mac,
      state: entry.state,
    })),
    routes: device.ipv6RoutingTable().map((route) => ({
      kind: route.kind,
      network: route.network,
      prefixLength: route.prefixLength,
      nextHop: route.viaIp,
      interfaceId: route.egressName,
      administrativeDistance: route.administrativeDistance,
      metric: route.metric,
    })),
    problems: [...device.ipv6Problems, ...device.ospfv3.problemSummaries()],
  };
}

export function createSimulationWorkerRuntime(emit?: (message: SimWorkerOutboundMessage) => void): SimulationWorkerRuntime {
  return new SimulationWorkerRuntime(emit);
}

export function handleSimulationWorkerRequest(
  runtime: SimulationWorkerRuntime,
  request: SimWorkerRequest,
): SimWorkerResponse {
  return runtime.handleRequest(request);
}
