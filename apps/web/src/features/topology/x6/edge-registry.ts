import type { Edge, Graph } from "@antv/x6";
import { edgeLabelAttrs, edgeLineAttrs } from "./styles";
import type { GraphLinkModel, LinkView } from "./types";

// Edge creation/update. Edges reference specific ports so a link always binds a
// pair of interfaces, never whole devices.

export const TOPOLOGY_EDGE_Z_INDEX = 100;

export interface DomainLinkEdgeData {
  kind: "topology-link";
  linkId: string;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
}

export function domainLinkEdgeData(link: GraphLinkModel): DomainLinkEdgeData {
  return {
    kind: "topology-link",
    linkId: link.id,
    sourceDeviceId: link.source,
    sourceInterfaceId: link.sourcePort,
    targetDeviceId: link.target,
    targetInterfaceId: link.targetPort,
  };
}

function attrs(link: GraphLinkModel, view: LinkView | undefined) {
  return {
    line: {
      ...edgeLineAttrs(view?.operational ?? false, view?.selected ?? false),
      "data-link-id": link.id,
      "data-source-device": link.source,
      "data-source-interface": link.sourcePort,
      "data-target-device": link.target,
      "data-target-interface": link.targetPort,
    },
    wrap: {
      stroke: "transparent",
      strokeWidth: 12,
      cursor: "pointer",
    },
  };
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
    data: domainLinkEdgeData(link),
    attrs: attrs(link, view),
    labels: labels(view),
    vertices: link.vertices,
    router: { name: link.route === "orthogonal" ? "orth" : "normal" },
    connector: { name: "normal" },
    zIndex: TOPOLOGY_EDGE_Z_INDEX,
  });
}

export function updateLinkEdge(edge: Edge, link: GraphLinkModel, view: LinkView | undefined): void {
  edge.setSource({ cell: link.source, port: link.sourcePort });
  edge.setTarget({ cell: link.target, port: link.targetPort });
  edge.setData(domainLinkEdgeData(link), { overwrite: true });
  edge.setAttrs(attrs(link, view));
  edge.setLabels(labels(view));
  edge.setVertices(link.vertices);
  edge.setRouter(link.route === "orthogonal" ? "orth" : "normal");
  edge.setConnector("normal");
  edge.setZIndex(TOPOLOGY_EDGE_Z_INDEX);
}
