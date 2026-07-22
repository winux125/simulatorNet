/** Time is measured in integer nanoseconds throughout the engine. */
export const NS_PER_US = 1_000;
export const NS_PER_MS = 1_000_000;
export const NS_PER_S = 1_000_000_000;

/** Default point-to-point cable propagation + serialization delay (~0.5 ms). */
export const DEFAULT_LINK_DELAY_NS = 500 * NS_PER_US;

/** How long a PC waits for an ICMP echo reply before declaring the ping failed. */
export const DEFAULT_PING_TIMEOUT_NS = 2 * NS_PER_S;
