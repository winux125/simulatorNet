import type { TopologyView } from "./types";

export const WIRELESS_ASSOCIATION_EDGE_PREFIX = "runtime-wireless:";

export type WirelessAssociationView = NonNullable<TopologyView["wirelessAssociations"]>[number];

export interface WirelessAssociationEdgeAppearance {
  id: string;
  stroke: string;
  dashArray: string;
  label: string;
}

export function wirelessAssociationEdgeId(associationId: string): string {
  return `${WIRELESS_ASSOCIATION_EDGE_PREFIX}${associationId}`;
}

export function isWirelessAssociationEdgeId(cellId: string): boolean {
  return cellId.startsWith(WIRELESS_ASSOCIATION_EDGE_PREFIX);
}

/**
 * Pure presentation projection for a runtime WLAN association. The resulting
 * edge has no interface/port identity and is never folded into LabDocument.
 */
export function wirelessAssociationEdgeAppearance(
  association: WirelessAssociationView,
): WirelessAssociationEdgeAppearance {
  const stroke = association.state === "associated"
    ? "var(--color-success, #16a36a)"
    : association.state === "failed"
      ? "var(--color-danger, #dc4c4c)"
      : "var(--color-warning, #d59a22)";
  return {
    id: wirelessAssociationEdgeId(association.id),
    stroke,
    dashArray: association.state === "associated" ? "5 4" : "2 4",
    label: association.ssid,
  };
}
