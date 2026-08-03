import type { Ipv4 } from "../util/ipv4";

export const BGP_TCP_PORT = 179;
export const BGP_VERSION = 4;

export interface BgpOpenMessage {
  readonly kind: "bgp-open";
  readonly version: 4;
  readonly localAs: number;
  readonly holdTimeSeconds: number;
  readonly bgpIdentifier: Ipv4;
  readonly addressFamilies?: readonly ("ipv4-unicast" | "vpnv4-unicast")[];
}

export interface BgpKeepaliveMessage {
  readonly kind: "bgp-keepalive";
}

export interface BgpPathAttributes {
  readonly origin: "igp" | "egp" | "incomplete";
  readonly asPath: readonly number[];
  readonly nextHop: Ipv4;
  readonly localPreference?: number;
  readonly med?: number;
  /**
   * Standard communities, canonical and sorted. They only cross the wire when
   * the sending neighbor has `send-community`, which is exactly why the field
   * is optional rather than always populated.
   */
  readonly communities?: readonly string[];
  /** Router ID of the iBGP speaker that first announced the route. */
  readonly originatorId?: Ipv4;
  /** Cluster IDs of every reflector the route has already traversed. */
  readonly clusterList?: readonly string[];
  /** `true` when a route reflector, not the originator, sent this NLRI. */
  readonly reflected?: boolean;
  /** Contributing ASNs of an `as-set` aggregate, deterministic and sorted. */
  readonly aggregatorAsSet?: readonly number[];
}

export interface BgpNlri {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

export interface Vpnv4Nlri {
  readonly routeDistinguisher: string;
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly routeTargets: readonly string[];
  readonly vpnLabel: number;
  readonly nextHop: Ipv4;
  readonly sourceVrfId: string;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

export interface BgpUpdateMessage {
  readonly kind: "bgp-update";
  readonly withdrawn: readonly Pick<BgpNlri, "network" | "prefixLength">[];
  readonly nlri: readonly BgpNlri[];
  readonly vpnv4Withdrawn?: readonly Pick<Vpnv4Nlri, "routeDistinguisher" | "network" | "prefixLength">[];
  readonly vpnv4Nlri?: readonly Vpnv4Nlri[];
}

export interface BgpNotificationMessage {
  readonly kind: "bgp-notification";
  readonly code: "message-header" | "open-message" | "update-message" | "hold-timer" | "cease";
  readonly subcode: string;
  readonly message: string;
}

export type BgpMessage =
  | BgpOpenMessage
  | BgpKeepaliveMessage
  | BgpUpdateMessage
  | BgpNotificationMessage;

export function isBgpMessage(value: unknown): value is BgpMessage {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "bgp-open" || kind === "bgp-keepalive" || kind === "bgp-update" || kind === "bgp-notification";
}
