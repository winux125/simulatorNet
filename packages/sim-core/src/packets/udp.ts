import type { DhcpMessage } from "./dhcp";

/** Application payloads carried in UDP. Extended as protocols are added. */
export type UdpPayload = DhcpMessage;

export interface UdpDatagram {
  readonly kind: "udp";
  readonly srcPort: number;
  readonly dstPort: number;
  readonly payload: UdpPayload;
}
