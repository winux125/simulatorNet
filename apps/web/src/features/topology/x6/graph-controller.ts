import type { CellAttrs, Node as X6Node } from "@antv/x6";
import type { DiagramAnnotation, LabDocument } from "@sim/contracts";
import { createGraph } from "./create-graph";
import { addLinkEdge, TOPOLOGY_EDGE_Z_INDEX, updateLinkEdge } from "./edge-registry";
import { attachGraphEvents } from "./graph-events";
import {
  createLink as adapterCreateLink,
  toGraphLinks,
  toGraphNodes,
  validateConnection,
  validateDeviceConnection,
} from "./lab-document-adapter";
import { registerDeviceNode, type DeviceCellData } from "./node-registry";
import { buildPorts, portsMatch } from "./port-registry";
import { NODE_HEIGHT, NODE_WIDTH, portBodyAttrs, SIM_DEVICE_SHAPE } from "./styles";
import type { Point, TopologyGraphCallbacks, TopologyGraphController, TopologyView } from "./types";
import { diagramAssetDataUrl } from "../diagram-image-assets";

export interface CreateControllerOptions {
  container: HTMLElement;
  callbacks: TopologyGraphCallbacks;
}

const EMPTY_DOCUMENT_TOPOLOGY = { schemaVersion: 1 as const, nodes: [], links: [] };
const ANNOTATION_PREFIX = "diagram:";
const ANNOTATION_Z_BASE = -10_000;
const DEVICE_NODE_Z_INDEX = 1_000;

function annotationLayerZIndex(zIndex: number): number {
  return Math.min(TOPOLOGY_EDGE_Z_INDEX - 1, ANNOTATION_Z_BASE + zIndex);
}

function annotationCellId(id: string): string {
  return `${ANNOTATION_PREFIX}${id}`;
}

function annotationId(cellId: string): string | undefined {
  return cellId.startsWith(ANNOTATION_PREFIX) ? cellId.slice(ANNOTATION_PREFIX.length) : undefined;
}

function devicePresentationKey(data: DeviceCellData): string {
  return JSON.stringify({
    hostname: data.device.hostname,
    deviceType: data.device.deviceType,
    status: data.device.status,
    subtitle: data.device.subtitle,
    interfaces: data.device.interfaces,
    serviceBadges: data.device.serviceBadges,
    terminalOpen: data.device.terminalOpen,
    configurationChanged: data.device.configurationChanged,
    connectable: data.device.connectable,
  });
}

/** Instantiate the sole owner of the X6 graph for a topology surface. */
export function createTopologyGraphController(options: CreateControllerOptions): TopologyGraphController {
  registerDeviceNode();

  const clearConnectionTargetState = () => {
    for (const element of options.container.querySelectorAll(".x6-node.is-connection-invalid")) {
      element.classList.remove("is-connection-invalid");
    }
  };
  const showConnectionTargetState = (cellId: string, valid: boolean) => {
    clearConnectionTargetState();
    if (valid) return;
    for (const element of options.container.querySelectorAll<HTMLElement>("[data-cell-id]")) {
      if (element.dataset.cellId === cellId) {
        element.classList.add("is-connection-invalid");
        break;
      }
    }
  };

  const state = {
    document: undefined as LabDocument | undefined,
    view: { nodes: {}, links: {} } as TopologyView,
    readonly: false,
    draggable: false,
    connectable: false,
  };

  const graph = createGraph({
    container: options.container,
    isNodeMovable: (cellId) => {
      if (!state.draggable || state.readonly) return false;
      const id = annotationId(cellId);
      return !id || !state.document?.diagram?.annotations.find((annotation) => annotation.id === id)?.locked;
    },
    isConnectable: () => state.connectable && !state.readonly,
    validateConnection: (sourcePort, targetPort, sourceCell, targetCell) => {
      if (!sourceCell || !targetCell || !state.document) return false;
      if (!sourcePort || !targetPort) {
        const valid = validateDeviceConnection(state.document, sourceCell, targetCell, { locked: state.readonly }).ok;
        showConnectionTargetState(targetCell, valid);
        return valid;
      }
      const valid = validateConnection(state.document, sourceCell, sourcePort, targetCell, targetPort, { locked: state.readonly }).ok;
      showConnectionTargetState(targetCell, valid);
      return valid;
    },
  });
  const clearConnectionTargetOnPointerEnd = () => clearConnectionTargetState();
  const clearConnectionTargetOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") clearConnectionTargetState();
  };
  window.addEventListener("pointerup", clearConnectionTargetOnPointerEnd);
  window.addEventListener("keydown", clearConnectionTargetOnEscape);

  const detach = attachGraphEvents(graph, {
    onNodeMoved: (id, position) => {
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onAnnotationMoved(diagramId, position);
      else options.callbacks.onNodeMoved(id, position);
    },
    onNodeClick: (id) => {
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onSelectAnnotation(diagramId);
    },
    onNodeDoubleClick: (id) => {
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onEditAnnotation(diagramId);
      else options.callbacks.onOpenDevice(id);
    },
    onEdgeConnected: (edge) => {
      clearConnectionTargetState();
      const sourceCell = edge.getSourceCell();
      const targetCell = edge.getTargetCell();
      const sourcePort = edge.getSourcePortId();
      const targetPort = edge.getTargetPortId();
      graph.removeEdge(edge); // Authoritative edges are re-rendered from the draft.
      if (!sourceCell || !targetCell || !state.document) return;
      if (!sourcePort || !targetPort) {
        const result = validateDeviceConnection(state.document, sourceCell.id, targetCell.id, { locked: state.readonly });
        if (!result.ok) { options.callbacks.onConnectionRejected(result.message); return; }
        options.callbacks.onConnectionIntent(sourceCell.id, targetCell.id, sourcePort, targetPort);
        return;
      }
      const result = validateConnection(state.document, sourceCell.id, sourcePort, targetCell.id, targetPort, { locked: state.readonly });
      if (!result.ok) { options.callbacks.onConnectionRejected(result.message); return; }
      options.callbacks.onConnect(sourceCell.id, sourcePort, targetCell.id, targetPort);
    },
    onEdgeClick: (id) => {
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onSelectAnnotation(diagramId);
      else options.callbacks.onSelectLink(id);
    },
    onEdgeContextMenu: (id, x, y) => {
      if (!annotationId(id)) options.callbacks.onLinkContextMenu(id, x, y);
    },
    onBlankClick: (local) => options.callbacks.onPaneClick(local),
    onBlankContextMenu: (x, y) => options.callbacks.onPaneContextMenu(x, y),
    onScale: () => {},
  });

  function upInterfaces(nodeId: string): Set<string> {
    const nodeView = state.view.nodes[nodeId];
    return new Set(nodeView?.data.interfaces.filter((iface) => iface.operationalUp).map((iface) => iface.id));
  }

  function paintPorts(node: X6Node, interfaces: string[], occupied: Set<string>, up: Set<string>): void {
    for (const iface of interfaces) {
      node.portProp(iface, "attrs/circle", portBodyAttrs(occupied.has(iface), up.has(iface)));
    }
  }

  function annotationNodeAttrs(annotation: Exclude<DiagramAnnotation, { type: "line" | "arrow" }>): CellAttrs {
    const selected = state.view.annotations?.[annotation.id]?.selected ?? false;
    if (annotation.type === "image") {
      const asset = state.document?.diagram?.assets?.find((candidate) => candidate.id === annotation.assetId);
      return {
        body: {
          fill: "transparent",
          stroke: selected ? "var(--color-accent, #2563eb)" : "transparent",
          strokeWidth: selected ? 1.5 : 0,
          strokeDasharray: selected ? "4 3" : undefined,
          refWidth: "100%",
          refHeight: "100%",
        },
        image: {
          x: 0,
          y: 0,
          refWidth: "100%",
          refHeight: "100%",
          opacity: annotation.opacity,
          preserveAspectRatio: annotation.preserveAspectRatio ? "xMidYMid meet" : "none",
          xlinkHref: asset ? diagramAssetDataUrl(asset) : "",
        },
      };
    }
    if (annotation.type === "text") {
      return {
        body: {
          fill: annotation.background ?? "transparent",
          stroke: selected ? "var(--color-accent, #2563eb)" : annotation.border ?? "transparent",
          strokeWidth: selected ? 1.5 : annotation.border ? 1 : 0,
          strokeDasharray: selected ? "4 3" : undefined,
        },
        label: {
          text: annotation.content,
          fill: annotation.foreground === "auto" ? "var(--color-text, #203247)" : annotation.foreground,
          fontSize: annotation.fontSize,
          fontWeight: annotation.bold ? 700 : 400,
          fontStyle: annotation.italic ? "italic" : "normal",
          textAnchor: annotation.alignment === "left" ? "start" : annotation.alignment === "right" ? "end" : "middle",
          refX: annotation.alignment === "left" ? 6 : annotation.alignment === "right" ? "100%-6" : "50%",
          textVerticalAnchor: "middle",
          refY: "50%",
        },
      };
    }
    return {
      body: {
        fill: annotation.fill ?? "transparent",
        stroke: selected ? "var(--color-accent, #2563eb)" : annotation.stroke,
        strokeWidth: selected ? annotation.strokeWidth + 1 : annotation.strokeWidth,
        strokeDasharray: selected ? "5 3" : undefined,
      },
      label: { text: "" },
    };
  }

  function renderAnnotation(annotation: DiagramAnnotation): void {
    const id = annotationCellId(annotation.id);
    const selected = state.view.annotations?.[annotation.id]?.selected ?? false;
    const existing = graph.getCellById(id);
    if (annotation.type === "line" || annotation.type === "arrow") {
      const attrs = {
        line: {
          stroke: selected ? "var(--color-accent, #2563eb)" : annotation.stroke,
          strokeWidth: selected ? annotation.strokeWidth + 1 : annotation.strokeWidth,
          targetMarker: annotation.type === "arrow" ? { name: "classic", size: 7 } : null,
          sourceMarker: null,
        },
      };
      if (existing?.isEdge()) {
        existing.setSource(annotation.start);
        existing.setTarget(annotation.end);
        existing.setAttrs(attrs);
        existing.setZIndex(annotationLayerZIndex(annotation.zIndex));
      } else {
        graph.addEdge({
          id,
          source: annotation.start,
          target: annotation.end,
          attrs,
          zIndex: annotationLayerZIndex(annotation.zIndex),
        });
      }
      return;
    }
    const height = annotation.type === "text"
      ? Math.max(annotation.fontSize * Math.max(1.8, annotation.content.split("\n").length * 1.25), 30)
      : annotation.height;
    const shape = annotation.type === "ellipse" ? "ellipse" : "rect";
    const attrs = annotationNodeAttrs(annotation);
    if (existing?.isNode()) {
      existing.position(annotation.position.x, annotation.position.y);
      existing.resize(annotation.width, height);
      existing.setAttrs(attrs);
      existing.rotate(annotation.rotation, { absolute: true });
      existing.setZIndex(annotationLayerZIndex(annotation.zIndex));
    } else {
      graph.addNode({
        id,
        shape,
        markup: annotation.type === "image"
          ? [
              { tagName: "rect", selector: "body" },
              { tagName: "image", selector: "image" },
            ]
          : undefined,
        x: annotation.position.x,
        y: annotation.position.y,
        width: annotation.width,
        height,
        angle: annotation.rotation,
        attrs,
        zIndex: annotationLayerZIndex(annotation.zIndex),
      });
    }
  }

  function render(): void {
    if (!state.document) return;
    const nodes = toGraphNodes(state.document);
    const links = toGraphLinks(state.document);
    const annotations = state.document.diagram?.annotations ?? [];
    const nodeIds = new Set([
      ...nodes.map((node) => node.id),
      ...annotations
        .filter((annotation) => annotation.type !== "line" && annotation.type !== "arrow")
        .map((annotation) => annotationCellId(annotation.id)),
    ]);

    for (const model of nodes) {
      const nodeView = state.view.nodes[model.id];
      const data: DeviceCellData | undefined = nodeView ? { device: nodeView.data, selected: nodeView.selected } : undefined;
      const up = upInterfaces(model.id);
      const occupied = new Set(model.occupiedInterfaces);
      const existing = graph.getCellById(model.id);
      if (existing && existing.isNode()) {
        existing.setZIndex(DEVICE_NODE_Z_INDEX);
        if (data) {
          const previous = existing.getData<DeviceCellData>();
          if (!previous || devicePresentationKey(previous) !== devicePresentationKey(data)) {
            existing.setData(data, { overwrite: true });
          }
          for (const element of options.container.querySelectorAll<HTMLElement>("[data-device-id]")) {
            if (element.dataset.deviceId === model.id) {
              element.closest(".x6-node")?.classList.toggle("is-selected", data.selected);
              element.querySelector("button")?.setAttribute("aria-pressed", String(data.selected));
              break;
            }
          }
        }
        const position = existing.position();
        if (position.x !== model.position.x || position.y !== model.position.y) {
          existing.position(model.position.x, model.position.y);
        }
        if (portsMatch(existing.getPorts().map((port) => port.id), model.interfaces)) {
          paintPorts(existing, model.interfaces, occupied, up);
        } else {
          existing.prop("ports", buildPorts(model, up));
        }
      } else {
        graph.addNode({
          id: model.id,
          shape: SIM_DEVICE_SHAPE,
          x: model.position.x,
          y: model.position.y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
          data,
          ports: buildPorts(model, up),
          zIndex: DEVICE_NODE_Z_INDEX,
        });
      }
    }
    for (const annotation of annotations) renderAnnotation(annotation);
    for (const cell of graph.getNodes()) {
      if (!nodeIds.has(cell.id)) graph.removeCell(cell);
    }

    const linkIds = new Set([
      ...links.map((link) => link.id),
      ...annotations
        .filter((annotation) => annotation.type === "line" || annotation.type === "arrow")
        .map((annotation) => annotationCellId(annotation.id)),
    ]);
    for (const link of links) {
      const linkView = state.view.links[link.id];
      const existing = graph.getCellById(link.id);
      if (existing && existing.isEdge()) updateLinkEdge(existing, link, linkView);
      else addLinkEdge(graph, link, linkView);
    }
    for (const cell of graph.getEdges()) {
      if (!linkIds.has(cell.id)) graph.removeCell(cell);
    }
  }

  function reanchorRenderedLinks(): void {
    if (!state.document) return;
    for (const link of toGraphLinks(state.document)) {
      const edge = graph.getCellById(link.id);
      if (edge?.isEdge()) updateLinkEdge(edge, link, state.view.links[link.id]);
    }
  }

  return {
    loadDocument(document) {
      state.document = document;
      render();
    },
    applyView(view) {
      state.view = view;
      render();
    },
    updateReadonlyState(readonly) {
      state.readonly = readonly;
    },
    updateDraggable(draggable) {
      state.draggable = draggable;
    },
    updateConnectable(connectable) {
      state.connectable = connectable;
    },
    resize(width, height) {
      if (width <= 0 || height <= 0) return;
      graph.resize(width, height);
      reanchorRenderedLinks();
    },
    reanchorLinks() {
      reanchorRenderedLinks();
    },
    fitToContent() {
      graph.zoomToFit({ padding: 24, maxScale: 1.4 });
    },
    zoomIn() {
      graph.zoom(0.15);
    },
    zoomOut() {
      graph.zoom(-0.15);
    },
    resetZoom() {
      graph.zoomTo(1);
    },
    selectAll() {
      // Selection is owned by the React store (single-selection model); box/
      // multi-selection is a documented follow-up. No graph-level state to set.
    },
    clearSelection() {
      // Mirror of selectAll — the store clears selection; nothing to clear here.
    },
    clientToLocal(point: Point) {
      const local = graph.clientToLocal(point);
      return { x: local.x, y: local.y };
    },
    getDraftTopology() {
      const links = (state.document?.topology ?? EMPTY_DOCUMENT_TOPOLOGY).links;
      return {
        nodes: graph.getNodes().filter((node) => !annotationId(node.id)).map((node) => {
          const position = node.position();
          return { id: node.id, position: { x: position.x, y: position.y } };
        }),
        links: links.map((link) => ({ id: link.id, a: link.a, b: link.b })),
      };
    },
    destroy() {
      detach();
      window.removeEventListener("pointerup", clearConnectionTargetOnPointerEnd);
      window.removeEventListener("keydown", clearConnectionTargetOnEscape);
      graph.dispose();
    },
  };
}

// Re-export the draft-mutation helper so the surface can build links from the
// same validated path used inside the graph.
export { adapterCreateLink as createDraftLink };
