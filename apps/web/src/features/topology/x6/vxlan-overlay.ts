import type { TopologyView } from "./types";

export const VXLAN_EDGE_PREFIX = "runtime-vxlan:";
export type VxlanTunnelView = NonNullable<TopologyView["vxlanTunnels"]>[number];

export function vxlanEdgeId(tunnelId: string): string {
  return `${VXLAN_EDGE_PREFIX}${tunnelId}`;
}

/**
 * A derived VXLAN tunnel is drawn dashed, exactly like a wireless association
 * or an L3VPN relation, so it can never be mistaken for a cable. A route-target
 * mismatch gets its own colour because the two VTEPs never became peers at all,
 * and so does an `unavailable` routed segment: an L3VNI whose VRF is gone
 * exists but transports nothing, which is not the same as an unreachable peer.
 */
export function vxlanEdgeAppearance(tunnel: VxlanTunnelView) {
  return {
    id: vxlanEdgeId(tunnel.id),
    stroke: tunnel.state === "operational"
      ? tunnel.kind === "l3vni" ? "var(--color-success, #2f9e5f)" : "var(--color-accent, #2563eb)"
      : tunnel.state === "rt-mismatch" || tunnel.state === "unavailable"
        ? "var(--color-warning, #d59a22)"
        : "var(--color-danger, #dc4c4c)",
    // A routed segment keeps its own dash rhythm, so the two logical relations
    // stay distinguishable on a monochrome or colour-blind-safe canvas too.
    dashArray: tunnel.state !== "operational"
      ? "3 5"
      : tunnel.kind === "l3vni" ? "2 3 8 3" : "8 4",
    label: tunnel.source === "bgp-evpn" ? `${tunnel.label} · EVPN` : `${tunnel.label} · static`,
  };
}
