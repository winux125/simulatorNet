import type { TopologyView } from "./types";

export const VPN_TUNNEL_EDGE_PREFIX = "runtime-vpn:";

export type VpnTunnelOverlayView = NonNullable<TopologyView["vpnTunnels"]>[number];

export interface VpnTunnelEdgeAppearance {
  id: string;
  stroke: string;
  dashArray: string;
  label: string;
}

export function vpnTunnelEdgeId(tunnelKey: string): string {
  return `${VPN_TUNNEL_EDGE_PREFIX}${tunnelKey}`;
}

export function isVpnTunnelEdgeId(cellId: string): boolean {
  return cellId.startsWith(VPN_TUNNEL_EDGE_PREFIX);
}

/**
 * Pure presentation projection for a runtime VPN tunnel.
 *
 * A tunnel overlay is derived from worker state, exactly like a wireless
 * association: it has no X6 port identity, never enters
 * `LabDocument.topology.links`, never opens the cable modal and never triggers
 * Apply Topology. The colour reports what the engine says — protected and
 * carrying traffic, plain GRE, still negotiating, or failed — and nothing else.
 */
export function vpnTunnelEdgeAppearance(tunnel: VpnTunnelOverlayView): VpnTunnelEdgeAppearance {
  const stroke = tunnel.state === "protected"
    ? "var(--color-success, #16a36a)"
    : tunnel.state === "failed"
      ? "var(--color-danger, #dc4c4c)"
      : tunnel.state === "negotiating"
        ? "var(--color-warning, #d59a22)"
        : "var(--color-accent, #3f7fd0)";
  return {
    id: vpnTunnelEdgeId(tunnel.id),
    stroke,
    // A live tunnel gets a longer dash than one that is not carrying traffic,
    // so the two are distinguishable without relying on colour alone.
    dashArray: tunnel.state === "protected" || tunnel.state === "gre" ? "8 4" : "2 4",
    label: tunnel.label,
  };
}
