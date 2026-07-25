import { Graph } from "@antv/x6";
import { CANVAS_MAX_SCALE, CANVAS_MIN_SCALE } from "../canvas-navigation";

// Factory for the X6 Graph. Interaction gating (drag / connect) is resolved
// lazily against live refs so readonly/tool changes never require a rebuild.
//
// Wheel input is deliberately NOT configured here. The canvas owns a single
// viewport through `canvas-navigation-controller`; enabling X6's `mousewheel`
// module or listing `mouseWheel` in `panning.eventTypes` would duplicate wheel
// handling. There is no Scroller plugin and therefore no inner scrollbars.

export interface CreateGraphOptions {
  container: HTMLElement;
  isNodeMovable(cellId: string): boolean;
  isConnectable(): boolean;
  validateConnection(sourcePort: string | null, targetPort: string | null, sourceCell: string | null, targetCell: string | null): boolean;
}

export function createGraph(options: CreateGraphOptions): Graph {
  return new Graph({
    container: options.container,
    autoResize: false,
    background: { color: "transparent" },
    grid: false,
    scaling: { min: CANVAS_MIN_SCALE, max: CANVAS_MAX_SCALE },
    panning: { enabled: false, eventTypes: ["leftMouseDown"] },
    interacting: (cellView) => ({
      nodeMovable: options.isNodeMovable(cellView.cell.id),
      edgeMovable: false,
      edgeLabelMovable: false,
    }),
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowMulti: "withPort",
      allowNode: true,
      allowEdge: false,
      highlight: true,
      snap: { radius: 24 },
      router: { name: "normal" },
      connector: { name: "normal" },
      createEdge() {
        return this.createEdge({
          data: { kind: "connection-preview" },
          attrs: {
            line: {
              stroke: "var(--color-topology-link, #287db4)",
              strokeWidth: 1.8,
              strokeDasharray: "5 3",
              targetMarker: null,
              sourceMarker: null,
            },
            wrap: { stroke: "transparent", strokeWidth: 12 },
          },
          router: { name: "normal" },
          connector: { name: "normal" },
          zIndex: 101,
        });
      },
      validateMagnet: ({ magnet }) => options.isConnectable()
        && magnet.getAttribute("data-occupied") !== "true"
        && Boolean(magnet.getAttribute("port") || magnet.getAttribute("data-connection-handle")),
      validateConnection: ({ sourceMagnet, targetMagnet, sourceCell, targetCell }) => {
        if (!options.isConnectable() || !sourceCell || !targetCell || sourceCell.id === targetCell.id) return false;
        const sourcePort = sourceMagnet?.getAttribute("port") ?? null;
        const targetPort = targetMagnet?.getAttribute("port") ?? null;
        return options.validateConnection(
          sourcePort,
          targetPort,
          sourceCell.id,
          targetCell.id,
        );
      },
    },
    highlighting: {
      nodeAvailable: {
        name: "stroke",
        args: {
          padding: 4,
          attrs: { stroke: "var(--color-success, #22c55e)", strokeWidth: 1.5 },
        },
      },
      magnetAvailable: {
        name: "stroke",
        args: {
          padding: 3,
          attrs: { stroke: "var(--color-success, #22c55e)", strokeWidth: 2 },
        },
      },
      magnetAdsorbed: {
        name: "stroke",
        args: {
          padding: 5,
          attrs: { stroke: "var(--color-accent, #2563eb)", strokeWidth: 3 },
        },
      },
    },
  });
}
