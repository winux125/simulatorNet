import {
  ServerServiceConfigSchema,
  type DnsServiceConfig,
  type HttpServiceConfig,
  type NtpServiceConfig,
  type ServerServiceConfig,
  type SyslogServiceConfig,
  type TftpServiceConfig,
} from "@sim/contracts";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { TcpConnection } from "../transport/tcp";
import type { HostTransportStack } from "../transport/host-transport";
import type { Ipv4 } from "../util/ipv4";
import {
  DEFAULT_SERVICE_LIMITS,
  SERVICE_REQUEST_TIMEOUT_NS,
  SERVICE_START_DELAY_NS,
  TFTP_BLOCK_SIZE,
  type ServiceLimits,
} from "./limits";
import type { DnsMessage, HttpMessage, NtpMessage, SyslogMessage, TftpMessage } from "./messages";
import { normalizeDnsName, normalizeHttpPath, normalizeTftpFilename, stringByteLength } from "./normalize";

export type ServiceLifecycleState = "disabled" | "starting" | "listening" | "error";

export interface ServerServiceSummary {
  readonly id: string;
  readonly type: ServerServiceConfig["type"];
  readonly enabled: boolean;
  readonly state: ServiceLifecycleState;
  readonly listeningPort?: number;
  readonly error?: string;
}

export interface SyslogEntry {
  readonly sequence: number;
  readonly receivedAtNs: number;
  readonly sourceAddress: Ipv4;
  readonly source: string;
  readonly facility: string;
  readonly severity: SyslogMessage["severity"];
  readonly timestampNs: number;
  readonly message: string;
}

export interface ServerServiceRuntimeSnapshot {
  readonly services: ServerServiceSummary[];
  readonly dns: { readonly queries: number };
  readonly http: { readonly requests: number };
  readonly tftp: { readonly activeTransfers: number; readonly completedTransfers: number };
  readonly ntp: { readonly queries: number };
  readonly syslog: { readonly entries: SyslogEntry[] };
}

interface ServiceState {
  state: ServiceLifecycleState;
  generation: number;
  error?: string;
}

interface TftpTransfer {
  readonly key: string;
  readonly service: TftpServiceConfig;
  readonly destinationAddress: Ipv4;
  readonly destinationPort: number;
  readonly transferId: number;
  readonly blocks: string[];
  blockIndex: number;
  retries: number;
  generation: number;
}

interface ServerServiceAdapter {
  readonly deviceId: string;
  readonly hostname: () => string;
  readonly engine: () => SimulationEngine;
  readonly localAddress: () => Ipv4 | undefined;
  readonly transport: HostTransportStack;
}

/** Persistent service configuration plus transient deterministic service runtime. */
export class ServerServiceRegistry {
  private readonly configs = new Map<string, ServerServiceConfig>();
  private readonly states = new Map<string, ServiceState>();
  private readonly tftpTransfers = new Map<string, TftpTransfer>();
  private dnsQueries = 0;
  private httpRequests = 0;
  private completedTftpTransfers = 0;
  private ntpQueries = 0;
  private syslogSequence = 0;
  private readonly syslogEntries: SyslogEntry[] = [];
  private runtimeGeneration = 0;

  constructor(
    private readonly host: ServerServiceAdapter,
    private readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {}

  configureAll(configurations: readonly ServerServiceConfig[]): void {
    if (configurations.length > this.limits.maximumServicesPerServer) {
      throw new Error(`Server service limit exceeded on ${this.host.deviceId}`);
    }
    const ids = new Set<string>();
    for (const configuration of configurations) {
      if (ids.has(configuration.id)) throw new Error(`Duplicate server service id '${configuration.id}'`);
      ids.add(configuration.id);
    }
    for (const id of [...this.configs.keys()]) this.remove(id);
    for (const configuration of configurations) this.configure(configuration);
  }

  configure(input: ServerServiceConfig): void {
    const config = normalizeServiceConfiguration(ServerServiceConfigSchema.parse(input), this.limits);
    const prior = this.configs.get(config.id);
    if (!prior && this.configs.size >= this.limits.maximumServicesPerServer) {
      throw new Error(`Server service limit exceeded on ${this.host.deviceId}`);
    }
    if (prior) this.stop(prior);
    this.configs.set(config.id, config);
    const state = this.states.get(config.id) ?? { state: "disabled", generation: 0 };
    state.generation++;
    state.error = undefined;
    state.state = config.enabled ? "starting" : "disabled";
    this.states.set(config.id, state);
    this.trace("service-state-changed", { serviceId: config.id, serviceType: config.type, state: state.state });
    if (config.enabled) this.scheduleStart(config, state.generation);
  }

  enable(id: string): void {
    const config = this.requireConfig(id);
    if (config.enabled && this.states.get(id)?.state !== "disabled") return;
    this.configure({ ...config, enabled: true });
  }

  disable(id: string): void {
    const config = this.requireConfig(id);
    this.stop(config);
    this.configs.set(id, { ...config, enabled: false });
    const state = this.states.get(id)!;
    state.generation++;
    state.state = "disabled";
    state.error = undefined;
    this.trace("service-state-changed", { serviceId: id, serviceType: config.type, state: "disabled" });
  }

  remove(id: string): boolean {
    const config = this.configs.get(id);
    if (!config) return false;
    this.stop(config);
    this.configs.delete(id);
    this.states.delete(id);
    return true;
  }

  configurations(): ServerServiceConfig[] {
    return [...this.configs.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(cloneServiceConfiguration);
  }

  summaries(): ServerServiceSummary[] {
    return this.configurations().map((config) => {
      const state = this.states.get(config.id)!;
      return {
        id: config.id,
        type: config.type,
        enabled: config.enabled,
        state: state.state,
        listeningPort: state.state === "listening" ? config.port : undefined,
        error: state.error,
      };
    });
  }

  runtimeSnapshot(): ServerServiceRuntimeSnapshot {
    return {
      services: this.summaries(),
      dns: { queries: this.dnsQueries },
      http: { requests: this.httpRequests },
      tftp: { activeTransfers: this.tftpTransfers.size, completedTransfers: this.completedTftpTransfers },
      ntp: { queries: this.ntpQueries },
      syslog: { entries: this.syslogEntries.map((entry) => ({ ...entry })) },
    };
  }

  clearSyslog(): void {
    this.syslogEntries.length = 0;
  }

  /** Recreate listeners and clear transient service state after an IP change. */
  restartRuntime(): void {
    const configurations = this.configurations();
    this.runtimeGeneration++;
    this.tftpTransfers.clear();
    this.dnsQueries = 0;
    this.httpRequests = 0;
    this.completedTftpTransfers = 0;
    this.ntpQueries = 0;
    this.syslogSequence = 0;
    this.syslogEntries.length = 0;
    this.configureAll(configurations);
  }

  private scheduleStart(config: ServerServiceConfig, generation: number): void {
    const runtimeGeneration = this.runtimeGeneration;
    this.host.engine().scheduleIn(SERVICE_START_DELAY_NS, () => {
      if (runtimeGeneration !== this.runtimeGeneration) return;
      const state = this.states.get(config.id);
      const current = this.configs.get(config.id);
      if (!state || !current || state.generation !== generation || !current.enabled) return;
      try {
        if (!this.host.localAddress()) throw new Error("Service requires a configured IPv4 address");
        this.start(current);
        state.state = "listening";
        state.error = undefined;
      } catch (error) {
        state.state = "error";
        state.error = error instanceof Error ? error.message : "Service failed to start";
      }
      this.trace("service-state-changed", {
        serviceId: current.id,
        serviceType: current.type,
        state: state.state,
        error: state.error,
      });
    });
  }

  private start(config: ServerServiceConfig): void {
    switch (config.type) {
      case "dns":
        this.host.transport.udp.bind(config.port, (received) => this.handleDns(config, received.sourceAddress, received.sourcePort, received.payload), "dns");
        return;
      case "http":
        this.host.transport.tcp.listen(config.port, (connection) => this.acceptHttp(config, connection), "http");
        return;
      case "tftp":
        this.host.transport.udp.bind(config.port, (received) => this.handleTftp(config, received.sourceAddress, received.sourcePort, received.payload), "tftp");
        return;
      case "ntp":
        this.host.transport.udp.bind(config.port, (received) => this.handleNtp(config, received.sourceAddress, received.sourcePort, received.payload), "ntp");
        return;
      case "syslog":
        this.host.transport.udp.bind(config.port, (received) => this.handleSyslog(config, received.sourceAddress, received.payload), "syslog");
    }
  }

  private stop(config: ServerServiceConfig): void {
    if (this.states.get(config.id)?.state !== "listening") return;
    if (config.type === "http") this.host.transport.tcp.unlisten(config.port);
    else this.host.transport.udp.unbind(config.port);
    for (const [key, transfer] of this.tftpTransfers) {
      if (transfer.service.id === config.id) this.tftpTransfers.delete(key);
    }
  }

  private handleDns(config: DnsServiceConfig, sourceAddress: Ipv4, sourcePort: number, payload: unknown): void {
    if (!isDnsQuery(payload)) return;
    this.dnsQueries++;
    let name = payload.name;
    let responseCode: DnsMessage["responseCode"] = "NOERROR";
    let address: Ipv4 | undefined;
    try {
      name = normalizeDnsName(name);
      address = config.records.find((record) => record.name === name)?.address;
      if (!address) responseCode = "NXDOMAIN";
    } catch {
      responseCode = "FORMERR";
    }
    const response: DnsMessage = {
      kind: "dns",
      messageType: "response",
      transactionId: payload.transactionId,
      name,
      responseCode,
      address,
    };
    this.host.transport.udp.send({ destinationAddress: sourceAddress, destinationPort: sourcePort, sourcePort: config.port, payload: response });
    this.trace("dns-service-query", { serviceId: config.id, name, responseCode, address });
  }

  private acceptHttp(config: HttpServiceConfig, connection: TcpConnection): void {
    connection.setHandlers({
      onMessage: (payload) => {
        this.httpRequests++;
        const response = this.httpResponse(config, payload);
        connection.send(response);
        connection.close();
        this.trace("http-service-request", {
          serviceId: config.id,
          method: payload.kind === "http" ? payload.method : undefined,
          path: payload.kind === "http" ? payload.path : undefined,
          status: response.status,
        });
      },
    });
  }

  private httpResponse(config: HttpServiceConfig, payload: unknown): HttpMessage {
    if (!isHttpRequest(payload) || !payload.host || !payload.path || (payload.method !== "GET" && payload.method !== "HEAD")) {
      return httpResponse(400, "text/plain", "Bad Request", false);
    }
    let path: string;
    try {
      path = normalizeHttpPath(payload.path);
    } catch {
      return httpResponse(400, "text/plain", "Bad Request", payload.method === "HEAD");
    }
    const resource = config.resources.find((candidate) => candidate.path === path);
    if (!resource) return httpResponse(404, "text/plain", "Not Found", payload.method === "HEAD");
    return httpResponse(200, resource.contentType, resource.body, payload.method === "HEAD");
  }

  private handleTftp(config: TftpServiceConfig, sourceAddress: Ipv4, sourcePort: number, payload: unknown): void {
    if (!isTftpMessage(payload)) return;
    const key = `${sourceAddress}:${sourcePort}:${payload.transferId}`;
    if (payload.opcode === "RRQ") {
      if (!payload.filename) {
        this.sendTftpError(config, sourceAddress, sourcePort, payload.transferId, "malformed", "Filename is required");
        return;
      }
      let filename: string;
      try {
        filename = normalizeTftpFilename(payload.filename);
      } catch {
        this.sendTftpError(config, sourceAddress, sourcePort, payload.transferId, "malformed", "Invalid filename");
        return;
      }
      const file = config.files.find((candidate) => candidate.filename === filename);
      if (!file) {
        this.sendTftpError(config, sourceAddress, sourcePort, payload.transferId, "not-found", "File not found");
        return;
      }
      if (!this.tftpTransfers.has(key) && this.tftpTransfers.size >= this.limits.maximumConcurrentRequests) {
        this.sendTftpError(config, sourceAddress, sourcePort, payload.transferId, "limit-exceeded", "Transfer limit exceeded");
        return;
      }
      const blocks = tftpBlocks(file.content);
      const transfer: TftpTransfer = {
        key,
        service: config,
        destinationAddress: sourceAddress,
        destinationPort: sourcePort,
        transferId: payload.transferId,
        blocks,
        blockIndex: 0,
        retries: 0,
        generation: 1,
      };
      this.tftpTransfers.set(key, transfer);
      this.sendTftpBlock(transfer);
      return;
    }
    const transfer = this.tftpTransfers.get(key);
    if (!transfer || payload.opcode !== "ACK" || payload.block !== transfer.blockIndex + 1) return;
    if (transfer.blockIndex === transfer.blocks.length - 1) {
      this.tftpTransfers.delete(key);
      this.completedTftpTransfers++;
      this.trace("tftp-service-complete", { serviceId: config.id, transferId: transfer.transferId });
      return;
    }
    transfer.blockIndex++;
    transfer.retries = 0;
    transfer.generation++;
    this.sendTftpBlock(transfer);
  }

  private sendTftpBlock(transfer: TftpTransfer): void {
    const block = transfer.blockIndex + 1;
    const payload: TftpMessage = {
      kind: "tftp",
      opcode: "DATA",
      transferId: transfer.transferId,
      block,
      data: transfer.blocks[transfer.blockIndex]!,
      final: transfer.blockIndex === transfer.blocks.length - 1,
    };
    this.host.transport.udp.send({
      destinationAddress: transfer.destinationAddress,
      destinationPort: transfer.destinationPort,
      sourcePort: transfer.service.port,
      payload,
    });
    this.trace("tftp-service-block", { serviceId: transfer.service.id, transferId: transfer.transferId, block, final: payload.final });
    const generation = transfer.generation;
    this.host.engine().scheduleIn(SERVICE_REQUEST_TIMEOUT_NS, () => {
      const current = this.tftpTransfers.get(transfer.key);
      if (!current || current.generation !== generation) return;
      if (current.retries >= this.limits.maximumProtocolRetries) {
        this.tftpTransfers.delete(current.key);
        this.trace("tftp-service-timeout", { serviceId: current.service.id, transferId: current.transferId });
        return;
      }
      current.retries++;
      current.generation++;
      this.sendTftpBlock(current);
    });
  }

  private sendTftpError(
    config: TftpServiceConfig,
    destinationAddress: Ipv4,
    destinationPort: number,
    transferId: number,
    errorCode: NonNullable<TftpMessage["errorCode"]>,
    message: string,
  ): void {
    const payload: TftpMessage = { kind: "tftp", opcode: "ERROR", transferId, errorCode, message };
    this.host.transport.udp.send({ destinationAddress, destinationPort, sourcePort: config.port, payload });
  }

  private handleNtp(config: NtpServiceConfig, sourceAddress: Ipv4, sourcePort: number, payload: unknown): void {
    if (!isNtpQuery(payload)) return;
    this.ntpQueries++;
    const response: NtpMessage = {
      kind: "ntp",
      messageType: "response",
      requestId: payload.requestId,
      clientTimeNs: payload.clientTimeNs,
      serverTimeNs: this.host.engine().now() + config.offsetNs,
    };
    this.host.transport.udp.send({ destinationAddress: sourceAddress, destinationPort: sourcePort, sourcePort: config.port, payload: response });
    this.trace("ntp-service-query", { serviceId: config.id, requestId: payload.requestId, serverTimeNs: response.serverTimeNs });
  }

  private handleSyslog(config: SyslogServiceConfig, sourceAddress: Ipv4, payload: unknown): void {
    if (!isSyslogMessage(payload)) return;
    const retention = Math.min(config.retention, this.limits.maximumSyslogEntries);
    this.syslogEntries.push({
      sequence: ++this.syslogSequence,
      receivedAtNs: this.host.engine().now(),
      sourceAddress,
      source: payload.source,
      facility: payload.facility,
      severity: payload.severity,
      timestampNs: payload.timestampNs,
      message: payload.message,
    });
    if (this.syslogEntries.length > retention) this.syslogEntries.splice(0, this.syslogEntries.length - retention);
    this.trace("syslog-received", { serviceId: config.id, sourceAddress, severity: payload.severity, sequence: this.syslogSequence });
  }

  private requireConfig(id: string): ServerServiceConfig {
    const config = this.configs.get(id);
    if (!config) throw new Error(`Unknown server service '${id}'`);
    return config;
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    this.host.engine().trace({ time: this.host.engine().now(), type, device: this.host.deviceId, detail });
  }
}

function normalizeServiceConfiguration(
  config: ServerServiceConfig,
  limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
): ServerServiceConfig {
  switch (config.type) {
    case "dns": {
      if (config.records.length > limits.maximumDnsRecords) throw new Error("DNS record limit exceeded");
      const records = config.records.map((record) => ({ ...record, name: normalizeDnsName(record.name) }));
      const unique = new Set(records.map((record) => record.name));
      if (unique.size !== records.length) throw new Error("DNS record names must be unique");
      return { ...config, records: records.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    case "http": {
      if (config.resources.length > limits.maximumHttpResources) throw new Error("HTTP resource limit exceeded");
      const resources = config.resources.map((resource) => {
        if (stringByteLength(resource.body) > limits.maximumHttpBodyBytes) throw new Error("HTTP body limit exceeded");
        return { ...resource, path: normalizeHttpPath(resource.path) };
      });
      const unique = new Set(resources.map((resource) => resource.path));
      if (unique.size !== resources.length) throw new Error("HTTP resource paths must be unique");
      return { ...config, resources: resources.sort((a, b) => a.path.localeCompare(b.path)) };
    }
    case "tftp": {
      if (config.files.length > limits.maximumTftpFiles) throw new Error("TFTP file limit exceeded");
      const files = config.files.map((file) => {
        if (stringByteLength(file.content) > limits.maximumTftpFileBytes) throw new Error("TFTP file size limit exceeded");
        return { ...file, filename: normalizeTftpFilename(file.filename) };
      });
      const unique = new Set(files.map((file) => file.filename));
      if (unique.size !== files.length) throw new Error("TFTP filenames must be unique");
      return { ...config, files: files.sort((a, b) => a.filename.localeCompare(b.filename)) };
    }
    default:
      return { ...config };
  }
}

function cloneServiceConfiguration(config: ServerServiceConfig): ServerServiceConfig {
  if (config.type === "dns") return { ...config, records: config.records.map((record) => ({ ...record })) };
  if (config.type === "http") return { ...config, resources: config.resources.map((resource) => ({ ...resource })) };
  if (config.type === "tftp") return { ...config, files: config.files.map((file) => ({ ...file })) };
  return { ...config };
}

function isDnsQuery(payload: unknown): payload is DnsMessage & { messageType: "query" } {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "dns"
    && (payload as { messageType?: unknown }).messageType === "query"
    && typeof (payload as { transactionId?: unknown }).transactionId === "number"
    && typeof (payload as { name?: unknown }).name === "string";
}

function isHttpRequest(payload: unknown): payload is HttpMessage & { messageType: "request" } {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "http"
    && (payload as { messageType?: unknown }).messageType === "request";
}

function isTftpMessage(payload: unknown): payload is TftpMessage {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "tftp"
    && typeof (payload as { transferId?: unknown }).transferId === "number";
}

function isNtpQuery(payload: unknown): payload is NtpMessage & { messageType: "query" } {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "ntp"
    && (payload as { messageType?: unknown }).messageType === "query"
    && typeof (payload as { requestId?: unknown }).requestId === "number"
    && typeof (payload as { clientTimeNs?: unknown }).clientTimeNs === "number";
}

function isSyslogMessage(payload: unknown): payload is SyslogMessage {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "syslog"
    && typeof (payload as { source?: unknown }).source === "string"
    && typeof (payload as { message?: unknown }).message === "string";
}

function httpResponse(status: 200 | 400 | 404, contentType: string, body: string, head: boolean): HttpMessage {
  return {
    kind: "http",
    messageType: "response",
    status,
    headers: { "content-type": contentType, "content-length": String(stringByteLength(body)) },
    body: head ? undefined : body,
  };
}

function tftpBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (let offset = 0; offset < content.length; offset += TFTP_BLOCK_SIZE) {
    blocks.push(content.slice(offset, offset + TFTP_BLOCK_SIZE));
  }
  if (blocks.length === 0 || content.length % TFTP_BLOCK_SIZE === 0) blocks.push("");
  return blocks;
}

export { normalizeServiceConfiguration };
