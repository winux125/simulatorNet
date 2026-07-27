import type { OspfNeighborState } from "../packets/ospf";
import { ipToInt, type Ipv4 } from "../util/ipv4";

export interface OspfElectionCandidate {
  readonly routerId: Ipv4;
  readonly priority: number;
}

export interface OspfGraphEdge {
  readonly from: Ipv4;
  readonly to: Ipv4;
  readonly cost: number;
}

export interface OspfShortestPath {
  readonly routerId: Ipv4;
  readonly cost: number;
  readonly firstHop?: Ipv4;
}

export function compareOspfRouterIds(left: Ipv4, right: Ipv4): number {
  return ipToInt(left) - ipToInt(right);
}

/** OSPF DR/BDR ordering shared by v2 and v3: priority, then router ID. */
export function sortOspfElectionCandidates<T extends OspfElectionCandidate>(candidates: readonly T[]): T[] {
  return [...candidates]
    .filter((candidate) => candidate.priority > 0)
    .sort((left, right) =>
      right.priority - left.priority || compareOspfRouterIds(right.routerId, left.routerId));
}

/**
 * Stable Dijkstra walk used by OSPFv3 and available to the v2 implementation.
 * Equal-cost paths deliberately choose the lower first-hop router ID; ECMP is
 * outside the current routing-table model.
 */
export function shortestOspfPaths(root: Ipv4, edges: readonly OspfGraphEdge[]): OspfShortestPath[] {
  const outgoing = new Map<Ipv4, OspfGraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }
  for (const list of outgoing.values()) {
    list.sort((left, right) =>
      compareOspfRouterIds(left.to, right.to) || left.cost - right.cost);
  }

  const best = new Map<Ipv4, OspfShortestPath>();
  const pending: OspfShortestPath[] = [{ routerId: root, cost: 0 }];
  while (pending.length > 0) {
    pending.sort((left, right) =>
      left.cost - right.cost
      || compareOptionalRouterIds(left.firstHop, right.firstHop)
      || compareOspfRouterIds(left.routerId, right.routerId));
    const current = pending.shift()!;
    const prior = best.get(current.routerId);
    if (prior && !isBetterPath(current, prior)) continue;
    best.set(current.routerId, current);
    for (const edge of outgoing.get(current.routerId) ?? []) {
      const candidate: OspfShortestPath = {
        routerId: edge.to,
        cost: current.cost + edge.cost,
        firstHop: current.routerId === root ? edge.to : current.firstHop,
      };
      const known = best.get(candidate.routerId);
      if (!known || isBetterPath(candidate, known)) pending.push(candidate);
    }
  }
  return [...best.values()].sort((left, right) => compareOspfRouterIds(left.routerId, right.routerId));
}

export const OSPF_NEIGHBOR_STATE_ORDER: Readonly<Record<OspfNeighborState, number>> = Object.freeze({
  down: 0,
  init: 1,
  "two-way": 2,
  exstart: 3,
  exchange: 4,
  loading: 5,
  full: 6,
});

function isBetterPath(candidate: OspfShortestPath, prior: OspfShortestPath): boolean {
  return candidate.cost < prior.cost
    || (candidate.cost === prior.cost
      && compareOptionalRouterIds(candidate.firstHop, prior.firstHop) < 0);
}

function compareOptionalRouterIds(left?: Ipv4, right?: Ipv4): number {
  if (left === right) return 0;
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  return compareOspfRouterIds(left, right);
}
