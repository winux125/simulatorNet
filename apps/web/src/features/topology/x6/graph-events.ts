import type { Edge, Graph } from "@antv/x6";
import type { Point } from "./types";

// Normalizes raw X6 events into a small handler surface, and — crucially —
// returns a disposer that removes every subscription it created, so the
// controller can tear the graph down cleanly.

export interface GraphEventHandlers {
  onNodeMoved(id: string, position: Point): void;
  onEdgeConnected(edge: Edge): void;
  onEdgeClick(id: string): void;
  onEdgeContextMenu(id: string, clientX: number, clientY: number): void;
  onBlankClick(client: Point): void;
  onBlankContextMenu(clientX: number, clientY: number): void;
  onScale(zoom: number): void;
}

// Loosely typed to match X6's heterogeneous event payloads.
type Listener = (args: any) => void;

export function attachGraphEvents(graph: Graph, handlers: GraphEventHandlers): () => void {
  const bindings: Array<[string, Listener]> = [
    ["node:moved", ({ node }) => {
      const position = node.position();
      handlers.onNodeMoved(node.id, { x: position.x, y: position.y });
    }],
    ["edge:connected", ({ edge, isNew }) => { if (isNew) handlers.onEdgeConnected(edge); }],
    ["edge:click", ({ edge }) => handlers.onEdgeClick(edge.id)],
    ["edge:contextmenu", ({ e, edge }) => {
      e.preventDefault();
      handlers.onEdgeContextMenu(edge.id, e.clientX, e.clientY);
    }],
    ["blank:click", ({ e }) => handlers.onBlankClick(graph.clientToLocal({ x: e.clientX, y: e.clientY }))],
    ["blank:contextmenu", ({ e }) => {
      e.preventDefault();
      handlers.onBlankContextMenu(e.clientX, e.clientY);
    }],
    ["scale", () => handlers.onScale(graph.zoom())],
  ];

  for (const [event, listener] of bindings) graph.on(event, listener);
  return () => {
    for (const [event, listener] of bindings) graph.off(event, listener);
  };
}
