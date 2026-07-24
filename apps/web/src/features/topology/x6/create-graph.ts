import { Graph } from "@antv/x6";

// Factory for the X6 Graph. Interaction gating (drag / connect) is resolved
// lazily against live refs so readonly/tool changes never require a rebuild.

export interface CreateGraphOptions {
  container: HTMLElement;
  isNodeMovable(): boolean;
  isConnectable(): boolean;
  validateConnection(sourcePort: string | null, targetPort: string | null, sourceCell: string | null, targetCell: string | null): boolean;
}

export function createGraph(options: CreateGraphOptions): Graph {
  return new Graph({
    container: options.container,
    autoResize: true,
    background: { color: "transparent" },
    grid: false,
    panning: { enabled: true, eventTypes: ["leftMouseDown", "mouseWheel"] },
    mousewheel: { enabled: true, modifiers: [], minScale: 0.3, maxScale: 1.8 },
    interacting: () => ({ nodeMovable: options.isNodeMovable(), edgeMovable: false, edgeLabelMovable: false }),
    connecting: {
      allowBlank: false,
      allowLoop: false,
      allowMulti: false,
      allowNode: true,
      allowEdge: false,
      snap: { radius: 24 },
      router: { name: "manhattan", args: { padding: 12 } },
      connector: { name: "rounded", args: { radius: 8 } },
      validateMagnet: ({ magnet }) => options.isConnectable()
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
  });
}
