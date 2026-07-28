import {
  MANAGEMENT_LIMITS,
  type ConsoleAccessConfiguration,
  type RemoteAccessConfiguration,
} from "@sim/contracts";
import type {
  RemoteLineSummary,
  RemoteSessionBridge,
  RemoteSessionOpener,
  RemoteSessionRequest,
  RemoteSessionSummaryView,
} from "@sim/cli-engine";
import {
  EndHost,
  L2Switch,
  Router,
  ipFamilyOf,
  normalizeIpv6,
  type Device,
  type IpAddress,
  type SimulationEngine,
} from "@sim/sim-core";
import { AaaAuthenticationProvider, type AaaStatusView } from "./aaa";
import { KnownHostStore, RemoteCliClient } from "./client";
import { managedDeviceOf } from "./managed-device";
import type { RemoteCloseReason } from "./messages";
import { RemoteCliService, type RemoteSessionSummary } from "./service";

export interface ManagementPlaneDevice {
  readonly deviceId: string;
  readonly service: RemoteCliService;
}

/** Problems are a bounded, de-duplicated list, never an unbounded log. */
const MANAGEMENT_PROBLEM_LIMIT = 32;

/** Learner-facing explanation for each way a remote session can end badly. */
const CLOSE_PROBLEM: Partial<Record<RemoteCloseReason, string>> = {
  "authentication-failed": "Remote login rejected",
  "authorization-failed": "Remote exec authorization denied",
  "no-vty-line": "No VTY line was available for the remote session",
  "service-disabled": "The remote management service is not enabled on the target",
  "transport-not-permitted": "The VTY lines do not permit that transport",
  "session-limit": "The remote session limit was reached",
  "idle-timeout": "A remote session was closed by its exec-timeout",
  "management-interface-down": "The management interface went down during a remote session",
};

/**
 * Lab-wide management plane.
 *
 * It owns one `RemoteCliService` per manageable device and the client sessions
 * hosts open against them. Both the browser worker and the verifier build it
 * the same way from the same `LabDocument`, so a remote-management result is
 * reproducible in either trust domain.
 */
export class ManagementPlane implements RemoteSessionOpener {
  private readonly services = new Map<string, RemoteCliService>();
  private readonly authenticators = new Map<string, AaaAuthenticationProvider>();
  private readonly clients = new Map<string, RemoteCliClient>();
  private readonly knownHosts = new Map<string, KnownHostStore>();
  private sessionCounter = 0;

  constructor(
    private readonly devices: ReadonlyMap<string, Device>,
    private readonly engine: SimulationEngine,
  ) {
    for (const [deviceId, device] of devices) {
      const managed = managedDeviceOf(device, engine);
      if (!managed) continue;
      const service = new RemoteCliService(managed, () => this.totalSessions() < MANAGEMENT_LIMITS.maximumRemoteSessionsPerLab);
      service.onSessionClosed((_session, reason) => {
        const explanation = CLOSE_PROBLEM[reason];
        if (explanation) this.reportProblem(`${device.name}: ${explanation}.`);
      });
      const aaaState = device instanceof L2Switch || device instanceof Router ? device.aaa : undefined;
      if (aaaState) {
        // One shared decision layer per device: console, VTY, Telnet, SSH and
        // AAA local fallback all resolve through it.
        const provider = new AaaAuthenticationProvider(
          managed,
          () => aaaState,
          () => this.accessOf(deviceId),
          (index) => service.vtyLineConfig(index),
        );
        service.useAuthenticationProvider(provider, {
          authorizeCommand: (request, done) => provider.authorizeCommand(request, done),
          account: (event, session, detail) => provider.account(event, session, detail),
        });
        provider.onProblem((message) => this.reportProblem(message));
        this.authenticators.set(deviceId, provider);
      }
      this.services.set(deviceId, service);
    }
  }

  /** Apply persisted configuration for one device and re-arm its listeners. */
  configureDevice(
    deviceId: string,
    remote: RemoteAccessConfiguration | undefined,
    access: ConsoleAccessConfiguration | undefined,
  ): void {
    this.consoleAccess.set(deviceId, access);
    this.services.get(deviceId)?.configure(remote, access);
  }

  /** AAA status for inspection: method lists, servers, health, sessions. */
  aaaStatus(deviceId: string): AaaStatusView | undefined {
    return this.authenticators.get(deviceId)?.status();
  }

  private readonly consoleAccess = new Map<string, ConsoleAccessConfiguration | undefined>();

  private accessOf(deviceId: string): ConsoleAccessConfiguration | undefined {
    return this.consoleAccess.get(deviceId);
  }

  serviceOf(deviceId: string): RemoteCliService | undefined {
    return this.services.get(deviceId);
  }

  managedDeviceIds(): string[] {
    return [...this.services.keys()].sort((a, b) => a.localeCompare(b));
  }

  /** Every session terminated anywhere in the lab, in stable order. */
  sessions(): Array<RemoteSessionSummary & { readonly deviceId: string }> {
    return this.managedDeviceIds().flatMap((deviceId) =>
      (this.services.get(deviceId)?.sessionSummaries() ?? []).map((session) => ({ ...session, deviceId })));
  }

  totalSessions(): number {
    return this.sessions().length;
  }

  /** Push queued output after the shared event queue has been drained. */
  completeDeferredOperations(): void {
    for (const service of this.services.values()) service.completeDeferredOperations();
  }

  /** Apply `exec-timeout` after the learner advanced virtual time explicitly. */
  enforceIdleTimeouts(): void {
    for (const service of this.services.values()) service.enforceIdleTimeouts();
  }

  /**
   * Give every SNMP agent a fresh trap budget.
   *
   * Each Auto run is one bounded operation, exactly like the control-protocol
   * event budget, so a long session can never exhaust the trap allowance by
   * accident — while a single flapping link still cannot flood one operation.
   */
  resetTrapBudgets(): void {
    for (const device of this.devices.values()) {
      if (device instanceof L2Switch || device instanceof Router) device.snmp.resetOperationBudget();
    }
  }

  /** Emit `coldStart` once the lab is running, from every enabled agent. */
  startSnmpAgents(): void {
    for (const device of this.devices.values()) {
      if (device instanceof L2Switch || device instanceof Router) device.snmp.start();
    }
  }

  /** Close everything: Stop Lab, rebuild, or a removed device. */
  closeAll(reason: RemoteCloseReason = "cleared-by-administrator"): void {
    for (const service of this.services.values()) service.closeAll(reason);
    for (const client of this.clients.values()) client.close(reason);
    this.clients.clear();
  }

  /** Close only what one device owns or originated. */
  closeForDevice(deviceId: string, reason: RemoteCloseReason): void {
    this.services.get(deviceId)?.closeAll(reason);
    for (const [sessionId, client] of [...this.clients]) {
      if (!sessionId.startsWith(`${deviceId}:`)) continue;
      client.close(reason);
      this.clients.delete(sessionId);
    }
  }

  /**
   * Bounded, learner-facing management problems.
   *
   * They explain *why* a management action failed — no route, blocked port,
   * SSH not configured, no free VTY line, login rejected, AAA server
   * unreachable, invalid community — and never contain a secret value.
   */
  problems(): string[] {
    return [...this.problemMessages];
  }

  /** @internal */
  reportProblem(message: string): void {
    if (this.problemMessages.includes(message)) return;
    this.problemMessages.push(message);
    if (this.problemMessages.length > MANAGEMENT_PROBLEM_LIMIT) this.problemMessages.shift();
  }

  clearProblems(): void {
    this.problemMessages.length = 0;
  }

  private readonly problemMessages: string[] = [];

  knownHostsOf(deviceId: string): KnownHostStore {
    const existing = this.knownHosts.get(deviceId);
    if (existing) return existing;
    const store = new KnownHostStore();
    this.knownHosts.set(deviceId, store);
    return store;
  }

  clientOf(sessionId: string): RemoteCliClient | undefined {
    return this.clients.get(sessionId);
  }

  clientSessions(): RemoteCliClient[] {
    return [...this.clients.values()];
  }

  // --- CLI inspection (`show users`, `show line`, `clear line vty`) ---------

  sessionsOf(deviceId: string): RemoteSessionSummaryView[] {
    return (this.services.get(deviceId)?.sessionSummaries() ?? []).map((session) => ({
      line: session.line,
      protocol: session.protocol,
      username: session.username,
      peerAddress: session.peerAddress,
      clientHostname: session.clientHostname,
      idleForNs: session.idleForNs,
    }));
  }

  linesOf(deviceId: string): RemoteLineSummary[] {
    const service = this.services.get(deviceId);
    if (!service) return [];
    return service.vtyRows().map((row) => {
      const config = service.vtyLineConfig(row.index);
      return {
        index: row.index,
        state: row.state,
        protocol: row.protocol,
        username: row.username,
        peerAddress: row.peerAddress,
        idleForNs: row.idleForNs,
        transports: config?.transports ?? [],
        loginMode: config?.loginMode ?? "none",
        execTimeoutSeconds: config?.execTimeoutSeconds ?? 0,
      };
    });
  }

  clearLine(deviceId: string, index: number): boolean {
    return this.services.get(deviceId)?.clearLine(index) ?? false;
  }

  // --- RemoteSessionOpener --------------------------------------------------

  open(deviceId: string, request: RemoteSessionRequest): RemoteSessionBridge {
    const host = this.devices.get(deviceId);
    if (!(host instanceof EndHost)) {
      throw new Error("Only a PC, Laptop or Server can open a remote CLI session");
    }
    if (this.totalSessions() >= MANAGEMENT_LIMITS.maximumRemoteSessionsPerLab) {
      throw new Error("The lab remote-session limit has been reached");
    }
    const target = this.resolveTarget(request.target);
    const sessionId = `${deviceId}:${request.protocol}:${++this.sessionCounter}`;
    const client = new RemoteCliClient(host, sessionId, {
      protocol: request.protocol,
      targetAddress: target.address,
      port: request.port,
      username: request.username,
      knownHosts: this.knownHostsOf(deviceId),
    });
    this.clients.set(sessionId, client);
    return new RemoteClientBridge(client, target.label, () => this.clients.delete(sessionId));
  }

  /**
   * Resolve what the learner typed. A literal IPv4/IPv6 address is used as-is;
   * a name is matched against managed device hostnames so `telnet SW1` works in
   * a classroom lab without a DNS server. Nothing here reaches a real network.
   */
  private resolveTarget(target: string): { address: IpAddress; label: string } {
    const trimmed = target.trim();
    const bracketed = /^\[(.+)\]$/u.exec(trimmed);
    const candidate = bracketed?.[1] ?? trimmed;
    if (candidate.includes(":")) return { address: normalizeIpv6(candidate), label: candidate };
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(candidate)) return { address: candidate, label: candidate };
    const wanted = candidate.toLowerCase();
    for (const device of this.devices.values()) {
      if (device.name.toLowerCase() !== wanted) continue;
      const managed = device instanceof L2Switch || device instanceof Router
        ? managedDeviceOf(device, this.engine)
        : undefined;
      const address = managed?.addresses().find((entry) => ipFamilyOf(entry) === "ipv4") ?? managed?.addresses()[0];
      if (address) return { address, label: device.name };
      break;
    }
    throw new Error(`Unknown host '${trimmed}'`);
  }
}

/** Adapts a `RemoteCliClient` to the structural bridge `cli-engine` expects. */
class RemoteClientBridge implements RemoteSessionBridge {
  readonly label: string;

  constructor(
    private readonly client: RemoteCliClient,
    targetLabel: string,
    private readonly onFinished: () => void,
  ) {
    this.label = `${client.protocol === "ssh" ? "SSH" : "Telnet"} ${targetLabel}`;
  }

  connect(): void {
    this.client.connect();
  }

  submit(line: string, credential?: string): void {
    this.client.submit(line, credential);
  }

  drain(): string {
    const text = this.client.drainOutput();
    if (this.client.isClosed) this.onFinished();
    return text;
  }

  awaitingResponse(): boolean {
    return this.client.awaitingResponse();
  }

  prompt(): string {
    const view = this.client.view();
    if (view.state === "host-key-confirmation") return "Continue connecting (yes/no)?";
    return view.prompt;
  }

  expectsSecret(): boolean {
    return this.client.view().secret;
  }

  credentialScope(): string | undefined {
    return this.client.view().credentialScope;
  }

  isClosed(): boolean {
    return this.client.isClosed;
  }

  close(): void {
    this.client.close();
    this.onFinished();
  }
}
