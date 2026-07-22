/**
 * Protocol constants and device kinds shared across the engine, the API and
 * the UI. Numeric values follow the real wire values so they stay meaningful
 * if/when frames are serialized to bytes later.
 */

export const DeviceKind = {
  Pc: "pc",
  L2Switch: "l2-switch",
  Router: "router",
} as const;
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind];

export const EtherType = {
  IPv4: 0x0800,
  ARP: 0x0806,
  IPv6: 0x86dd,
} as const;
export type EtherType = (typeof EtherType)[keyof typeof EtherType];

export const ArpOp = {
  Request: 1,
  Reply: 2,
} as const;
export type ArpOp = (typeof ArpOp)[keyof typeof ArpOp];

export const IpProtocol = {
  ICMP: 1,
  TCP: 6,
  UDP: 17,
} as const;
export type IpProtocol = (typeof IpProtocol)[keyof typeof IpProtocol];

export const IcmpType = {
  EchoReply: 0,
  DestinationUnreachable: 3,
  EchoRequest: 8,
  TimeExceeded: 11,
} as const;
export type IcmpType = (typeof IcmpType)[keyof typeof IcmpType];
