import type { TcpSegment } from "../packets/tcp";
import type { UdpDatagram } from "../packets/udp";
import type { IpAddress, IpFamily } from "../util/ip-address";
import type { SimulationEngine } from "../engine/simulation-engine";
import { TcpSocketRegistry, type TcpHostAdapter } from "./tcp";
import { UdpSocketRegistry, type UdpHostAdapter } from "./udp";

export interface HostTransportAdapter {
  readonly deviceId: string;
  readonly engine: () => SimulationEngine;
  readonly localAddress: (family: IpFamily, destination?: IpAddress) => IpAddress | undefined;
  readonly portUnreachable: UdpHostAdapter["portUnreachable"];
  readonly sendUdpPacket: UdpHostAdapter["send"];
  readonly sendTcpPacket: TcpHostAdapter["send"];
}

/** Shared transport facade embedded by both PC and Server end hosts. */
export class HostTransportStack {
  readonly udp: UdpSocketRegistry;
  readonly tcp: TcpSocketRegistry;

  constructor(adapter: HostTransportAdapter) {
    this.udp = new UdpSocketRegistry({
      deviceId: adapter.deviceId,
      engine: adapter.engine,
      localAddress: adapter.localAddress,
      send: adapter.sendUdpPacket,
      portUnreachable: adapter.portUnreachable,
    });
    this.tcp = new TcpSocketRegistry({
      deviceId: adapter.deviceId,
      engine: adapter.engine,
      localAddress: adapter.localAddress,
      send: adapter.sendTcpPacket,
    });
  }

  receiveUdp(sourceAddress: IpAddress, destinationAddress: IpAddress, datagram: UdpDatagram, broadcast: boolean): void {
    this.udp.receive(sourceAddress, destinationAddress, datagram, broadcast);
  }

  receiveTcp(sourceAddress: IpAddress, destinationAddress: IpAddress, segment: TcpSegment): void {
    this.tcp.receive(sourceAddress, destinationAddress, segment);
  }

  /** Clear address-bound sockets and active connections. */
  reset(): void {
    this.tcp.reset();
    this.udp.reset();
  }
}
