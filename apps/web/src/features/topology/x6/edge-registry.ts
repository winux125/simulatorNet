import type { Edge, Graph } from "@antv/x6";
import { edgeLabelAttrs, edgeLineAttrs } from "./styles";
import type { AdaptiveAnchorSide, AdaptiveLinkAnchors } from "./adaptive-link-anchor";
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

function attrs(
  link: GraphLinkModel,
  view: LinkView | undefined,
  anchors: AdaptiveLinkAnchors | undefined,
) {
  return {
    line: {
      ...edgeLineAttrs(view?.operational ?? false, view?.selected ?? false),
      "data-link-id": link.id,
      "data-source-device": link.source,
      "data-source-interface": link.sourcePort,
      "data-target-device": link.target,
      "data-target-interface": link.targetPort,
      "data-source-side": anchors?.source.side,
      "data-target-side": anchors?.target.side,
      "data-parallel-offset": anchors?.source.parallelLinkOffset,
    },
    wrap: {
      stroke: "transparent",
      strokeWidth: 12,
      cursor: "pointer",
    },
  };
}

function labelOffset(direction: AdaptiveAnchorSide | undefined): { x: number; y: number } {
  if (direction === "left") return { x: -8, y: 0 };
  if (direction === "right") return { x: 8, y: 0 };
  if (direction === "top") return { x: 0, y: -8 };
  if (direction === "bottom") return { x: 0, y: 8 };
  return { x: 0, y: -10 };
}

function labels(view: LinkView | undefined, anchors: AdaptiveLinkAnchors | undefined) {
  if (!view) return [];
  const result = [];
  if (view.sourceLabel) {
    result.push({
      attrs: edgeLabelAttrs(view.sourceLabel),
      position: {
        distance: 18,
        offset: labelOffset(anchors?.source.labelDirection),
        options: { absoluteDistance: true, absoluteOffset: true },
      },
    });
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
    result.push({
      attrs: edgeLabelAttrs(view.targetLabel),
      position: {
        distance: -18,
        offset: labelOffset(anchors?.target.labelDirection),
        options: { absoluteDistance: true, absoluteOffset: true },
      },
    });
  }
  return result;
}

export function addLinkEdge(
  graph: Graph,
  link: GraphLinkModel,
  view: LinkView | undefined,
  anchors?: AdaptiveLinkAnchors,
): Edge {
  return graph.addEdge({
    id: link.id,
    source: { cell: link.source, port: link.sourcePort },
    target: { cell: link.target, port: link.targetPort },
    data: domainLinkEdgeData(link),
    attrs: attrs(link, view, anchors),
    labels: labels(view, anchors),
    vertices: link.vertices,
    router: { name: link.route === "orthogonal" ? "orth" : "normal" },
    connector: { name: "normal" },
    zIndex: TOPOLOGY_EDGE_Z_INDEX,
  });
}

export function updateLinkEdge(
  edge: Edge,
  link: GraphLinkModel,
  view: LinkView | undefined,
  anchors?: AdaptiveLinkAnchors,
): void {
  edge.setSource({ cell: link.source, port: link.sourcePort });
  edge.setTarget({ cell: link.target, port: link.targetPort });
  edge.setData(domainLinkEdgeData(link), { overwrite: true });
  edge.setAttrs(attrs(link, view, anchors));
  edge.setLabels(labels(view, anchors));
  edge.setVertices(link.vertices);
  edge.setRouter(link.route === "orthogonal" ? "orth" : "normal");
  edge.setConnector("normal");
  edge.setZIndex(TOPOLOGY_EDGE_Z_INDEX);
}
