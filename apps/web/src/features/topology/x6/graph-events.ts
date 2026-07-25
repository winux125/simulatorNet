import type { Edge, Graph } from "@antv/x6";
import type { Point } from "./types";

// Normalizes raw X6 events into a small handler surface, and — crucially —
// returns a disposer that removes every subscription it created, so the
// controller can tear the graph down cleanly.

export interface GraphEventHandlers {
  onNodeMoved(id: string, position: Point): void;
  onNodeClick(id: string, additive: boolean): void;
  onNodeDoubleClick(id: string): void;
  onEdgeConnected(edge: Edge): void;
  onEdgeClick(id: string, additive: boolean): void;
  onEdgeContextMenu(id: string, clientX: number, clientY: number): void;
  onBlankClick(client: Point): void;
  onBlankPointerDown?(client: Point, modifiers: { shift: boolean; alt: boolean }): void;
  onBlankPointerMove?(client: Point): void;
  onBlankPointerUp?(client: Point, modifiers: { shift: boolean; alt: boolean }): void;
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
    ["node:click", ({ e, node }) => handlers.onNodeClick(node.id, Boolean(e.shiftKey))],
    ["node:dblclick", ({ node }) => handlers.onNodeDoubleClick(node.id)],
    ["edge:connected", ({ edge, isNew }) => { if (isNew) handlers.onEdgeConnected(edge); }],
    ["edge:click", ({ e, edge }) => handlers.onEdgeClick(edge.id, Boolean(e.shiftKey))],
    ["edge:contextmenu", ({ e, edge }) => {
      e.preventDefault();
      handlers.onEdgeContextMenu(edge.id, e.clientX, e.clientY);
    }],
    ["blank:click", ({ e }) => handlers.onBlankClick(graph.clientToLocal({ x: e.clientX, y: e.clientY }))],
    ["blank:mousedown", ({ e }) => handlers.onBlankPointerDown?.(
      graph.clientToLocal({ x: e.clientX, y: e.clientY }),
      { shift: Boolean(e.shiftKey), alt: Boolean(e.altKey) },
    )],
    ["blank:mousemove", ({ e }) => handlers.onBlankPointerMove?.(graph.clientToLocal({ x: e.clientX, y: e.clientY }))],
    ["blank:mouseup", ({ e }) => handlers.onBlankPointerUp?.(
      graph.clientToLocal({ x: e.clientX, y: e.clientY }),
      { shift: Boolean(e.shiftKey), alt: Boolean(e.altKey) },
    )],
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
