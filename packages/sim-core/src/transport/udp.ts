import {
  DEFAULT_TRANSPORT_LIMITS,
  EPHEMERAL_PORT_END,
  EPHEMERAL_PORT_START,
  type TransportLimits,
} from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import type { UdpDatagram, UdpPayload } from "../packets/udp";
import type { IpAddress, IpFamily } from "../util/ip-address";
import { TransportError, payloadByteLength, validateTransportPort } from "./errors";

export interface UdpReceivedDatagram {
  readonly sourceAddress: IpAddress;
  readonly destinationAddress: IpAddress;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly payload: UdpPayload;
}

export type UdpListener = (datagram: UdpReceivedDatagram) => void;

export interface UdpSocketInspection {
  readonly localAddress: IpAddress | undefined;
  readonly localPort: number;
  readonly service: string;
  readonly state: "listening";
}

export interface UdpSendOptions {
  readonly destinationAddress: IpAddress;
  readonly destinationPort: number;
  readonly payload: UdpPayload;
  readonly sourcePort?: number;
  readonly sourceAddress?: IpAddress;
}

interface UdpBinding {
  readonly listener: UdpListener;
  readonly service: string;
}

export interface UdpHostAdapter {
  readonly deviceId: string;
  readonly engine: () => SimulationEngine;
  readonly localAddress: (family: IpFamily, destination?: IpAddress) => IpAddress | undefined;
  readonly send: (destinationAddress: IpAddress, datagram: UdpDatagram, sourceAddress?: IpAddress) => void;
  readonly portUnreachable: (destinationAddress: IpAddress, destinationPort: number) => void;
}

/** Per-host exclusive UDP socket registry and deterministic ephemeral allocator. */
export class UdpSocketRegistry {
  private readonly bindings = new Map<number, UdpBinding>();
  private nextEphemeralPort = EPHEMERAL_PORT_START;

  constructor(
    private readonly host: UdpHostAdapter,
    private readonly limits: TransportLimits = DEFAULT_TRANSPORT_LIMITS,
  ) {}

  bind(port: number, listener: UdpListener, service = "application"): number {
    const selected = port === 0 ? this.allocateEphemeralPort() : port;
    validateTransportPort(selected);
    if (this.bindings.has(selected)) {
      throw new TransportError("address-in-use", `UDP port ${selected} is already bound on ${this.host.deviceId}`);
    }
    if (this.bindings.size >= this.limits.maximumUdpSockets) {
      throw new TransportError("socket-limit", `UDP socket limit exceeded on ${this.host.deviceId}`);
    }
    this.bindings.set(selected, { listener, service });
    return selected;
  }

  unbind(port: number): boolean {
    validateTransportPort(port);
    return this.bindings.delete(port);
  }

  send(options: UdpSendOptions): number {
    validateTransportPort(options.destinationPort);
    const sourcePort = options.sourcePort ?? this.allocateEphemeralPort();
    validateTransportPort(sourcePort);
    if (payloadByteLength(options.payload) > this.limits.maximumApplicationPayloadBytes) {
      throw new TransportError("payload-too-large", "UDP application payload exceeds the configured limit");
    }
    const datagram: UdpDatagram = {
      kind: "udp",
      srcPort: sourcePort,
      dstPort: options.destinationPort,
      payload: options.payload,
    };
    this.host.engine().trace({
      time: this.host.engine().now(),
      type: "udp-datagram-sent",
      device: this.host.deviceId,
      detail: {
        destinationAddress: options.destinationAddress,
        sourcePort,
        destinationPort: options.destinationPort,
        protocol: options.payload.kind,
      },
    });
    this.host.send(options.destinationAddress, datagram, options.sourceAddress);
    return sourcePort;
  }

  receive(sourceAddress: IpAddress, destinationAddress: IpAddress, datagram: UdpDatagram, broadcast: boolean): void {
    const binding = this.bindings.get(datagram.dstPort);
    if (!binding) {
      if (!broadcast) {
        this.host.engine().trace({
          time: this.host.engine().now(),
          type: "udp-port-unreachable",
          device: this.host.deviceId,
          detail: { sourceAddress, destinationPort: datagram.dstPort },
        });
        this.host.portUnreachable(sourceAddress, datagram.dstPort);
      }
      return;
    }
    this.host.engine().trace({
      time: this.host.engine().now(),
      type: "udp-datagram-received",
      device: this.host.deviceId,
      detail: {
        sourceAddress,
        sourcePort: datagram.srcPort,
        destinationPort: datagram.dstPort,
        service: binding.service,
        protocol: datagram.payload.kind,
      },
    });
    binding.listener({
      sourceAddress,
      destinationAddress,
      sourcePort: datagram.srcPort,
      destinationPort: datagram.dstPort,
      payload: datagram.payload,
    });
  }

  inspect(): UdpSocketInspection[] {
    return [...this.bindings.entries()]
      .sort(([a], [b]) => a - b)
      .map(([localPort, binding]) => ({
        localAddress: this.host.localAddress("ipv4") ?? this.host.localAddress("ipv6"),
        localPort,
        service: binding.service,
        state: "listening" as const,
      }));
  }

  /** Drop every transient binding after an address/mode change. */
  reset(): void {
    this.bindings.clear();
    this.nextEphemeralPort = EPHEMERAL_PORT_START;
  }

  private allocateEphemeralPort(): number {
    const range = EPHEMERAL_PORT_END - EPHEMERAL_PORT_START + 1;
    for (let offset = 0; offset < range; offset++) {
      const candidate = EPHEMERAL_PORT_START + ((this.nextEphemeralPort - EPHEMERAL_PORT_START + offset) % range);
      if (!this.bindings.has(candidate)) {
        this.nextEphemeralPort = candidate === EPHEMERAL_PORT_END ? EPHEMERAL_PORT_START : candidate + 1;
        return candidate;
      }
    }
    throw new TransportError("socket-limit", `No UDP ephemeral ports are available on ${this.host.deviceId}`);
  }
}
