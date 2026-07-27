import type { Ipv4 } from "./ipv4";
import { ipToInt } from "./ipv4";
import type { Ipv6 } from "./ipv6";
import { ipv6ToBigInt } from "./ipv6";

export type IpFamily = "ipv4" | "ipv6";
export type IpAddress = Ipv4 | Ipv6;

export function ipFamilyOf(address: IpAddress): IpFamily {
  return address.includes(":") ? "ipv6" : "ipv4";
}

export interface TransportEndpoint {
  readonly family: IpFamily;
  readonly address: IpAddress;
  readonly port: number;
}

export interface IpRouteCandidate<T> {
  readonly family: IpFamily;
  readonly network: IpAddress;
  readonly prefixLength: number;
  readonly administrativeDistance: number;
  readonly metric: number;
  readonly nextHop?: IpAddress;
  readonly stableId: string;
  readonly value: T;
}

export function compareIpAddresses(family: IpFamily, left: IpAddress, right: IpAddress): number {
  if (family === "ipv4") return ipToInt(left) - ipToInt(right);
  const a = ipv6ToBigInt(left);
  const b = ipv6ToBigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Shared route preference: longest prefix, distance, metric, next hop, then a
 * caller-provided stable identifier. Address-family matching is explicit so an
 * IPv4 route can never accidentally compete with an IPv6 route.
 */
export function selectBestIpRoute<T>(
  family: IpFamily,
  candidates: readonly IpRouteCandidate<T>[],
): IpRouteCandidate<T> | undefined {
  return candidates
    .filter((candidate) => candidate.family === family)
    .slice()
    .sort((a, b) =>
      b.prefixLength - a.prefixLength
      || a.administrativeDistance - b.administrativeDistance
      || a.metric - b.metric
      || compareOptionalNextHop(family, a.nextHop, b.nextHop)
      || a.stableId.localeCompare(b.stableId))[0];
}

function compareOptionalNextHop(
  family: IpFamily,
  left: IpAddress | undefined,
  right: IpAddress | undefined,
): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareIpAddresses(family, left, right);
}
