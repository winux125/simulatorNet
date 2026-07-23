import {
  DEFAULT_TCP_RETRANSMISSION_TIMEOUT_NS,
  DEFAULT_TRANSPORT_LIMITS,
  EPHEMERAL_PORT_END,
  EPHEMERAL_PORT_START,
  type TransportLimits,
} from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { TcpPayload, TcpSegment } from "../packets/tcp";
import type { Ipv4 } from "../util/ipv4";
import { TransportError, payloadByteLength, validateTransportPort } from "./errors";

export const TcpState = {
  Closed: "CLOSED",
  Listen: "LISTEN",
  SynSent: "SYN_SENT",
  SynReceived: "SYN_RECEIVED",
  Established: "ESTABLISHED",
  FinWait: "FIN_WAIT",
  CloseWait: "CLOSE_WAIT",
  LastAck: "LAST_ACK",
  TimeWait: "TIME_WAIT",
} as const;
export type TcpState = (typeof TcpState)[keyof typeof TcpState];

export interface TcpConnectionHandlers {
  readonly onEstablished?: (connection: TcpConnection) => void;
  readonly onMessage?: (payload: TcpPayload, connection: TcpConnection) => void;
  readonly onClosed?: (connection: TcpConnection) => void;
  readonly onReset?: (connection: TcpConnection) => void;
}

export type TcpAcceptListener = (connection: TcpConnection) => void;

export interface TcpConnectionInspection {
  readonly localAddress: Ipv4;
  readonly localPort: number;
  readonly remoteAddress: Ipv4;
  readonly remotePort: number;
  readonly state: TcpState;
  readonly service: string;
}

interface OutstandingSegment {
  readonly segment: TcpSegment;
  retries: number;
  generation: number;
}

interface TcpListenerEntry {
  readonly accept: TcpAcceptListener;
  readonly service: string;
}

export interface TcpHostAdapter {
  readonly deviceId: string;
  readonly engine: () => SimulationEngine;
  readonly localAddress: () => Ipv4 | undefined;
  readonly send: (destinationAddress: Ipv4, segment: TcpSegment, sourceAddress?: Ipv4) => void;
}

/** One deterministic, message-oriented TCP connection. */
export class TcpConnection {
  state: TcpState = TcpState.Closed;
  private handlers: TcpConnectionHandlers;
  private sendNext: number;
  private receiveNext = 0;
  private outstanding: OutstandingSegment | undefined;
  private readonly queuedPayloads: TcpPayload[] = [];
  private closeRequested = false;
  private accepted = false;

  constructor(
    private readonly stack: TcpSocketRegistry,
    readonly localAddress: Ipv4,
    readonly localPort: number,
    readonly remoteAddress: Ipv4,
    readonly remotePort: number,
    readonly service: string,
    initialSequence: number,
    handlers: TcpConnectionHandlers = {},
  ) {
    this.sendNext = initialSequence >>> 0;
    this.handlers = handlers;
  }

  setHandlers(handlers: TcpConnectionHandlers): void {
    this.handlers = handlers;
  }

  send(payload: TcpPayload): void {
    if (this.state !== TcpState.Established) {
      throw new TransportError("not-connected", `TCP connection is ${this.state}, not ESTABLISHED`);
    }
    if (payloadByteLength(payload) > this.stack.limits.maximumApplicationPayloadBytes) {
      throw new TransportError("payload-too-large", "TCP application payload exceeds the configured limit");
    }
    if (this.outstanding || this.queuedPayloads.length > 0) {
      if (this.queuedPayloads.length >= this.stack.limits.maximumQueuedMessages) {
        throw new TransportError("message-queue-limit", "TCP application message queue limit exceeded");
      }
      this.queuedPayloads.push(payload);
      return;
    }
    this.sendPayload(payload);
  }

  close(): void {
    if (this.state === TcpState.Closed || this.state === TcpState.TimeWait || this.closeRequested) return;
    this.closeRequested = true;
    this.flushOrClose();
  }

  /** Immediately invalidate a connection during host runtime reconfiguration. */
  abort(): void {
    if (this.state === TcpState.Closed) return;
    this.outstanding = undefined;
    this.queuedPayloads.length = 0;
    this.closeRequested = true;
    this.transition(TcpState.Closed);
    this.handlers.onReset?.(this);
    this.stack.remove(this);
  }

  /** @internal */
  activeOpen(): void {
    this.transition(TcpState.SynSent);
    this.sendReliable({ syn: true });
  }

  /** @internal */
  passiveOpen(segment: TcpSegment): void {
    this.receiveNext = (segment.sequence + 1) >>> 0;
    this.transition(TcpState.SynReceived);
    this.sendReliable({ syn: true, ack: true, acknowledgment: this.receiveNext });
  }

  /** @internal */
  receive(segment: TcpSegment): void {
    this.stack.trace("tcp-segment-received", this, {
      syn: !!segment.syn,
      ack: !!segment.ack,
      fin: !!segment.fin,
      rst: !!segment.rst,
      sequence: segment.sequence,
    });
    if (segment.rst) {
      this.outstanding = undefined;
      this.transition(TcpState.Closed);
      this.stack.trace("tcp-reset", this);
      this.handlers.onReset?.(this);
      this.stack.remove(this);
      return;
    }
    if (segment.ack) this.acceptAcknowledgment(segment.acknowledgment);

    if (this.state === TcpState.SynSent && segment.syn && segment.ack) {
      this.receiveNext = (segment.sequence + 1) >>> 0;
      this.sendAck();
      this.transition(TcpState.Established);
      this.stack.trace("tcp-connection-established", this);
      this.handlers.onEstablished?.(this);
      return;
    }
    if (this.state === TcpState.SynReceived && segment.ack && !segment.syn) {
      this.transition(TcpState.Established);
      this.stack.trace("tcp-connection-established", this);
      if (!this.accepted) {
        this.accepted = true;
        this.stack.accept(this);
      }
    }
    if (segment.payload && this.state === TcpState.Established) {
      if (segment.sequence === this.receiveNext) {
        this.receiveNext = (this.receiveNext + 1) >>> 0;
        this.handlers.onMessage?.(segment.payload, this);
      }
      this.sendAck();
    }
    if (segment.fin) this.receiveFin(segment);
  }

  /** @internal */
  timeout(expectedGeneration: number): void {
    const pending = this.outstanding;
    if (!pending || pending.generation !== expectedGeneration) return;
    if (pending.retries >= this.stack.limits.maximumRetransmissions) {
      this.outstanding = undefined;
      this.transition(TcpState.Closed);
      this.stack.trace("tcp-timeout", this, { retries: pending.retries });
      this.handlers.onClosed?.(this);
      this.stack.remove(this);
      return;
    }
    pending.retries++;
    pending.generation++;
    this.stack.trace("tcp-retransmission", this, { retries: pending.retries });
    this.stack.sendSegment(this, pending.segment);
    this.stack.scheduleTimeout(this, pending.generation);
  }

  private sendPayload(payload: TcpPayload): void {
    this.sendReliable({ ack: true, acknowledgment: this.receiveNext, payload });
  }

  private sendReliable(fields: Partial<TcpSegment>): void {
    const sequence = this.sendNext;
    const segment: TcpSegment = {
      kind: "tcp",
      srcPort: this.localPort,
      dstPort: this.remotePort,
      sequence,
      acknowledgment: fields.acknowledgment ?? 0,
      syn: fields.syn,
      ack: fields.ack,
      fin: fields.fin,
      payload: fields.payload,
    };
    this.sendNext = (this.sendNext + 1) >>> 0;
    this.outstanding = { segment, retries: 0, generation: 1 };
    this.stack.sendSegment(this, segment);
    this.stack.scheduleTimeout(this, 1);
  }

  private sendAck(): void {
    this.stack.sendSegment(this, {
      kind: "tcp",
      srcPort: this.localPort,
      dstPort: this.remotePort,
      sequence: this.sendNext,
      acknowledgment: this.receiveNext,
      ack: true,
    });
  }

  private acceptAcknowledgment(acknowledgment: number): void {
    const pending = this.outstanding;
    if (!pending || acknowledgment !== ((pending.segment.sequence + 1) >>> 0)) return;
    this.outstanding = undefined;
    if (this.state === TcpState.LastAck && pending.segment.fin) {
      this.transition(TcpState.Closed);
      this.stack.trace("tcp-connection-closed", this);
      this.handlers.onClosed?.(this);
      this.stack.remove(this);
      return;
    }
    this.flushOrClose();
  }

  private flushOrClose(): void {
    if (this.outstanding) return;
    const next = this.queuedPayloads.shift();
    if (next) {
      this.sendPayload(next);
      return;
    }
    if (!this.closeRequested) return;
    if (this.state === TcpState.Established) {
      this.transition(TcpState.FinWait);
      this.sendReliable({ fin: true, ack: true, acknowledgment: this.receiveNext });
    } else if (this.state === TcpState.CloseWait) {
      this.transition(TcpState.LastAck);
      this.sendReliable({ fin: true, ack: true, acknowledgment: this.receiveNext });
    }
  }

  private receiveFin(segment: TcpSegment): void {
    if (segment.sequence === this.receiveNext) this.receiveNext = (this.receiveNext + 1) >>> 0;
    this.sendAck();
    if (this.state === TcpState.FinWait) {
      this.transition(TcpState.TimeWait);
      this.stack.enterTimeWait(this);
      return;
    }
    if (this.state === TcpState.Established) {
      this.transition(TcpState.CloseWait);
      this.closeRequested = true;
      this.flushOrClose();
    }
  }

  private transition(state: TcpState): void {
    if (this.state === state) return;
    const previous = this.state;
    this.state = state;
    this.stack.trace("tcp-state-changed", this, { previous, state });
  }

  /** @internal */
  finishTimeWait(): void {
    if (this.state !== TcpState.TimeWait) return;
    this.transition(TcpState.Closed);
    this.stack.trace("tcp-connection-closed", this);
    this.handlers.onClosed?.(this);
    this.stack.remove(this);
  }
}

/** Per-host TCP listener/connection registry. */
export class TcpSocketRegistry {
  readonly limits: TransportLimits;
  private readonly listeners = new Map<number, TcpListenerEntry>();
  private readonly connections = new Map<string, TcpConnection>();
  private nextEphemeralPort = EPHEMERAL_PORT_START;

  constructor(
    private readonly host: TcpHostAdapter,
    limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
  ) {
    this.limits = limits;
  }

  listen(port: number, accept: TcpAcceptListener, service = "application"): void {
    validateTransportPort(port);
    if (this.listeners.has(port)) {
      throw new TransportError("address-in-use", `TCP port ${port} is already listening on ${this.host.deviceId}`);
    }
    if (this.listeners.size >= this.limits.maximumTcpListeners) {
      throw new TransportError("socket-limit", `TCP listener limit exceeded on ${this.host.deviceId}`);
    }
    this.listeners.set(port, { accept, service });
  }

  unlisten(port: number): boolean {
    validateTransportPort(port);
    return this.listeners.delete(port);
  }

  connect(
    remoteAddress: Ipv4,
    remotePort: number,
    handlers: TcpConnectionHandlers = {},
    service = "application",
  ): TcpConnection {
    validateTransportPort(remotePort);
    const localAddress = this.requireLocalAddress();
    const localPort = this.allocateEphemeralPort();
    this.requireConnectionCapacity();
    const connection = new TcpConnection(
      this,
      localAddress,
      localPort,
      remoteAddress,
      remotePort,
      service,
      this.host.engine().rng.nextU32(),
      handlers,
    );
    this.connections.set(this.key(localAddress, localPort, remoteAddress, remotePort), connection);
    connection.activeOpen();
    return connection;
  }

  receive(sourceAddress: Ipv4, destinationAddress: Ipv4, segment: TcpSegment): void {
    const key = this.key(destinationAddress, segment.dstPort, sourceAddress, segment.srcPort);
    const existing = this.connections.get(key);
    if (existing) {
      existing.receive(segment);
      return;
    }
    const listener = this.listeners.get(segment.dstPort);
    if (segment.syn && !segment.ack && listener) {
      this.requireConnectionCapacity();
      const connection = new TcpConnection(
        this,
        destinationAddress,
        segment.dstPort,
        sourceAddress,
        segment.srcPort,
        listener.service,
        this.host.engine().rng.nextU32(),
      );
      this.connections.set(key, connection);
      this.trace("tcp-segment-received", connection, { syn: true, sequence: segment.sequence });
      connection.passiveOpen(segment);
      return;
    }
    if (!segment.rst) this.sendReset(sourceAddress, destinationAddress, segment);
  }

  inspect(): TcpConnectionInspection[] {
    const listeners: TcpConnectionInspection[] = [...this.listeners.entries()].map(([localPort, entry]) => ({
      localAddress: this.host.localAddress() ?? "0.0.0.0",
      localPort,
      remoteAddress: "0.0.0.0",
      remotePort: 0,
      state: TcpState.Listen,
      service: entry.service,
    }));
    const connections = [...this.connections.values()].map((connection) => ({
      localAddress: connection.localAddress,
      localPort: connection.localPort,
      remoteAddress: connection.remoteAddress,
      remotePort: connection.remotePort,
      state: connection.state,
      service: connection.service,
    }));
    return [...listeners, ...connections].sort((a, b) =>
      a.localPort - b.localPort || a.remoteAddress.localeCompare(b.remoteAddress) || a.remotePort - b.remotePort,
    );
  }

  /** Close active connections and listeners without scheduling network I/O. */
  reset(): void {
    for (const connection of [...this.connections.values()]) connection.abort();
    this.connections.clear();
    this.listeners.clear();
    this.nextEphemeralPort = EPHEMERAL_PORT_START;
  }

  /** @internal */
  accept(connection: TcpConnection): void {
    this.listeners.get(connection.localPort)?.accept(connection);
  }

  /** @internal */
  sendSegment(connection: TcpConnection, segment: TcpSegment): void {
    this.trace("tcp-segment-sent", connection, {
      syn: !!segment.syn,
      ack: !!segment.ack,
      fin: !!segment.fin,
      rst: !!segment.rst,
      sequence: segment.sequence,
    });
    this.host.send(connection.remoteAddress, segment, connection.localAddress);
  }

  /** @internal */
  scheduleTimeout(connection: TcpConnection, generation: number): void {
    this.host.engine().scheduleIn(DEFAULT_TCP_RETRANSMISSION_TIMEOUT_NS, () => connection.timeout(generation));
  }

  /** @internal */
  enterTimeWait(connection: TcpConnection): void {
    this.host.engine().scheduleIn(this.limits.maximumTimeWaitNs, () => connection.finishTimeWait());
  }

  /** @internal */
  remove(connection: TcpConnection): void {
    this.connections.delete(this.key(
      connection.localAddress,
      connection.localPort,
      connection.remoteAddress,
      connection.remotePort,
    ));
  }

  /** @internal */
  trace(type: string, connection: TcpConnection, detail: Record<string, unknown> = {}): void {
    this.host.engine().trace({
      time: this.host.engine().now(),
      type,
      device: this.host.deviceId,
      detail: {
        localAddress: connection.localAddress,
        localPort: connection.localPort,
        remoteAddress: connection.remoteAddress,
        remotePort: connection.remotePort,
        ...detail,
      },
    });
  }

  private sendReset(remoteAddress: Ipv4, localAddress: Ipv4, received: TcpSegment): void {
    const reset: TcpSegment = {
      kind: "tcp",
      srcPort: received.dstPort,
      dstPort: received.srcPort,
      sequence: 0,
      acknowledgment: (received.sequence + 1) >>> 0,
      ack: true,
      rst: true,
    };
    this.host.engine().trace({
      time: this.host.engine().now(),
      type: "tcp-reset",
      device: this.host.deviceId,
      detail: { localAddress, localPort: reset.srcPort, remoteAddress, remotePort: reset.dstPort },
    });
    this.host.send(remoteAddress, reset, localAddress);
  }

  private allocateEphemeralPort(): number {
    const localAddress = this.requireLocalAddress();
    const range = EPHEMERAL_PORT_END - EPHEMERAL_PORT_START + 1;
    for (let offset = 0; offset < range; offset++) {
      const candidate = EPHEMERAL_PORT_START + ((this.nextEphemeralPort - EPHEMERAL_PORT_START + offset) % range);
      const used = [...this.connections.values()].some((connection) =>
        connection.localAddress === localAddress && connection.localPort === candidate,
      );
      if (!used && !this.listeners.has(candidate)) {
        this.nextEphemeralPort = candidate === EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : candidate + 1;
        return candidate;
      }
    }
    throw new TransportError("connection-limit", `No TCP ephemeral ports are available on ${this.host.deviceId}`);
  }

  private requireConnectionCapacity(): void {
    if (this.connections.size >= this.limits.maximumTcpConnections) {
      throw new TransportError("connection-limit", `TCP connection limit exceeded on ${this.host.deviceId}`);
    }
  }

  private requireLocalAddress(): Ipv4 {
    const address = this.host.localAddress();
    if (!address) throw new TransportError("not-connected", `Host ${this.host.deviceId} has no IPv4 address`);
    return address;
  }

  private key(localAddress: Ipv4, localPort: number, remoteAddress: Ipv4, remotePort: number): string {
    return `${localAddress}:${localPort}|${remoteAddress}:${remotePort}`;
  }
}
