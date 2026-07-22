import { createCliSession, type CliSession } from "@sim/cli-engine";
import type { LabDocument, LabMetadata, NodeSpec } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  migrateLabDocument,
  parseLabDocument,
  serializeLabDocument,
  type BuiltLab,
} from "@sim/lab-format";
import {
  EndHost,
  EthernetBridge,
  Hub,
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  Server,
  type TraceEntry,
} from "@sim/sim-core";
import { SimulationWorkerError, serializeWorkerError } from "./errors";
import type {
  EngineUiState,
  DeviceInspection,
  LabUiInterface,
  LabUiNode,
  LabUiSnapshot,
  SimWorkerEvent,
  SimWorkerOutboundMessage,
  SimWorkerPayload,
  SimWorkerRequest,
  SimWorkerResponse,
  SimulationRunResult,
  SimulationTraceEvent,
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

export class SimulationWorkerRuntime {
  private builtLab: BuiltLab | undefined;
  private document: LabDocument | undefined;
  private metadata: LabMetadata | undefined;
  private readonly sessions = new Map<string, CliSessionEntry>();
  private traceCursor = 0;
  private engineState: EngineUiState = "idle";

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
        return this.executeCli(requireString(request, "sessionId"), requireString(request, "deviceId"), requireString(request, "input"));
      case "CLOSE_CLI_SESSION":
        return { closed: this.sessions.delete(requireString(request, "sessionId")) };
      case "RUN_UNTIL_IDLE":
        return this.runUntilIdle();
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
    this.metadata = { id: canonical.id, title: canonical.title, description: canonical.description };
    this.rebuildEngine(canonical);
    const snapshot = this.snapshot();
    this.emit({ type: isInitial ? "LAB_READY" : "STATE_CHANGED", snapshot });
    this.flushTrace();
    return snapshot;
  }

  private rebuildEngine(document: LabDocument): void {
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
    this.builtLab.engine.runUntilIdle();
  }

  private executeCli(sessionId: string, deviceId: string, input: string) {
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
    const entry = existing ?? { deviceId, session: createCliSession(device, built.engine) };
    this.sessions.set(sessionId, entry);
    const output = entry.session.execute(input);
    const result = {
      sessionId,
      deviceId,
      output,
      prompt: entry.session.prompt(),
      mode: entry.session.mode,
    };
    this.emit({ type: "CLI_OUTPUT", ...result });
    this.emitStateChanged();
    this.flushTrace();
    return result;
  }

  private runUntilIdle(): SimulationRunResult {
    const built = this.requireRunnable();
    this.engineState = "running";
    const processedEvents = built.engine.runUntilIdle();
    this.engineState = "idle";
    const snapshot = this.snapshot();
    this.emit({ type: "STATE_CHANGED", snapshot });
    this.flushTrace();
    return { processedEvents, virtualTime: built.engine.now(), snapshot };
  }

  private advanceTime(milliseconds: unknown): SimulationRunResult {
    if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new SimulationWorkerError("invalid-time-step", "milliseconds must be a finite non-negative number");
    }
    const built = this.requireRunnable();
    this.engineState = "running";
    const target = built.engine.now() + Math.round(milliseconds * 1_000_000);
    const processedEvents = built.engine.advanceTo(target);
    this.engineState = "idle";
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

  private snapshot(): LabUiSnapshot {
    const built = this.requireBuiltLab();
    const document = this.document;
    if (!document) throw new SimulationWorkerError("lab-not-initialized", "Lab document is unavailable");
    return {
      labId: document.id,
      title: document.title,
      engineState: this.engineState,
      virtualTime: built.engine.now(),
      nodes: document.topology.nodes.map((node, index) => this.nodeSnapshot(node, index)),
      links: document.topology.links.map((link) => ({
        id: link.id,
        sourceNode: link.a.node,
        sourceInterface: link.a.iface,
        targetNode: link.b.node,
        targetInterface: link.b.iface,
      })),
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
        services: [],
      };
    }
    if (device instanceof Pc) {
      return {
        ...base,
        type: "pc",
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
        type: "router",
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
      };
    }
    throw new SimulationWorkerError("unsupported-device", `Unsupported device '${deviceId}'`);
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
    };
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

  private requireRunnable(): BuiltLab {
    if (this.engineState === "paused") throw new SimulationWorkerError("runtime-paused", "Simulation is paused");
    return this.requireBuiltLab();
  }

  private requireBuiltLab(): BuiltLab {
    if (!this.builtLab) throw new SimulationWorkerError("lab-not-initialized", "Initialize a lab first");
    return this.builtLab;
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

export function createSimulationWorkerRuntime(emit?: (message: SimWorkerOutboundMessage) => void): SimulationWorkerRuntime {
  return new SimulationWorkerRuntime(emit);
}

export function handleSimulationWorkerRequest(
  runtime: SimulationWorkerRuntime,
  request: SimWorkerRequest,
): SimWorkerResponse {
  return runtime.handleRequest(request);
}
