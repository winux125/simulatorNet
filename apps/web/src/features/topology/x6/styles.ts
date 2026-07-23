// Theme-aware X6 style tokens. All colours reference CSS custom properties so a
// light/dark theme switch restyles the canvas without re-rendering the graph.

export const SIM_DEVICE_SHAPE = "sim-device-node";
export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 96;
export const PORT_GROUP = "interfaces";

export function edgeLineAttrs(operational: boolean, selected: boolean) {
  const stroke = selected
    ? "var(--color-accent, #3b82f6)"
    : operational ? "var(--color-link-up, #22c55e)" : "var(--color-link-down, #94a3b8)";
  return {
    stroke,
    strokeWidth: selected ? 2.6 : 2,
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

export function edgeLabelAttrs() {
  return {
    rect: { fill: "var(--color-link-label-bg, #0f172a)", rx: 3, ry: 3 },
    text: { fill: "var(--color-link-label, #e2e8f0)", fontSize: 10, fontFamily: "var(--font-mono, monospace)" },
  };
}
