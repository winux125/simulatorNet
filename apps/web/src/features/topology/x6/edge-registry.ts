import type { Edge, Graph } from "@antv/x6";
import { edgeLabelAttrs, edgeLineAttrs } from "./styles";
import type { GraphLinkModel, LinkView } from "./types";

// Edge creation/update. Edges reference specific ports so a link always binds a
// pair of interfaces, never whole devices.

function attrs(view: LinkView | undefined) {
  return { line: edgeLineAttrs(view?.operational ?? false, view?.selected ?? false) };
}

function labels(view: LinkView | undefined) {
  if (!view) return [];
  const result = [];
  if (view.sourceLabel) {
    result.push({ attrs: edgeLabelAttrs(view.sourceLabel), position: { distance: 0.13, offset: -10 } });
  }
  if (view.diagramLabel?.text) {
    result.push({
      attrs: edgeLabelAttrs(view.diagramLabel.text, "diagram"),
      position: {
        distance: view.diagramLabel.position,
        offset: view.diagramLabel.offset,
        options: { keepGradient: view.diagramLabel.followLink, ensureLegibility: true },
      },
    });
  }
  if (view.targetLabel) {
    result.push({ attrs: edgeLabelAttrs(view.targetLabel), position: { distance: 0.87, offset: -10 } });
  }
  return result;
}

export function addLinkEdge(graph: Graph, link: GraphLinkModel, view: LinkView | undefined): Edge {
  return graph.addEdge({
    id: link.id,
    source: { cell: link.source, port: link.sourcePort },
    target: { cell: link.target, port: link.targetPort },
    attrs: attrs(view),
    labels: labels(view),
    router: { name: "normal" },
    connector: { name: "normal" },
    zIndex: -1,
  });
}

export function updateLinkEdge(edge: Edge, view: LinkView | undefined): void {
  edge.setAttrs(attrs(view));
  edge.setLabels(labels(view));
}
