import type { SimulationEngine } from "../engine/simulation-engine";
import {
  BGP_TCP_PORT,
  BGP_VERSION,
  isBgpMessage,
  type BgpMessage,
  type BgpNotificationMessage,
} from "../packets/bgp";
import type { TcpApplicationPayload } from "../packets/tcp";
import { TcpState, type TcpConnection, type TcpConnectionHandlers } from "../transport/tcp";
import type { HostTransportStack } from "../transport/host-transport";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";

export const DEFAULT_BGP_KEEPALIVE_SECONDS = 60;
export const DEFAULT_BGP_HOLD_SECONDS = 180;

export type BgpSessionState =
  | "idle"
  | "connect"
  | "active"
  | "open-sent"
  | "open-confirm"
  | "established";

export interface BgpNeighborConfiguration {
  readonly address: Ipv4;
  readonly remoteAs: number;
  readonly description?: string;
  readonly updateSource?: string;
  readonly ebgpMultihop?: number;
  readonly enabled?: boolean;
}

export interface BgpConfiguration {
  readonly localAs: number;
  readonly routerId?: Ipv4;
  readonly keepaliveSeconds?: number;
  readonly holdTimeSeconds?: number;
  readonly neighbors?: readonly BgpNeighborConfiguration[];
}

export interface BgpNeighborSummary {
  readonly address: Ipv4;
  readonly remoteAs: number;
  readonly state: BgpSessionState;
  readonly description?: string;
  readonly localAddress?: Ipv4;
  readonly negotiatedHoldTimeSeconds?: number;
  readonly lastError?: string;
  readonly messagesSent: number;
  readonly messagesReceived: number;
}

export interface BgpHost {
  readonly id: string;
  readonly engine: SimulationEngine;
  readonly management: HostTransportStack;
  bgpSourceAddress(remoteAddress: Ipv4, updateSource?: string): Ipv4 | undefined;
  bgpOwnsAddress(address: Ipv4): boolean;
  bgpRouteReachable(address: Ipv4): boolean;
}

interface NeighborRuntime {
  configuration: BgpNeighborConfiguration;
  state: BgpSessionState;
  connection?: TcpConnection;
  localAddress?: Ipv4;
  negotiatedHoldTimeSeconds?: number;
  lastReceivedAtNs?: number;
  lastError?: string;
  messagesSent: number;
  messagesReceived: number;
  generation: number;
}

function validateAsn(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`${field} must be between 1 and 4294967295`, field);
  }
}

function validateTimer(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ControlProtocolConfigurationError(`${field} must be between 0 and ${maximum} seconds`, field);
  }
}

/**
 * Deterministic educational BGPv4 session layer. It deliberately carries
 * structured messages over the shared simulated TCP stack: reachability,
 * ACL/firewall policy, TCP retransmission and IP TTL therefore remain real
 * parts of the simulation instead of direct process-to-process calls.
 */
export class BgpProcess {
  private configuration: BgpConfiguration | undefined;
  private readonly neighbors = new Map<Ipv4, NeighborRuntime>();
  private listening = false;

  constructor(private readonly host: BgpHost) {}

  get enabled(): boolean {
    return this.configuration !== undefined;
  }

  get localAs(): number | undefined {
    return this.configuration?.localAs;
  }

  configure(configuration: BgpConfiguration): void {
    validateAsn(configuration.localAs, "localAs");
    const keepaliveSeconds = configuration.keepaliveSeconds ?? DEFAULT_BGP_KEEPALIVE_SECONDS;
    const holdTimeSeconds = configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
    validateTimer(keepaliveSeconds, "keepaliveSeconds", 65_535);
    validateTimer(holdTimeSeconds, "holdTimeSeconds", 65_535);
    if (holdTimeSeconds !== 0 && keepaliveSeconds * 3 > holdTimeSeconds) {
      throw new ControlProtocolConfigurationError(
        "BGP hold time must be zero or at least three times the keepalive time",
        "holdTimeSeconds",
      );
    }
    if (configuration.routerId !== undefined) ipToInt(configuration.routerId);
    const configured = [...(configuration.neighbors ?? [])];
    enforceStructuralLimit("maximumBgpPeersPerDevice", configured.length);
    const seen = new Set<string>();
    for (const neighbor of configured) {
      ipToInt(neighbor.address);
      validateAsn(neighbor.remoteAs, "remoteAs");
      if (seen.has(neighbor.address)) {
        throw new ControlProtocolConfigurationError(`Duplicate BGP neighbor ${neighbor.address}`, "neighbors");
      }
      seen.add(neighbor.address);
      if (neighbor.ebgpMultihop !== undefined
        && (!Number.isInteger(neighbor.ebgpMultihop) || neighbor.ebgpMultihop < 1 || neighbor.ebgpMultihop > 255)) {
        throw new ControlProtocolConfigurationError("eBGP multihop TTL must be between 1 and 255", "ebgpMultihop");
      }
    }
    this.resetRuntime(false);
    this.configuration = { ...configuration, keepaliveSeconds, holdTimeSeconds, neighbors: configured };
    this.neighbors.clear();
    for (const neighbor of configured.sort((a, b) => ipToInt(a.address) - ipToInt(b.address))) {
      this.neighbors.set(neighbor.address, {
        configuration: { ...neighbor },
        state: "idle",
        messagesSent: 0,
        messagesReceived: 0,
        generation: 0,
      });
    }
    this.start();
  }

  disable(): void {
    this.resetRuntime(true);
    this.configuration = undefined;
    this.neighbors.clear();
  }

  start(): void {
    if (!this.configuration) return;
    this.ensureListener();
    for (const runtime of this.neighbors.values()) this.tryConnect(runtime);
  }

  restart(address?: Ipv4): void {
    const selected = address === undefined ? [...this.neighbors.values()] : [this.requireNeighbor(address)];
    for (const runtime of selected) {
      runtime.connection?.abort();
      runtime.connection = undefined;
      runtime.lastError = undefined;
      runtime.generation++;
      this.transition(runtime, "idle", "administrative reset");
      this.tryConnect(runtime);
    }
  }

  onInterfaceStateChanged(): void {
    for (const runtime of this.neighbors.values()) {
      if (runtime.state === "established" && !this.host.bgpRouteReachable(runtime.configuration.address)) {
        this.fail(runtime, "transport route unavailable");
      } else if (runtime.state !== "established") {
        this.tryConnect(runtime);
      }
    }
  }

  summaries(): BgpNeighborSummary[] {
    return [...this.neighbors.values()]
      .map((runtime) => ({
        address: runtime.configuration.address,
        remoteAs: runtime.configuration.remoteAs,
        state: runtime.state,
        description: runtime.configuration.description,
        localAddress: runtime.localAddress,
        negotiatedHoldTimeSeconds: runtime.negotiatedHoldTimeSeconds,
        lastError: runtime.lastError,
        messagesSent: runtime.messagesSent,
        messagesReceived: runtime.messagesReceived,
      }))
      .sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
  }

  configurationSnapshot(): BgpConfiguration | undefined {
    if (!this.configuration) return undefined;
    return {
      ...this.configuration,
      neighbors: [...(this.configuration.neighbors ?? [])].map((neighbor) => ({ ...neighbor })),
    };
  }

  outboundTtl(remoteAddress: Ipv4): number | undefined {
    const runtime = this.neighbors.get(remoteAddress);
    if (!runtime || !this.configuration) return undefined;
    return runtime.configuration.remoteAs === this.configuration.localAs
      ? 64
      : (runtime.configuration.ebgpMultihop ?? 1);
  }

  private ensureListener(): void {
    if (this.listening) return;
    try {
      this.host.management.tcp.listen(BGP_TCP_PORT, (connection) => this.accept(connection), "bgp");
      this.listening = true;
    } catch (error) {
      this.trace("bgp-session-rejected", { reason: error instanceof Error ? error.message : "TCP port unavailable" });
    }
  }

  private tryConnect(runtime: NeighborRuntime): void {
    if (!this.configuration || runtime.configuration.enabled === false || runtime.connection) return;
    const localAddress = this.host.bgpSourceAddress(runtime.configuration.address, runtime.configuration.updateSource);
    if (localAddress === undefined) {
      runtime.lastError = runtime.configuration.updateSource
        ? `update-source ${runtime.configuration.updateSource} has no usable IPv4 address`
        : "no usable local IPv4 address";
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    runtime.localAddress = localAddress;
    if (!this.host.bgpRouteReachable(runtime.configuration.address)) {
      runtime.lastError = "neighbor is not reachable through the IPv4 routing table";
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    // Exactly one side actively opens a symmetric session. The lower endpoint
    // wins, avoiding duplicate TCP sessions without randomness.
    if (ipToInt(localAddress) > ipToInt(runtime.configuration.address)) {
      this.transition(runtime, "active", "waiting for deterministic passive open");
      return;
    }
    this.transition(runtime, "connect");
    const handlers = this.handlers(runtime);
    try {
      runtime.connection = this.host.management.tcp.connect(
        runtime.configuration.address,
        BGP_TCP_PORT,
        handlers,
        "bgp",
        localAddress,
      );
    } catch (error) {
      runtime.connection = undefined;
      runtime.lastError = error instanceof Error ? error.message : "TCP open failed";
      this.transition(runtime, "active", runtime.lastError);
    }
  }

  private accept(connection: TcpConnection): void {
    const remote = connection.remoteAddress as Ipv4;
    const runtime = this.neighbors.get(remote);
    if (!runtime || runtime.configuration.enabled === false || !this.host.bgpOwnsAddress(connection.localAddress as Ipv4)) {
      connection.setHandlers({ onEstablished: (established) => established.close() });
      this.trace("bgp-session-rejected", { neighbor: remote, reason: "unconfigured neighbor" });
      return;
    }
    runtime.connection?.abort();
    runtime.connection = connection;
    runtime.localAddress = connection.localAddress as Ipv4;
    connection.setHandlers(this.handlers(runtime));
    this.onTcpEstablished(runtime, connection);
  }

  private handlers(runtime: NeighborRuntime): TcpConnectionHandlers {
    return {
      onEstablished: (connection) => this.onTcpEstablished(runtime, connection),
      onMessage: (payload, connection) => this.onTcpMessage(runtime, payload, connection),
      onClosed: () => this.onTcpClosed(runtime, "TCP connection closed"),
      onReset: () => this.onTcpClosed(runtime, "TCP connection reset"),
    };
  }

  private onTcpEstablished(runtime: NeighborRuntime, connection: TcpConnection): void {
    if (runtime.connection !== connection || connection.state !== TcpState.Established || !this.configuration) return;
    this.transition(runtime, "open-sent");
    this.send(runtime, {
      kind: "bgp-open",
      version: BGP_VERSION,
      localAs: this.configuration.localAs,
      holdTimeSeconds: this.configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS,
      bgpIdentifier: this.configuration.routerId ?? runtime.localAddress ?? "0.0.0.0",
    });
  }

  private onTcpMessage(runtime: NeighborRuntime, payload: unknown, connection: TcpConnection): void {
    if (runtime.connection !== connection
      || typeof payload !== "object" || payload === null
      || (payload as { kind?: unknown }).kind !== "tcp-application"
      || (payload as TcpApplicationPayload).protocol !== "bgp"
      || !isBgpMessage((payload as TcpApplicationPayload).data)) {
      this.notifyAndFail(runtime, "message-header", "invalid-message", "Malformed BGP message");
      return;
    }
    const message = (payload as TcpApplicationPayload).data as BgpMessage;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.messagesReceived++;
    runtime.lastReceivedAtNs = this.host.engine.now();
    this.trace("bgp-message-received", { neighbor: runtime.configuration.address, messageType: message.kind });
    if (message.kind === "bgp-open") {
      if (runtime.state !== "open-sent") {
        this.notifyAndFail(runtime, "open-message", "unexpected-open", "Unexpected OPEN message");
        return;
      }
      if (message.version !== BGP_VERSION || message.localAs !== runtime.configuration.remoteAs) {
        this.notifyAndFail(runtime, "open-message", "bad-peer-as", "Remote AS does not match neighbor configuration");
        return;
      }
      const localHold = this.configuration?.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
      runtime.negotiatedHoldTimeSeconds = Math.min(localHold, message.holdTimeSeconds);
      this.transition(runtime, "open-confirm");
      this.send(runtime, { kind: "bgp-keepalive" });
      return;
    }
    if (message.kind === "bgp-keepalive") {
      if (runtime.state === "open-confirm") {
        this.transition(runtime, "established");
        this.trace("bgp-session-established", { neighbor: runtime.configuration.address });
      }
      return;
    }
    if (message.kind === "bgp-notification") {
      this.fail(runtime, `${message.code}/${message.subcode}: ${message.message}`);
      return;
    }
    if (runtime.state !== "established") {
      this.notifyAndFail(runtime, "update-message", "unexpected-update", "UPDATE received before Established");
      return;
    }
    this.trace("bgp-update-received", {
      neighbor: runtime.configuration.address,
      announced: message.nlri.length,
      withdrawn: message.withdrawn.length,
    });
  }

  private send(runtime: NeighborRuntime, message: BgpMessage): void {
    if (!runtime.connection || runtime.connection.state !== TcpState.Established) return;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.connection.send({ kind: "tcp-application", protocol: "bgp", data: message });
    runtime.messagesSent++;
    this.trace(message.kind === "bgp-update" ? "bgp-update-sent" : "bgp-message-sent", {
      neighbor: runtime.configuration.address,
      messageType: message.kind,
    });
  }

  private notifyAndFail(
    runtime: NeighborRuntime,
    code: BgpNotificationMessage["code"],
    subcode: string,
    message: string,
  ): void {
    this.send(runtime, { kind: "bgp-notification", code, subcode, message });
    this.trace("bgp-notification", { neighbor: runtime.configuration.address, code, subcode, message });
    this.fail(runtime, message);
  }

  private onTcpClosed(runtime: NeighborRuntime, reason: string): void {
    if (!runtime.connection) return;
    runtime.connection = undefined;
    this.fail(runtime, reason, false);
  }

  private fail(runtime: NeighborRuntime, reason: string, abort = true): void {
    const connection = runtime.connection;
    runtime.connection = undefined;
    runtime.lastError = reason;
    runtime.generation++;
    if (abort) connection?.abort();
    this.transition(runtime, "idle", reason);
    this.trace("bgp-session-failed", { neighbor: runtime.configuration.address, reason });
  }

  private transition(runtime: NeighborRuntime, state: BgpSessionState, reason?: string): void {
    if (runtime.state === state) return;
    const previous = runtime.state;
    this.host.engine.controlProtocolBudget.consume("bgpStateTransitions", this.host.id);
    runtime.state = state;
    this.trace("bgp-state-changed", { neighbor: runtime.configuration.address, previous, state, reason });
  }

  private requireNeighbor(address: Ipv4): NeighborRuntime {
    const neighbor = this.neighbors.get(address);
    if (!neighbor) throw new ControlProtocolConfigurationError(`BGP neighbor ${address} is not configured`, "neighbor");
    return neighbor;
  }

  private resetRuntime(removeListener: boolean): void {
    for (const runtime of this.neighbors.values()) runtime.connection?.abort();
    if (removeListener && this.listening) {
      this.host.management.tcp.unlisten(BGP_TCP_PORT);
      this.listening = false;
    }
  }

  private trace(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.host.engine.trace({ time: this.host.engine.now(), type, device: this.host.id, detail });
  }
}
