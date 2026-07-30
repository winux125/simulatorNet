import type { Ipv6 } from "../util/ipv6";
import type { Mac } from "../util/mac";

export const Icmpv6Type = {
  DestinationUnreachable: 1,
  TimeExceeded: 3,
  EchoRequest: 128,
  EchoReply: 129,
  RouterSolicitation: 133,
  RouterAdvertisement: 134,
  NeighborSolicitation: 135,
  NeighborAdvertisement: 136,
} as const;
export type Icmpv6Type = (typeof Icmpv6Type)[keyof typeof Icmpv6Type];

interface Icmpv6Base {
  readonly kind: "icmpv6";
  readonly type: Icmpv6Type;
  readonly code: number;
  /** Data length used by the deterministic wire-size model; defaults when unset. */
  readonly payloadBytes?: number;
}

export interface Icmpv6EchoMessage extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.EchoRequest | typeof Icmpv6Type.EchoReply;
  readonly identifier: number;
  readonly sequence: number;
}

export interface Icmpv6DestinationUnreachable extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.DestinationUnreachable;
  readonly reason: "no-route" | "address-unreachable" | "port-unreachable" | "administratively-prohibited";
}

export interface Icmpv6TimeExceeded extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.TimeExceeded;
  readonly reason: "hop-limit-exceeded";
}

export interface NeighborSolicitation extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.NeighborSolicitation;
  readonly target: Ipv6;
  /** Omitted by DAD because the sender does not yet own the tentative address. */
  readonly sourceLinkLayerAddress?: Mac;
}

export interface NeighborAdvertisement extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.NeighborAdvertisement;
  readonly target: Ipv6;
  readonly targetLinkLayerAddress: Mac;
  readonly solicited: boolean;
  readonly override: boolean;
  readonly router: boolean;
}

export interface RouterSolicitation extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.RouterSolicitation;
  readonly sourceLinkLayerAddress?: Mac;
}

export interface RouterAdvertisementPrefix {
  readonly prefix: Ipv6;
  readonly prefixLength: number;
  readonly autonomous: boolean;
  readonly onLink: boolean;
  readonly validLifetimeNs: number;
  readonly preferredLifetimeNs: number;
}

export interface RouterAdvertisement extends Icmpv6Base {
  readonly type: typeof Icmpv6Type.RouterAdvertisement;
  readonly currentHopLimit: number;
  readonly managed: boolean;
  readonly otherConfiguration: boolean;
  readonly routerLifetimeNs: number;
  readonly sourceLinkLayerAddress: Mac;
  readonly prefixes: readonly RouterAdvertisementPrefix[];
  readonly dnsServers?: readonly Ipv6[];
}

export type Icmpv6Message =
  | Icmpv6EchoMessage
  | Icmpv6DestinationUnreachable
  | Icmpv6TimeExceeded
  | NeighborSolicitation
  | NeighborAdvertisement
  | RouterSolicitation
  | RouterAdvertisement;
