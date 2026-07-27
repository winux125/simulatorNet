import type { SimulationEngine } from "../engine/simulation-engine";
import type { TcpPayload } from "../packets/tcp";
import type { UdpPayload } from "../packets/udp";
import type { HostTransportStack } from "../transport/host-transport";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { ipFamilyOf, type IpAddress, type IpFamily } from "../util/ip-address";
import { normalizeIpv6 } from "../util/ipv6";
import {
  DEFAULT_SERVICE_LIMITS,
  SERVICE_REQUEST_TIMEOUT_NS,
  type ServiceLimits,
} from "./limits";
import type {
  DnsMessage,
  HttpMessage,
  NtpMessage,
  SyslogMessage,
  SyslogSeverity,
  TftpMessage,
} from "./messages";
import { normalizeDnsName, normalizeTftpFilename, stringByteLength } from "./normalize";

export interface DnsResolutionResult {
  readonly requestId: number;
  readonly hostname: string;
  readonly serverAddress: IpAddress;
  readonly status: "success" | "nxdomain" | "malformed" | "timeout";
  readonly address?: IpAddress;
}

export interface HttpClientResult {
  readonly requestId: number;
  readonly url: string;
  readonly status: "completed" | "connection-refused" | "timeout";
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface TftpClientResult {
  readonly requestId: number;
  readonly serverAddress: IpAddress;
  readonly filename: string;
  readonly status: "completed" | "not-found" | "error" | "timeout";
  readonly content?: string;
  readonly message?: string;
}

export interface NtpClientResult {
  readonly requestId: number;
  readonly serverAddress: IpAddress;
  readonly status: "completed" | "timeout";
  readonly serverTimeNs?: number;
  readonly offsetNs?: number;
}

interface HostApplicationAdapter {
  readonly deviceId: string;
  readonly hostname: () => string;
  readonly engine: () => SimulationEngine;
  readonly localAddress: (family: IpFamily, destination?: IpAddress) => IpAddress | undefined;
  readonly transport: HostTransportStack;
}

interface TftpDownloadState {
  readonly requestId: number;
  readonly serverAddress: IpAddress;
  readonly filename: string;
  readonly port: number;
  readonly blocks: string[];
  expectedBlock: number;
  attempts: number;
  completed: boolean;
  readonly runtimeGeneration: number;
}

/** Deterministic application clients shared by PC and Server. */
export class HostApplications {
  dnsServer: IpAddress | undefined;
  clockOffsetNs = 0;
  readonly dnsResults: DnsResolutionResult[] = [];
  readonly httpResults: HttpClientResult[] = [];
  readonly tftpResults: TftpClientResult[] = [];
  readonly ntpResults: NtpClientResult[] = [];
  readonly downloadedFiles = new Map<string, string>();

  private nextRequestId = 1;
  private activeRequests = 0;
  private runtimeGeneration = 0;

  constructor(
    private readonly host: HostApplicationAdapter,
    private readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {}

  setDnsServer(address: IpAddress | undefined): void {
    if (address !== undefined) validateIpAddress(address);
    this.dnsServer = address;
  }

  /** Invalidate pending application work tied to the previous host address. */
  resetRuntime(): void {
    this.runtimeGeneration++;
    this.activeRequests = 0;
    this.dnsResults.length = 0;
    this.httpResults.length = 0;
    this.tftpResults.length = 0;
    this.ntpResults.length = 0;
    this.downloadedFiles.clear();
    this.clockOffsetNs = 0;
  }

  resolveDns(hostname: string, serverAddress = this.dnsServer): number {
    const name = normalizeDnsName(hostname);
    if (!serverAddress) throw new Error(`No DNS server configured on ${this.host.deviceId}`);
    validateIpAddress(serverAddress);
    this.beginRequest();
    const requestId = this.allocateRequestId();
    const generation = this.runtimeGeneration;
    let completed = false;
    let attempts = 0;
    const port = this.host.transport.udp.bind(0, (received) => {
      if (generation !== this.runtimeGeneration) return;
      if (received.sourceAddress !== serverAddress || received.payload.kind !== "dns") return;
      const message = received.payload;
      if (message.messageType !== "response" || message.transactionId !== requestId || completed) return;
      completed = true;
      this.host.transport.udp.unbind(port);
      this.endRequest();
      const status = message.responseCode === "NOERROR" && message.address
        ? "success"
        : message.responseCode === "NXDOMAIN"
          ? "nxdomain"
          : "malformed";
      this.dnsResults.push({ requestId, hostname: name, serverAddress, status, address: message.address });
      this.trace("dns-response", { requestId, hostname: name, status, address: message.address });
    }, "dns-client");
    const query = (): void => {
      if (generation !== this.runtimeGeneration) return;
      attempts++;
      const payload: DnsMessage = { kind: "dns", messageType: "query", transactionId: requestId, name };
      this.host.transport.udp.send({ destinationAddress: serverAddress, destinationPort: 53, sourcePort: port, payload });
      this.trace("dns-query", { requestId, hostname: name, serverAddress, attempt: attempts });
      this.host.engine().scheduleIn(SERVICE_REQUEST_TIMEOUT_NS, timeout);
    };
    const timeout = (): void => {
      if (generation !== this.runtimeGeneration) return;
      if (completed) return;
      if (attempts <= this.limits.maximumProtocolRetries) {
        query();
        return;
      }
      completed = true;
      this.host.transport.udp.unbind(port);
      this.endRequest();
      this.dnsResults.push({ requestId, hostname: name, serverAddress, status: "timeout" });
      this.trace("dns-timeout", { requestId, hostname: name, serverAddress });
    };
    query();
    return requestId;
  }

  httpGet(url: string, method: "GET" | "HEAD" = "GET"): number {
    const target = parseHttpUrl(url);
    this.beginRequest();
    const requestId = this.allocateRequestId();
    const generation = this.runtimeGeneration;
    let completed = false;
    const finish = (result: HttpClientResult): void => {
      if (generation !== this.runtimeGeneration) return;
      if (completed) return;
      completed = true;
      this.endRequest();
      this.httpResults.push(result);
    };
    const connection = this.host.transport.tcp.connect(target.address, target.port, {
      onEstablished: (current) => {
        if (generation !== this.runtimeGeneration) return;
        const request: HttpMessage = {
          kind: "http",
          messageType: "request",
          method,
          host: target.host,
          path: target.path,
        };
        current.send(request);
        this.trace("http-request", { requestId, method, host: target.host, path: target.path });
      },
      onMessage: (payload) => {
        if (generation !== this.runtimeGeneration) return;
        if (payload.kind !== "http" || payload.messageType !== "response") return;
        finish({
          requestId,
          url,
          status: "completed",
          statusCode: payload.status,
          headers: payload.headers,
          body: payload.body,
        });
        this.trace("http-response", { requestId, status: payload.status });
      },
      onReset: () => finish({ requestId, url, status: "connection-refused" }),
    }, "http-client");
    this.host.engine().scheduleIn(SERVICE_REQUEST_TIMEOUT_NS, () => {
      if (generation !== this.runtimeGeneration) return;
      if (completed) return;
      connection.close();
      finish({ requestId, url, status: "timeout" });
      this.trace("http-timeout", { requestId, url });
    });
    return requestId;
  }

  tftpGet(serverAddress: IpAddress, filename: string): number {
    validateIpAddress(serverAddress);
    const normalized = normalizeTftpFilename(filename);
    this.beginRequest();
    const requestId = this.allocateRequestId();
    const generation = this.runtimeGeneration;
    const state: TftpDownloadState = {
      requestId,
      serverAddress,
      filename: normalized,
      port: 0,
      blocks: [],
      expectedBlock: 1,
      attempts: 0,
      completed: false,
      runtimeGeneration: generation,
    };
    const port = this.host.transport.udp.bind(0, (received) => this.handleTftpDownload(state, received.payload), "tftp-client");
    Object.assign(state, { port });
    const request = (): void => {
      if (state.runtimeGeneration !== this.runtimeGeneration) return;
      if (state.completed) return;
      state.attempts++;
      const rrq: TftpMessage = { kind: "tftp", opcode: "RRQ", transferId: requestId, filename: normalized };
      this.host.transport.udp.send({ destinationAddress: serverAddress, destinationPort: 69, sourcePort: port, payload: rrq });
      this.trace("tftp-rrq", { requestId, serverAddress, filename: normalized, attempt: state.attempts });
      this.host.engine().scheduleIn(SERVICE_REQUEST_TIMEOUT_NS, () => {
        if (state.runtimeGeneration !== this.runtimeGeneration) return;
        if (state.completed) return;
        if (state.attempts <= this.limits.maximumProtocolRetries) request();
        else this.finishTftp(state, "timeout", undefined, "Transfer timed out");
      });
    };
    request();
    return requestId;
  }

  queryNtp(serverAddress: IpAddress): number {
    validateIpAddress(serverAddress);
    this.beginRequest();
    const requestId = this.allocateRequestId();
    const generation = this.runtimeGeneration;
    let completed = false;
    const port = this.host.transport.udp.bind(0, (received) => {
      if (generation !== this.runtimeGeneration) return;
      if (received.sourceAddress !== serverAddress || received.payload.kind !== "ntp") return;
      const response = received.payload;
      if (response.messageType !== "response" || response.requestId !== requestId || response.serverTimeNs === undefined || completed) return;
      completed = true;
      this.host.transport.udp.unbind(port);
      this.endRequest();
      const offsetNs = response.serverTimeNs - this.host.engine().now();
      this.clockOffsetNs = offsetNs;
      this.ntpResults.push({ requestId, serverAddress, status: "completed", serverTimeNs: response.serverTimeNs, offsetNs });
      this.trace("ntp-response", { requestId, serverAddress, serverTimeNs: response.serverTimeNs, offsetNs });
    }, "ntp-client");
    const query: NtpMessage = {
      kind: "ntp",
      messageType: "query",
      requestId,
      clientTimeNs: this.clockNow(),
    };
    this.host.transport.udp.send({ destinationAddress: serverAddress, destinationPort: 123, sourcePort: port, payload: query });
    this.trace("ntp-query", { requestId, serverAddress });
    this.host.engine().scheduleIn(SERVICE_REQUEST_TIMEOUT_NS, () => {
      if (generation !== this.runtimeGeneration) return;
      if (completed) return;
      completed = true;
      this.host.transport.udp.unbind(port);
      this.endRequest();
      this.ntpResults.push({ requestId, serverAddress, status: "timeout" });
      this.trace("ntp-timeout", { requestId, serverAddress });
    });
    return requestId;
  }

  sendSyslog(serverAddress: IpAddress, severity: SyslogSeverity, message: string, facility = "user"): void {
    validateIpAddress(serverAddress);
    if (!message.trim()) throw new Error("Syslog message must not be empty");
    const payload: SyslogMessage = {
      kind: "syslog",
      facility,
      severity,
      source: this.host.hostname(),
      timestampNs: this.clockNow(),
      message,
    };
    this.host.transport.udp.send({ destinationAddress: serverAddress, destinationPort: 514, payload });
    this.trace("syslog-sent", { serverAddress, severity, facility });
  }

  clockNow(): number {
    return this.host.engine().now() + this.clockOffsetNs;
  }

  private handleTftpDownload(state: TftpDownloadState, payload: UdpPayload): void {
    if (state.runtimeGeneration !== this.runtimeGeneration) return;
    if (payload.kind !== "tftp" || payload.transferId !== state.requestId || state.completed) return;
    if (payload.opcode === "ERROR") {
      this.finishTftp(state, payload.errorCode === "not-found" ? "not-found" : "error", undefined, payload.message);
      return;
    }
    if (payload.opcode !== "DATA" || payload.block === undefined || payload.data === undefined) return;
    if (payload.block === state.expectedBlock) {
      state.blocks.push(payload.data);
      state.expectedBlock++;
    }
    const ack: TftpMessage = { kind: "tftp", opcode: "ACK", transferId: state.requestId, block: payload.block };
    this.host.transport.udp.send({
      destinationAddress: state.serverAddress,
      destinationPort: 69,
      sourcePort: state.port,
      payload: ack,
    });
    this.trace("tftp-block", { requestId: state.requestId, block: payload.block, final: payload.final });
    if (payload.final) {
      const content = state.blocks.join("");
      if (stringByteLength(content) > this.limits.maximumTftpFileBytes) {
        this.finishTftp(state, "error", undefined, "Downloaded file exceeds the configured limit");
        return;
      }
      this.finishTftp(state, "completed", content);
    }
  }

  private finishTftp(
    state: TftpDownloadState,
    status: TftpClientResult["status"],
    content?: string,
    message?: string,
  ): void {
    if (state.runtimeGeneration !== this.runtimeGeneration) return;
    if (state.completed) return;
    state.completed = true;
    this.host.transport.udp.unbind(state.port);
    this.endRequest();
    if (content !== undefined) {
      if (!this.downloadedFiles.has(state.filename) && this.downloadedFiles.size >= this.limits.maximumDownloadedFiles) {
        status = "error";
        message = "Downloaded file store limit exceeded";
        content = undefined;
      } else {
        this.downloadedFiles.set(state.filename, content);
      }
    }
    this.tftpResults.push({
      requestId: state.requestId,
      serverAddress: state.serverAddress,
      filename: state.filename,
      status,
      content,
      message,
    });
    this.trace("tftp-complete", { requestId: state.requestId, filename: state.filename, status });
  }

  private beginRequest(): void {
    if (this.activeRequests >= this.limits.maximumConcurrentRequests) {
      throw new Error(`Concurrent application request limit exceeded on ${this.host.deviceId}`);
    }
    this.activeRequests++;
  }

  private endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
  }

  private allocateRequestId(): number {
    return this.nextRequestId++;
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    this.host.engine().trace({ time: this.host.engine().now(), type, device: this.host.deviceId, detail });
  }
}

function parseHttpUrl(url: string): { address: IpAddress; port: number; host: string; path: string } {
  const match = /^http:\/\/(\[[^\]]+\]|[^/:]+)(?::(\d+))?(\/.*)?$/.exec(url.trim());
  if (!match?.[1]) throw new Error(`Invalid HTTP URL '${url}'`);
  const host = match[1];
  const address = host.startsWith("[") ? normalizeIpv6(host.slice(1, -1)) : host as Ipv4;
  validateIpAddress(address);
  const port = match[2] ? Number(match[2]) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid HTTP port '${match[2]}'`);
  const path = match[3] ?? "/";
  return { address, port, host, path };
}

function validateIpAddress(address: IpAddress): void {
  if (ipFamilyOf(address) === "ipv6") normalizeIpv6(address);
  else ipToInt(address);
}

export function isHttpPayload(payload: TcpPayload): payload is HttpMessage {
  return payload.kind === "http";
}
