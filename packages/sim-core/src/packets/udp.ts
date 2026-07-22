import type { DhcpMessage } from "./dhcp";

/** Generic structured payload used by transport tests and simple applications. */
export interface UdpApplicationPayload {
  readonly kind: "udp-application";
  readonly protocol: string;
  readonly data: unknown;
}

/** Application payloads carried in UDP. Service protocols extend this union. */
export type UdpPayload = DhcpMessage | UdpApplicationPayload;

export interface UdpDatagram {
  readonly kind: "udp";
  readonly srcPort: number;
  readonly dstPort: number;
  readonly payload: UdpPayload;
}
