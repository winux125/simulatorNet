import type { TopologyView } from "./types";

export const L3VPN_EDGE_PREFIX = "runtime-l3vpn:";
export type L3VpnRelationView = NonNullable<TopologyView["l3VpnRelations"]>[number];

export function l3VpnEdgeId(relationId: string): string {
  return `${L3VPN_EDGE_PREFIX}${relationId}`;
}

export function l3VpnEdgeAppearance(relation: L3VpnRelationView) {
  return {
    id: l3VpnEdgeId(relation.id),
    stroke: relation.state === "operational"
      ? "var(--color-accent, #2563eb)"
      : relation.state === "control-plane-only"
        ? "var(--color-warning, #d59a22)"
        : "var(--color-danger, #dc4c4c)",
    dashArray: relation.state === "operational" ? "10 5" : "3 5",
    label: relation.label,
  };
}
