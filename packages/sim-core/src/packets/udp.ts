import type { DhcpMessage } from "./dhcp";
import type { Dhcpv6Message } from "./dhcpv6";
import type {
  DnsMessage,
  NtpMessage,
  RadiusMessage,
  SyslogMessage,
  TftpMessage,
} from "../services/messages";
import type { SnmpMessage } from "../management/snmp-messages";
import type { IkeMessage } from "./ike";
import type { VxlanPacket } from "./vxlan";

/** Generic structured payload used by transport tests and simple applications. */
export interface UdpApplicationPayload {
  readonly kind: "udp-application";
  readonly protocol: string;
  readonly data: unknown;
  /** Explicit wire size for the deterministic queue model; inferred when unset. */
  readonly payloadBytes?: number;
}

/** Application payloads carried in UDP. Service protocols extend this union. */
export type UdpPayload =
  | DhcpMessage
  | Dhcpv6Message
  | DnsMessage
  | TftpMessage
  | NtpMessage
  | SyslogMessage
  | RadiusMessage
  | SnmpMessage
  | IkeMessage
  /** A VXLAN-encapsulated Ethernet frame; the outer transport is real UDP. */
  | VxlanPacket
  | UdpApplicationPayload;

export interface UdpDatagram {
  readonly kind: "udp";
  readonly srcPort: number;
  readonly dstPort: number;
  readonly payload: UdpPayload;
}
