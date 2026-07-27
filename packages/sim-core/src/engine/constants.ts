/** Time is measured in integer nanoseconds throughout the engine. */
export const NS_PER_US = 1_000;
export const NS_PER_MS = 1_000_000;
export const NS_PER_S = 1_000_000_000;

/** Default point-to-point cable propagation + serialization delay (~0.5 ms). */
export const DEFAULT_LINK_DELAY_NS = 500 * NS_PER_US;

/** How long a PC waits for an ICMP echo reply before declaring the ping failed. */
export const DEFAULT_PING_TIMEOUT_NS = 2 * NS_PER_S;

/** Well-known UDP ports for DHCP (BOOTP). */
export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

/** Default DHCP lease duration handed out by the server (1 day). */
export const DEFAULT_DHCP_LEASE_SECONDS = 86_400;

/** How long a DHCP client waits for an OFFER/ACK before giving up. */
export const DEFAULT_DHCP_TIMEOUT_NS = 4 * NS_PER_S;

/** Default TTL stamped on IPv4 packets a host originates. */
export const DEFAULT_IP_TTL = 64;
/** Default hop limit stamped on IPv6 packets a host originates. */
export const DEFAULT_IPV6_HOP_LIMIT = 64;

/** Deterministic transport defaults and safety bounds. */
export const DEFAULT_TCP_RETRANSMISSION_TIMEOUT_NS = NS_PER_S;
export const DEFAULT_TCP_TIME_WAIT_NS = 2 * NS_PER_S;
export const EPHEMERAL_PORT_START = 49_152;
export const EPHEMERAL_PORT_END = 65_535;

export const DEFAULT_TRANSPORT_LIMITS = Object.freeze({
  maximumUdpSockets: 64,
  maximumTcpListeners: 32,
  maximumTcpConnections: 128,
  maximumRetransmissions: 3,
  maximumApplicationPayloadBytes: 64 * 1_024,
  maximumQueuedMessages: 64,
  maximumTimeWaitNs: DEFAULT_TCP_TIME_WAIT_NS,
});

export type TransportLimits = typeof DEFAULT_TRANSPORT_LIMITS;
