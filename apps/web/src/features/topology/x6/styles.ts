// Theme-aware X6 style tokens. All colours reference CSS custom properties so a
// light/dark theme switch restyles the canvas without re-rendering the graph.

export const SIM_DEVICE_SHAPE = "sim-device-node";
export const NODE_WIDTH = 112;
export const NODE_HEIGHT = 92;
export const PORT_GROUP_LEFT = "interfaces-left";
export const PORT_GROUP_RIGHT = "interfaces-right";

export function edgeLineAttrs(operational: boolean, selected: boolean) {
  const stroke = selected
    ? "var(--color-accent, #2563eb)"
    : operational ? "var(--color-topology-link, #287db4)" : "var(--color-link-down, #94a3b8)";
  return {
    stroke,
    strokeWidth: selected ? 2.4 : 1.7,
    strokeDasharray: operational ? undefined : "5 4",
    targetMarker: null,
    sourceMarker: null,
  };
}

/** Anchor radius kept stable so edge endpoints land in the same place. */
export const PORT_ANCHOR_RADIUS = 4;

/**
 * Ports are invisible anchor geometry, never a user-facing control.
 *
 * A link still binds a specific interface, so every interface keeps a port with
 * stable geometry and its `data-*` identity for edge anchoring, imports and
 * tests. Nothing is painted and nothing is draggable: connections are created
 * from the single device cable handle, so no port dots appear around a device
 * in any icon profile, on hover, or on selection.
 */
export function portBodyAttrs(occupied: boolean, operationalUp: boolean) {
  return {
    r: PORT_ANCHOR_RADIUS,
    magnet: false,
    pointerEvents: "none",
    cursor: "default",
    opacity: 0,
    fill: "none",
    stroke: "none",
    strokeWidth: 0,
    "data-occupied": String(occupied),
    "data-operational": String(operationalUp),
  };
}

export function edgeLabelAttrs(text: string, kind: "port" | "diagram" = "port") {
  return {
    body: {
      fill: "var(--color-link-label-bg, #f4f7fa)",
      stroke: kind === "diagram" ? "var(--color-border, #b8c5d1)" : "var(--color-link-label-border, #c4d1dc)",
      strokeWidth: 1,
      rx: kind === "diagram" ? 2 : 5,
      ry: kind === "diagram" ? 2 : 5,
      pointerEvents: "none",
    },
    label: {
      text,
      textWrap: kind === "diagram"
        ? { width: 220, height: 30, ellipsis: true }
        : undefined,
      "data-full-text": text,
      fill: "var(--color-link-label, #33485f)",
      fontSize: kind === "diagram" ? 11 : 9,
      fontWeight: kind === "diagram" ? 600 : 500,
      fontFamily: "var(--font-mono, monospace)",
      pointerEvents: "none",
    },
  };
}
