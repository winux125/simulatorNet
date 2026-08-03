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
  /**
   * IEEE 802.3 length/LLC encapsulation. STP, LACP, PAgP and CDP are carried
   * over 802.2 LLC rather than an EtherType; SimulatorNet never serializes
   * frames to bytes, so this discriminator stands in for that encapsulation.
   */
  LLC: 0x0000,
  IPv4: 0x0800,
  ARP: 0x0806,
  /** MPLS unicast; SimulatorNet carries a structured label stack, not raw bytes. */
  MPLS: 0x8847,
  /** IEEE 802.1AB LLDP, which really does use its own EtherType. */
  LLDP: 0x88cc,
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
  /** Generic Routing Encapsulation: the outer protocol of a GRE tunnel. */
  GRE: 47,
  /**
   * Encapsulating Security Payload. SimulatorNet carries a *structured*
   * educational ESP envelope; it performs no cryptographic protection.
   */
  ESP: 50,
  /** OSPFv2 control traffic; carried directly over IPv4, never over a port. */
  OSPF: 89,
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
  /**
   * DestinationUnreachable: the packet exceeded a tunnel MTU. SimulatorNet does
   * not model fragmentation, so a tunnel reports this and drops the packet.
   */
  FragmentationNeeded: 4,
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
