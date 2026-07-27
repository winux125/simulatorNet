import type { Ipv6 } from "../util/ipv6";

export const Dhcpv6MessageType = {
  Solicit: "solicit",
  Advertise: "advertise",
  Request: "request",
  Reply: "reply",
  Renew: "renew",
  Release: "release",
  InformationRequest: "information-request",
} as const;
export type Dhcpv6MessageType = (typeof Dhcpv6MessageType)[keyof typeof Dhcpv6MessageType];

export interface Dhcpv6Message {
  readonly kind: "dhcpv6";
  readonly messageType: Dhcpv6MessageType;
  readonly transactionId: number;
  /** Stable educational DUID derived from the interface MAC. */
  readonly clientId: string;
  readonly serverId?: string;
  readonly requestedAddress?: Ipv6;
  readonly address?: Ipv6;
  readonly prefixLength?: number;
  readonly preferredLifetimeNs?: number;
  readonly validLifetimeNs?: number;
  readonly dnsServers?: readonly Ipv6[];
}
