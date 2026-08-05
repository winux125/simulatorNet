import type { TopologyView } from "./types";

export const VXLAN_EDGE_PREFIX = "runtime-vxlan:";
export type VxlanTunnelView = NonNullable<TopologyView["vxlanTunnels"]>[number];

export function vxlanEdgeId(tunnelId: string): string {
  return `${VXLAN_EDGE_PREFIX}${tunnelId}`;
}

/**
 * A derived VXLAN tunnel is drawn dashed, exactly like a wireless association
 * or an L3VPN relation, so it can never be mistaken for a cable. A route-target
 * mismatch gets its own colour because the two VTEPs never became peers at all.
 */
export function vxlanEdgeAppearance(tunnel: VxlanTunnelView) {
  return {
    id: vxlanEdgeId(tunnel.id),
    stroke: tunnel.state === "operational"
      ? "var(--color-accent, #2563eb)"
      : tunnel.state === "rt-mismatch"
        ? "var(--color-warning, #d59a22)"
        : "var(--color-danger, #dc4c4c)",
    dashArray: tunnel.state === "operational" ? "8 4" : "3 5",
    label: tunnel.source === "bgp-evpn" ? `${tunnel.label} · EVPN` : `${tunnel.label} · static`,
  };
}
