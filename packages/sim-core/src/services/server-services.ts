import {
  AAA_LIMITS,
  ServerServiceConfigSchema,
  type DnsServiceConfig,
  type HttpServiceConfig,
  type NtpServiceConfig,
  type RadiusServiceConfig,
  type ServerServiceConfig,
  type SyslogServiceConfig,
  type TacacsServiceConfig,
  type TftpServiceConfig,
} from "@sim/contracts";
import {
  AaaAccountingLog,
  authenticateAaaUser,
  authorizeClient,
  authorizeCommand,
  radiusAccept,
  redactAccountedCommand,
  tacacsAuthenticationReply,
  tacacsAuthorizationReply,
  type AaaAccountingEntry,
  type AaaServiceRuntimeSnapshot,
} from "./aaa-services";
import type { RadiusMessage, TacacsMessage } from "./messages";
import { NetworkManagementService, type NmsRuntimeSnapshot } from "../management/nms-service";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { TcpConnection } from "../transport/tcp";
import type { HostTransportStack } from "../transport/host-transport";
import type { IpAddress, IpFamily } from "../util/ip-address";
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
  readonly sourceAddress: IpAddress;
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
  readonly radius: AaaServiceRuntimeSnapshot;
  readonly tacacs: AaaServiceRuntimeSnapshot;
  readonly networkManagement: NmsRuntimeSnapshot;
}

interface ServiceState {
  state: ServiceLifecycleState;
  generation: number;
  error?: string;
}

interface TftpTransfer {
  readonly key: string;
  readonly service: TftpServiceConfig;
  readonly destinationAddress: IpAddress;
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
  readonly localAddress: (family: IpFamily, destination?: IpAddress) => IpAddress | undefined;
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
  private readonly accounting = new AaaAccountingLog();
  /** The Server-side SNMP manager and trap receiver. */
  readonly networkManagement: NetworkManagementService;
  private readonly aaaCounters = {
    radius: { accessAccepted: 0, accessRejected: 0, authorizationPermitted: 0, authorizationDenied: 0 },
    tacacs: { accessAccepted: 0, accessRejected: 0, authorizationPermitted: 0, authorizationDenied: 0 },
  };

  constructor(
    private readonly host: ServerServiceAdapter,
    private readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {
    this.networkManagement = new NetworkManagementService({
      deviceId: host.deviceId,
      engine: host.engine,
      transport: host.transport,
    });
  }

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
      radius: this.aaaSnapshot("radius"),
      tacacs: this.aaaSnapshot("tacacs+"),
      networkManagement: this.networkManagement.runtimeSnapshot(),
    };
  }

  clearSyslog(): void {
    this.syslogEntries.length = 0;
  }

  /** Accounting is runtime state: clearing it never touches configuration. */
  clearAaaRuntime(): void {
    this.accounting.clear();
    for (const counters of Object.values(this.aaaCounters)) {
      counters.accessAccepted = 0;
      counters.accessRejected = 0;
      counters.authorizationPermitted = 0;
      counters.authorizationDenied = 0;
    }
  }

  private aaaSnapshot(protocol: AaaAccountingEntry["protocol"]): AaaServiceRuntimeSnapshot {
    const counters = protocol === "radius" ? this.aaaCounters.radius : this.aaaCounters.tacacs;
    return {
      ...counters,
      accounting: this.accounting.snapshot().filter((entry) => entry.protocol === protocol),
    };
  }

  /** Recreate listeners and clear transient service state after an IP change. */
  restartRuntime(): void {
    const configurations = this.configurations();
    this.runtimeGeneration++;
    this.clearAaaRuntime();
    this.networkManagement.resetRuntime();
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
        if (!this.host.localAddress("ipv4") && !this.host.localAddress("ipv6")) {
          throw new Error("Service requires a configured IP address");
        }
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
        return;
      case "radius":
        this.host.transport.udp.bind(
          config.port,
          (received) => this.handleRadius(config, received.sourceAddress, received.sourcePort, received.payload, false),
          "radius",
        );
        this.host.transport.udp.bind(
          config.accountingPort,
          (received) => this.handleRadius(config, received.sourceAddress, received.sourcePort, received.payload, true),
          "radius-accounting",
        );
        return;
      case "tacacs":
        this.host.transport.tcp.listen(
          config.port,
          (connection) => connection.setHandlers({
            onMessage: (payload) => this.handleTacacs(config, connection, payload),
          }),
          "tacacs",
        );
        return;
      case "network-management":
        this.networkManagement.configure(config);
        this.networkManagement.listen(config.port);
    }
  }

  private stop(config: ServerServiceConfig): void {
    if (this.states.get(config.id)?.state !== "listening") return;
    if (config.type === "http" || config.type === "tacacs") this.host.transport.tcp.unlisten(config.port);
    else if (config.type === "radius") {
      this.host.transport.udp.unbind(config.port);
      this.host.transport.udp.unbind(config.accountingPort);
    } else if (config.type === "network-management") {
      this.networkManagement.unlisten(config.port);
    } else this.host.transport.udp.unbind(config.port);
    for (const [key, transfer] of this.tftpTransfers) {
      if (transfer.service.id === config.id) this.tftpTransfers.delete(key);
    }
  }

  private handleDns(config: DnsServiceConfig, sourceAddress: IpAddress, sourcePort: number, payload: unknown): void {
    if (!isDnsQuery(payload)) return;
    this.dnsQueries++;
    let name = payload.name;
    let responseCode: DnsMessage["responseCode"] = "NOERROR";
    let address: IpAddress | undefined;
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

  private handleTftp(config: TftpServiceConfig, sourceAddress: IpAddress, sourcePort: number, payload: unknown): void {
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
    destinationAddress: IpAddress,
    destinationPort: number,
    transferId: number,
    errorCode: NonNullable<TftpMessage["errorCode"]>,
    message: string,
  ): void {
    const payload: TftpMessage = { kind: "tftp", opcode: "ERROR", transferId, errorCode, message };
    this.host.transport.udp.send({ destinationAddress, destinationPort, sourcePort: config.port, payload });
  }

  private handleNtp(config: NtpServiceConfig, sourceAddress: IpAddress, sourcePort: number, payload: unknown): void {
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

  private handleSyslog(config: SyslogServiceConfig, sourceAddress: IpAddress, payload: unknown): void {
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

  // --- AAA services --------------------------------------------------------

  /**
   * Educational RADIUS. Authentication and accounting are structured messages
   * over UDP; the shared key and the user's password travel only as opaque
   * fingerprints, so nothing here can leak a secret into a trace or a result.
   */
  private handleRadius(
    config: RadiusServiceConfig,
    sourceAddress: IpAddress,
    sourcePort: number,
    payload: unknown,
    accounting: boolean,
  ): void {
    if (!isRadiusMessage(payload)) return;
    const client = authorizeClient(
      config.clients,
      config.restrictToConfiguredClients,
      sourceAddress,
      payload.sharedKeyFingerprint,
    );
    if (accounting) {
      if (!client.ok || payload.code !== "Accounting-Request") return;
      this.recordAccounting("radius", sourceAddress, payload.deviceName, payload.username, payload.sessionId, payload.accountingStatus === "stop" ? "stop" : "start", payload.detail);
      this.reply(sourceAddress, sourcePort, config.accountingPort, {
        kind: "radius",
        code: "Accounting-Response",
        identifier: payload.identifier,
      });
      return;
    }
    if (payload.code !== "Access-Request") return;
    if (!client.ok) {
      this.aaaCounters.radius.accessRejected++;
      this.trace("radius-client-rejected", { serviceId: config.id, sourceAddress, reason: client.reason });
      this.reply(sourceAddress, sourcePort, config.port, {
        kind: "radius",
        code: "Access-Reject",
        identifier: payload.identifier,
        replyMessage: "Client not authorized",
      });
      return;
    }
    const decision = authenticateAaaUser(config.users, payload.username, payload.credentialFingerprint);
    if (decision.status === "accept") this.aaaCounters.radius.accessAccepted++;
    else this.aaaCounters.radius.accessRejected++;
    this.trace("radius-access-request", {
      serviceId: config.id,
      username: payload.username,
      sourceAddress,
      result: decision.status,
      reason: decision.reason,
    });
    this.reply(sourceAddress, sourcePort, config.port, radiusAccept(payload, decision));
  }

  /**
   * Educational TACACS+ over TCP: authentication, exec authorization, per
   * command authorization and accounting. Command matching is a bounded
   * declarative matcher, never a regular expression from a LabDocument.
   */
  private handleTacacs(config: TacacsServiceConfig, connection: TcpConnection, payload: unknown): void {
    if (!isTacacsMessage(payload)) return;
    const sourceAddress = connection.remoteAddress;
    const client = authorizeClient(
      config.clients,
      config.restrictToConfiguredClients,
      sourceAddress,
      payload.sharedKeyFingerprint,
    );
    if (!client.ok) {
      this.aaaCounters.tacacs.accessRejected++;
      this.trace("tacacs-client-rejected", { serviceId: config.id, sourceAddress, reason: client.reason });
      connection.send({
        kind: "tacacs",
        messageType: payload.messageType === "authorization-request" ? "authorization-reply" : "authentication-reply",
        sequence: payload.sequence + 1,
        status: "fail",
        replyMessage: "Client not authorized",
      });
      return;
    }
    if (payload.messageType === "authentication-request") {
      const decision = authenticateAaaUser(config.users, payload.username, payload.credentialFingerprint);
      if (decision.status === "accept") this.aaaCounters.tacacs.accessAccepted++;
      else this.aaaCounters.tacacs.accessRejected++;
      this.trace("tacacs-authentication", {
        serviceId: config.id,
        username: payload.username,
        sourceAddress,
        result: decision.status,
        reason: decision.reason,
      });
      connection.send(tacacsAuthenticationReply(payload, decision));
      return;
    }
    if (payload.messageType === "authorization-request") {
      const username = payload.username?.trim() ?? "";
      const user = config.users.find((candidate) => candidate.enabled && candidate.username === username);
      const privilegeLevel = payload.privilegeLevel ?? user?.privilegeLevel ?? 0;
      const action = payload.service === "exec"
        ? config.execAuthorizationDefault
        : authorizeCommand(config, username, privilegeLevel, payload.command ?? "").action;
      if (action === "permit") this.aaaCounters.tacacs.authorizationPermitted++;
      else this.aaaCounters.tacacs.authorizationDenied++;
      this.trace("tacacs-authorization", {
        serviceId: config.id,
        username,
        service: payload.service,
        command: payload.command ? redactAccountedCommand(payload.command) : undefined,
        result: action,
      });
      connection.send(tacacsAuthorizationReply(payload, action, privilegeLevel));
      return;
    }
    if (payload.messageType === "accounting-request") {
      const event = payload.accountingStatus === "stop"
        ? "stop"
        : payload.accountingStatus === "command" ? "command" : "start";
      this.recordAccounting(
        "tacacs+",
        sourceAddress,
        payload.deviceName,
        payload.username,
        payload.sessionId,
        event,
        payload.command ?? payload.detail,
      );
      connection.send({
        kind: "tacacs",
        messageType: "accounting-reply",
        sequence: payload.sequence + 1,
        status: "pass",
      });
    }
  }

  private recordAccounting(
    protocol: AaaAccountingEntry["protocol"],
    deviceAddress: IpAddress,
    deviceName: string | undefined,
    username: string | undefined,
    sessionId: string | undefined,
    event: AaaAccountingEntry["event"],
    detail: string | undefined,
  ): void {
    const entry = this.accounting.record({
      receivedAtNs: this.host.engine().now(),
      protocol,
      event,
      deviceName: deviceName ?? deviceAddress,
      deviceAddress,
      username: username ?? "",
      sessionId: sessionId ?? "",
      // A command argument that carries a secret is redacted before storage.
      detail: detail ? redactAccountedCommand(detail) : event,
    });
    this.trace("aaa-accounting", {
      protocol,
      event,
      username: entry.username,
      sessionId: entry.sessionId,
      sequence: entry.sequence,
    });
  }

  private reply(destinationAddress: IpAddress, destinationPort: number, sourcePort: number, payload: RadiusMessage): void {
    this.host.transport.udp.send({ destinationAddress, destinationPort, sourcePort, payload });
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
    case "radius":
    case "tacacs": {
      if (config.users.length > AAA_LIMITS.maximumUsersPerServer) throw new Error("AAA user limit exceeded");
      if (config.clients.length > AAA_LIMITS.maximumClientsPerServer) throw new Error("AAA client limit exceeded");
      const usernames = new Set(config.users.map((user) => user.username));
      if (usernames.size !== config.users.length) throw new Error("AAA usernames must be unique");
      const base = {
        ...config,
        users: [...config.users].sort((a, b) => a.username.localeCompare(b.username)).map((user) => ({ ...user })),
        clients: [...config.clients].sort((a, b) => a.address.localeCompare(b.address)).map((client) => ({ ...client })),
      };
      if (base.type !== "tacacs") return base;
      if (base.commandRules.length > AAA_LIMITS.maximumCommandRulesPerServer) {
        throw new Error("TACACS+ command rule limit exceeded");
      }
      return {
        ...base,
        commandRules: [...base.commandRules]
          .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
          .map((rule) => ({ ...rule })),
      };
    }
    default:
      return { ...config };
  }
}

function cloneServiceConfiguration(config: ServerServiceConfig): ServerServiceConfig {
  if (config.type === "dns") return { ...config, records: config.records.map((record) => ({ ...record })) };
  if (config.type === "http") return { ...config, resources: config.resources.map((resource) => ({ ...resource })) };
  if (config.type === "tftp") return { ...config, files: config.files.map((file) => ({ ...file })) };
  if (config.type === "radius") {
    return {
      ...config,
      users: config.users.map((user) => ({ ...user })),
      clients: config.clients.map((client) => ({ ...client })),
    };
  }
  if (config.type === "tacacs") {
    return {
      ...config,
      users: config.users.map((user) => ({ ...user })),
      clients: config.clients.map((client) => ({ ...client })),
      commandRules: config.commandRules.map((rule) => ({ ...rule })),
    };
  }
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

function isRadiusMessage(payload: unknown): payload is RadiusMessage {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "radius"
    && typeof (payload as { identifier?: unknown }).identifier === "number"
    && typeof (payload as { code?: unknown }).code === "string";
}

function isTacacsMessage(payload: unknown): payload is TacacsMessage {
  return typeof payload === "object" && payload !== null
    && (payload as { kind?: unknown }).kind === "tacacs"
    && typeof (payload as { sequence?: unknown }).sequence === "number"
    && typeof (payload as { messageType?: unknown }).messageType === "string";
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
