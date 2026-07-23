import type { Edge, Graph } from "@antv/x6";
import { edgeLabelAttrs, edgeLineAttrs } from "./styles";
import type { GraphLinkModel, LinkView } from "./types";

// Edge creation/update. Edges reference specific ports so a link always binds a
// pair of interfaces, never whole devices.

function attrs(view: LinkView | undefined) {
  return { line: edgeLineAttrs(view?.operational ?? false, view?.selected ?? false) };
}

function labels(view: LinkView | undefined) {
  if (!view?.label) return [];
  return [{ attrs: edgeLabelAttrs(), position: 0.5, label: view.label }];
}

export function addLinkEdge(graph: Graph, link: GraphLinkModel, view: LinkView | undefined): Edge {
  return graph.addEdge({
    id: link.id,
    source: { cell: link.source, port: link.sourcePort },
    target: { cell: link.target, port: link.targetPort },
    attrs: attrs(view),
    labels: labels(view),
    router: { name: "manhattan", args: { padding: 12 } },
    connector: { name: "rounded", args: { radius: 8 } },
    zIndex: -1,
  });
}

export function updateLinkEdge(edge: Edge, view: LinkView | undefined): void {
  edge.setAttrs(attrs(view));
  edge.setLabels(labels(view));
}
