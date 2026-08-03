import type { Ipv4 } from "../util/ipv4";

export const BGP_TCP_PORT = 179;
export const BGP_VERSION = 4;

export interface BgpOpenMessage {
  readonly kind: "bgp-open";
  readonly version: 4;
  readonly localAs: number;
  readonly holdTimeSeconds: number;
  readonly bgpIdentifier: Ipv4;
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
}

export interface BgpNlri {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly path: BgpPathAttributes;
  readonly routeId: string;
}

export interface BgpUpdateMessage {
  readonly kind: "bgp-update";
  readonly withdrawn: readonly Pick<BgpNlri, "network" | "prefixLength">[];
  readonly nlri: readonly BgpNlri[];
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
