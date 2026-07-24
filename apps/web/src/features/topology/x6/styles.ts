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

export function portBodyAttrs(occupied: boolean, operationalUp: boolean) {
  return {
    r: 4,
    magnet: "active",
    stroke: "var(--color-handle-border, #94a3b8)",
    strokeWidth: 1,
    fill: operationalUp
      ? "var(--color-success, #22c55e)"
      : occupied ? "var(--color-handle-occupied, #64748b)" : "var(--color-handle, #cbd5e1)",
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
    },
    label: {
      text,
      fill: "var(--color-link-label, #33485f)",
      fontSize: kind === "diagram" ? 11 : 9,
      fontWeight: kind === "diagram" ? 600 : 500,
      fontFamily: "var(--font-mono, monospace)",
    },
  };
}
