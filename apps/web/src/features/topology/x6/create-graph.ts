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
      // The device cable handle is the only draggable connection control.
      // Invisible interface ports are never magnets, so there is no direct
      // port-to-port drag UI competing with the device-first workflow.
      validateMagnet: ({ magnet }) => options.isConnectable()
        && magnet.getAttribute("data-connection-handle") === "true",
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
    // Only whole devices are highlighted as connection targets. Magnet
    // highlights are deliberately absent: they would draw circles around the
    // invisible interface ports.
    highlighting: {
      nodeAvailable: {
        name: "stroke",
        args: {
          padding: 4,
          attrs: { stroke: "var(--color-success, #22c55e)", strokeWidth: 1.5 },
        },
      },
    },
  });
}
