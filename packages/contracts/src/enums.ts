/**
 * Protocol constants and device kinds shared across the engine, the API and
 * the UI. Numeric values follow the real wire values so they stay meaningful
 * if/when frames are serialized to bytes later.
 */

export const DeviceKind = {
  Pc: "pc",
  Server: "server",
  Hub: "hub",
  Bridge: "bridge",
  L2Switch: "l2-switch",
  L3Switch: "l3-switch",
  Router: "router",
  Firewall: "firewall",
  Cloud: "cloud",
  TrafficGenerator: "traffic-generator",
  /** Imported placeholder for a node SimulatorNet does not simulate. */
  ExternalAppliance: "external-appliance",
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

/** ICMP codes relevant to the router's error replies. */
export const IcmpCode = {
  /** DestinationUnreachable: no route to the network. */
  NetUnreachable: 0,
  /** DestinationUnreachable: host did not answer ARP. */
  HostUnreachable: 1,
  /** DestinationUnreachable: no application is listening on the UDP port. */
  PortUnreachable: 3,
  /** TimeExceeded: TTL hit zero in transit. */
  TtlExceeded: 0,
} as const;
export type IcmpCode = (typeof IcmpCode)[keyof typeof IcmpCode];

/** DHCP message types (option 53), following the DORA exchange. */
export const DhcpMessageType = {
  Discover: 1,
  Offer: 2,
  Request: 3,
  Decline: 4,
  Ack: 5,
  Nak: 6,
  Release: 7,
} as const;
export type DhcpMessageType = (typeof DhcpMessageType)[keyof typeof DhcpMessageType];
