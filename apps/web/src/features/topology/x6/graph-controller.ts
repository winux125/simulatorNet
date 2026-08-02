import type { CellAttrs, Node as X6Node } from "@antv/x6";
import type { DiagramAnnotation, LabDocument } from "@sim/contracts";
import { normalizeCanvasViewport, type CanvasViewport } from "../canvas-navigation";
import {
  calculateAdaptiveLinkAnchors,
  indexAdaptiveLinkLayout,
  type AdaptiveLinkAnchors,
} from "./adaptive-link-anchor";
import { attachCanvasNavigation } from "./canvas-navigation-controller";
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
import type {
  GraphLinkModel,
  Point,
  TopologyGraphCallbacks,
  TopologyGraphController,
  TopologyView,
} from "./types";
import { diagramAssetDataUrl } from "../diagram-image-assets";
import { textAnnotationHeight } from "../diagram-editor";
import {
  isWirelessAssociationEdgeId,
  wirelessAssociationEdgeAppearance,
  wirelessAssociationEdgeId,
  type WirelessAssociationView,
} from "./wireless-association-overlay";
import {
  vpnTunnelEdgeAppearance,
  vpnTunnelEdgeId,
  type VpnTunnelOverlayView,
} from "./vpn-tunnel-overlay";

export interface CreateControllerOptions {
  container: HTMLElement;
  callbacks: TopologyGraphCallbacks;
}

const EMPTY_DOCUMENT_TOPOLOGY = { schemaVersion: 1 as const, nodes: [], links: [] };
const ANNOTATION_PREFIX = "diagram:";
const ANNOTATION_HANDLE_PREFIX = "diagram-handle:";
const ANNOTATION_Z_BASE = -10_000;
const DEVICE_NODE_Z_INDEX = 1_000;
const ANNOTATION_HANDLE_Z_INDEX = 2_000;
const HANDLE_SIZE = 10;

function annotationLayerZIndex(zIndex: number): number {
  return Math.min(TOPOLOGY_EDGE_Z_INDEX - 1, ANNOTATION_Z_BASE + zIndex);
}

function annotationCellId(id: string): string {
  return `${ANNOTATION_PREFIX}${id}`;
}

function annotationId(cellId: string): string | undefined {
  return cellId.startsWith(ANNOTATION_PREFIX) ? cellId.slice(ANNOTATION_PREFIX.length) : undefined;
}

function annotationHandle(cellId: string): { id: string; kind: "resize" | "rotate" | "start" | "end" | "bend" } | undefined {
  if (!cellId.startsWith(ANNOTATION_HANDLE_PREFIX)) return undefined;
  const value = cellId.slice(ANNOTATION_HANDLE_PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator < 1) return undefined;
  const kind = value.slice(separator + 1);
  if (!["resize", "rotate", "start", "end", "bend"].includes(kind)) return undefined;
  return { id: value.slice(0, separator), kind: kind as "resize" | "rotate" | "start" | "end" | "bend" };
}

function dashArray(dash: "solid" | "dashed" | "dotted" | undefined): string | undefined {
  if (dash === "dashed") return "7 4";
  if (dash === "dotted") return "2 3";
  return undefined;
}

function marker(name: "none" | "arrow" | "circle" | "diamond" | undefined) {
  if (!name || name === "none") return null;
  if (name === "arrow") return { name: "classic", size: 7 };
  return { name, size: 6 };
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
    unsavedConfiguration: data.device.unsavedConfiguration,
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
    linkModels: new Map<string, GraphLinkModel>(),
    linkLayout: indexAdaptiveLinkLayout([]),
    anchorHistory: new Map<string, AdaptiveLinkAnchors>(),
    readonly: false,
    draggable: false,
    connectable: false,
    pannable: false,
  };

  const graph = createGraph({
    container: options.container,
    isNodeMovable: (cellId) => {
      if (!state.draggable || state.readonly) return false;
      if (annotationHandle(cellId)) return true;
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
  function readViewport(): CanvasViewport {
    const translation = graph.translate();
    return normalizeCanvasViewport({
      scale: graph.zoom(),
      translateX: translation.tx,
      translateY: translation.ty,
    });
  }

  function writeViewport(viewport: CanvasViewport): void {
    const next = normalizeCanvasViewport(viewport);
    graph.scale(next.scale, next.scale);
    graph.translate(next.translateX, next.translateY);
  }

  // Single viewport owner: trackpad pan, pinch/modifier zoom, middle-mouse and
  // Space drags all route through this handle. No Scroller, no page scroll.
  const navigation = attachCanvasNavigation(
    { container: options.container, getViewport: readViewport, setViewport: writeViewport },
    (viewport) => options.callbacks.onViewportChanged(viewport),
  );

  let adaptiveRefreshFrame: number | undefined;
  let refreshAllLinks = false;
  const nodesAwaitingAnchorRefresh = new Set<string>();

  function refreshLinkProjection(document: LabDocument): void {
    const links = toGraphLinks(document);
    state.linkModels = new Map(links.map((link) => [link.id, link]));
    state.linkLayout = indexAdaptiveLinkLayout(links.map((link) => ({
      id: link.id,
      sourceDeviceId: link.source,
      targetDeviceId: link.target,
    })));
    for (const linkId of state.anchorHistory.keys()) {
      if (!state.linkModels.has(linkId)) state.anchorHistory.delete(linkId);
    }
  }

  function moveInvisiblePort(node: X6Node, portId: string, point: Point): void {
    if (!node.hasPort(portId)) return;
    const bounds = node.getBBox();
    const next = {
      x: Math.round((point.x - bounds.x) * 100) / 100,
      y: Math.round((point.y - bounds.y) * 100) / 100,
    };
    const current = node.portProp<{ x?: number; y?: number }>(portId, "args");
    if (current?.x === next.x && current.y === next.y) return;
    node.portProp(portId, "args", next);
  }

  function anchorsForLink(link: GraphLinkModel): AdaptiveLinkAnchors | undefined {
    const sourceNode = graph.getCellById(link.source);
    const targetNode = graph.getCellById(link.target);
    if (!sourceNode?.isNode() || !targetNode?.isNode()) return undefined;
    const sourceRectangle = sourceNode.getBBox();
    const targetRectangle = targetNode.getBBox();
    const placement = state.linkLayout.parallelPlacement.get(link.id)
      ?? { parallelCount: 1, parallelIndex: 0 };
    const anchors = calculateAdaptiveLinkAnchors({
      sourceRectangle: {
        x: sourceRectangle.x,
        y: sourceRectangle.y,
        width: sourceRectangle.width,
        height: sourceRectangle.height,
      },
      targetRectangle: {
        x: targetRectangle.x,
        y: targetRectangle.y,
        width: targetRectangle.width,
        height: targetRectangle.height,
      },
      sourceCenter: sourceRectangle.getCenter(),
      targetCenter: targetRectangle.getCenter(),
      linkId: link.id,
      ...placement,
      previous: state.anchorHistory.get(link.id),
    });
    moveInvisiblePort(sourceNode, link.sourcePort, anchors.source.point);
    moveInvisiblePort(targetNode, link.targetPort, anchors.target.point);
    state.anchorHistory.set(link.id, anchors);
    return anchors;
  }

  function refreshRenderedLink(linkId: string): void {
    const link = state.linkModels.get(linkId);
    const edge = graph.getCellById(linkId);
    if (!link || !edge?.isEdge()) return;
    updateLinkEdge(edge, link, state.view.links[linkId], anchorsForLink(link));
  }

  function flushAdaptiveRefresh(): void {
    adaptiveRefreshFrame = undefined;
    const ids = new Set<string>();
    if (refreshAllLinks) {
      for (const linkId of state.linkModels.keys()) ids.add(linkId);
    } else {
      for (const nodeId of nodesAwaitingAnchorRefresh) {
        for (const linkId of state.linkLayout.incidentLinkIds.get(nodeId) ?? []) ids.add(linkId);
      }
    }
    refreshAllLinks = false;
    nodesAwaitingAnchorRefresh.clear();
    for (const linkId of ids) refreshRenderedLink(linkId);
  }

  function scheduleAdaptiveRefresh(nodeId?: string): void {
    if (nodeId === undefined) refreshAllLinks = true;
    else if (state.linkLayout.incidentLinkIds.has(nodeId)) nodesAwaitingAnchorRefresh.add(nodeId);
    else return;
    if (adaptiveRefreshFrame === undefined) {
      adaptiveRefreshFrame = window.requestAnimationFrame(flushAdaptiveRefresh);
    }
  }

  const clearConnectionTargetOnPointerEnd = () => clearConnectionTargetState();
  const clearConnectionTargetOnEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") clearConnectionTargetState();
  };
  window.addEventListener("pointerup", clearConnectionTargetOnPointerEnd);
  window.addEventListener("keydown", clearConnectionTargetOnEscape);

  const detach = attachGraphEvents(graph, {
    onNodePositionChanged: (id) => scheduleAdaptiveRefresh(id),
    onNodeMoved: (id, position) => {
      const handle = annotationHandle(id);
      if (handle) {
        const annotation = state.document?.diagram?.annotations.find((candidate) => candidate.id === handle.id);
        if (!annotation) return;
        const point = { x: position.x + HANDLE_SIZE / 2, y: position.y + HANDLE_SIZE / 2 };
        if (handle.kind === "resize" && "position" in annotation) {
          options.callbacks.onAnnotationResized(
            handle.id,
            Math.max(12, point.x - annotation.position.x),
            Math.max(12, point.y - annotation.position.y),
          );
        } else if (handle.kind === "rotate" && "position" in annotation) {
          const center = {
            x: annotation.position.x + annotation.width / 2,
            y: annotation.position.y + (annotation.height ?? 40) / 2,
          };
          options.callbacks.onAnnotationRotated(
            handle.id,
            Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI + 90,
          );
        } else if (handle.kind === "start" || handle.kind === "end" || handle.kind === "bend") {
          options.callbacks.onAnnotationEndpointMoved(handle.id, handle.kind, point);
        }
        return;
      }
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onAnnotationMoved(diagramId, position);
      else options.callbacks.onNodeMoved(id, position);
    },
    onNodeClick: (id, additive) => {
      if (annotationHandle(id)) return;
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onSelectAnnotation(diagramId, additive);
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
    onEdgeClick: (id, additive) => {
      if (isWirelessAssociationEdgeId(id)) return;
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onSelectAnnotation(diagramId, additive);
      else options.callbacks.onSelectLink(id);
    },
    // Double-clicking an edge edits its label inline: a diagram line/arrow
    // label, or the presentation label of a physical topology link.
    onEdgeDoubleClick: (id) => {
      if (isWirelessAssociationEdgeId(id)) return;
      const diagramId = annotationId(id);
      if (diagramId) options.callbacks.onEditAnnotation(diagramId);
      else options.callbacks.onEditLinkLabel(id);
    },
    onEdgeContextMenu: (id, x, y) => {
      if (isWirelessAssociationEdgeId(id)) return;
      if (!annotationId(id)) options.callbacks.onLinkContextMenu(id, x, y);
    },
    onBlankClick: (local) => options.callbacks.onPaneClick(local),
    onBlankPointerDown: (local, modifiers) => options.callbacks.onPanePointerDown(local, modifiers),
    onBlankPointerMove: (local) => options.callbacks.onPanePointerMove(local),
    onBlankPointerUp: (local, modifiers) => options.callbacks.onPanePointerUp(local, modifiers),
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
      // While the inline editor is open it renders the live text in place, so
      // the canvas label is blanked to avoid drawing the old text underneath.
      const editing = state.view.annotations?.[annotation.id]?.editing ?? false;
      return {
        body: {
          fill: annotation.background ?? "transparent",
          stroke: selected ? "var(--color-accent, #2563eb)" : annotation.border ?? "transparent",
          strokeWidth: selected ? Math.max(1.5, annotation.borderWidth ?? 0) : annotation.borderWidth ?? 0,
          strokeDasharray: selected ? "4 3" : undefined,
          opacity: annotation.opacity ?? 1,
        },
        label: {
          text: editing ? "" : annotation.content,
          fill: annotation.foreground === "auto" ? "var(--color-text, #203247)" : annotation.foreground,
          fontSize: annotation.fontSize,
          fontWeight: annotation.bold ? 700 : 400,
          fontStyle: annotation.italic ? "italic" : "normal",
          opacity: annotation.opacity ?? 1,
          textWrap: annotation.autoHeight === false
            ? { width: -12, height: -8, ellipsis: true }
            : undefined,
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
        strokeDasharray: selected ? "5 3" : dashArray(annotation.strokeDash),
        opacity: annotation.opacity ?? 1,
        rx: annotation.type === "rectangle" ? annotation.radius : undefined,
        ry: annotation.type === "rectangle" ? annotation.radius : undefined,
      },
      label: { text: "" },
    };
  }

  function renderAnnotation(annotation: DiagramAnnotation): void {
    const id = annotationCellId(annotation.id);
    const selected = state.view.annotations?.[annotation.id]?.selected ?? false;
    const editing = state.view.annotations?.[annotation.id]?.editing ?? false;
    const existing = graph.getCellById(id);
    if (annotation.type === "line" || annotation.type === "arrow") {
      const labels = annotation.label && !editing
        ? [{ attrs: { label: { text: annotation.label, fill: "var(--color-text, #203247)", fontSize: 11 } }, position: 0.5 }]
        : [];
      const attrs = {
        line: {
          stroke: selected ? "var(--color-accent, #2563eb)" : annotation.stroke,
          strokeWidth: selected ? annotation.strokeWidth + 1 : annotation.strokeWidth,
          strokeDasharray: selected ? "5 3" : dashArray(annotation.strokeDash),
          opacity: annotation.opacity ?? 1,
          targetMarker: marker(annotation.endMarker ?? (annotation.type === "arrow" ? "arrow" : "none")),
          sourceMarker: marker(annotation.startMarker),
        },
      };
      if (existing?.isEdge()) {
        existing.setSource(annotation.start);
        existing.setTarget(annotation.end);
        existing.setVertices(annotation.bend ? [annotation.bend] : []);
        existing.setAttrs(attrs);
        existing.setLabels(labels);
        existing.setZIndex(annotationLayerZIndex(annotation.zIndex));
      } else {
        graph.addEdge({
          id,
          source: annotation.start,
          target: annotation.end,
          vertices: annotation.bend ? [annotation.bend] : [],
          attrs,
          labels,
          zIndex: annotationLayerZIndex(annotation.zIndex),
        });
      }
      return;
    }
    const height = annotation.type === "text" ? textAnnotationHeight(annotation) : annotation.height;
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

  function renderAnnotationHandle(
    annotation: DiagramAnnotation,
    kind: "resize" | "rotate" | "start" | "end" | "bend",
    point: Point,
  ): string {
    const id = `${ANNOTATION_HANDLE_PREFIX}${annotation.id}:${kind}`;
    const existing = graph.getCellById(id);
    const attrs = {
      body: {
        fill: kind === "rotate" ? "var(--color-overlay-panel, #ffffff)" : "var(--color-accent, #2563eb)",
        stroke: "var(--color-accent, #2563eb)",
        strokeWidth: 1.5,
        cursor: kind === "rotate" ? "grab" : "nwse-resize",
      },
      label: { text: "" },
    };
    const x = point.x - HANDLE_SIZE / 2;
    const y = point.y - HANDLE_SIZE / 2;
    if (existing?.isNode()) {
      existing.position(x, y);
      existing.setAttrs(attrs);
      existing.setZIndex(ANNOTATION_HANDLE_Z_INDEX);
    } else {
      graph.addNode({
        id,
        shape: "ellipse",
        x,
        y,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        attrs,
        zIndex: ANNOTATION_HANDLE_Z_INDEX,
      });
    }
    return id;
  }

  function renderAnnotationHandles(annotation: DiagramAnnotation): string[] {
    if (!state.view.annotations?.[annotation.id]?.selected || annotation.locked) return [];
    if (annotation.type === "line" || annotation.type === "arrow") {
      const ids = [
        renderAnnotationHandle(annotation, "start", annotation.start),
        renderAnnotationHandle(annotation, "end", annotation.end),
      ];
      if (annotation.bend) ids.push(renderAnnotationHandle(annotation, "bend", annotation.bend));
      return ids;
    }
    return [
      renderAnnotationHandle(annotation, "resize", {
        x: annotation.position.x + annotation.width,
        y: annotation.position.y + (annotation.type === "text" ? annotation.height ?? 40 : annotation.height),
      }),
      renderAnnotationHandle(annotation, "rotate", {
        x: annotation.position.x + annotation.width / 2,
        y: annotation.position.y - 24,
      }),
    ];
  }

  function render(): void {
    if (!state.document) return;
    const nodes = toGraphNodes(state.document);
    const links = [...state.linkModels.values()];
    const annotations = state.document.diagram?.annotations ?? [];
    const handleIds = annotations.flatMap(renderAnnotationHandles);
    const nodeIds = new Set([
      ...nodes.map((node) => node.id),
      ...handleIds,
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
      ...(state.view.wirelessAssociations ?? []).map((association) =>
        wirelessAssociationEdgeId(association.id)),
      ...(state.view.vpnTunnels ?? []).map((tunnel) => vpnTunnelEdgeId(tunnel.id)),
      ...annotations
        .filter((annotation) => annotation.type === "line" || annotation.type === "arrow")
        .map((annotation) => annotationCellId(annotation.id)),
    ]);
    for (const link of links) {
      const linkView = state.view.links[link.id];
      const anchors = anchorsForLink(link);
      const existing = graph.getCellById(link.id);
      if (existing && existing.isEdge()) updateLinkEdge(existing, link, linkView, anchors);
      else addLinkEdge(graph, link, linkView, anchors);
    }
    for (const association of state.view.wirelessAssociations ?? []) {
      renderWirelessAssociation(association);
    }
    for (const tunnel of state.view.vpnTunnels ?? []) {
      renderVpnTunnel(tunnel);
    }
    for (const cell of graph.getEdges()) {
      if (!linkIds.has(cell.id)) graph.removeCell(cell);
    }
  }

  /**
   * A logical VPN overlay between two tunnel peers. It is drawn as a curved,
   * dashed presentation edge with no port identity: it never becomes a
   * LabDocument link, never opens the cable modal and never triggers a rebuild.
   */
  function renderVpnTunnel(tunnel: VpnTunnelOverlayView): void {
    if (!graph.getCellById(tunnel.localDeviceId) || !graph.getCellById(tunnel.remoteDeviceId)) return;
    const appearance = vpnTunnelEdgeAppearance(tunnel);
    const metadata = {
      kind: "vpn-tunnel",
      localDeviceId: tunnel.localDeviceId,
      remoteDeviceId: tunnel.remoteDeviceId,
      state: tunnel.state,
    };
    const endpoint = (cell: string) => ({
      cell,
      anchor: { name: "center" },
      connectionPoint: { name: "boundary" },
    });
    const attrs = {
      line: {
        stroke: appearance.stroke,
        strokeWidth: 2,
        strokeDasharray: appearance.dashArray,
        sourceMarker: null,
        targetMarker: null,
        pointerEvents: "none",
        "data-vpn-tunnel": tunnel.id,
        "data-vpn-state": tunnel.state,
      },
      wrap: { stroke: "transparent", strokeWidth: 0, pointerEvents: "none" },
    };
    const labels = [{
      attrs: {
        label: {
          text: appearance.label,
          fill: "var(--color-text-muted, #52657a)",
          fontSize: 10,
          fontWeight: 600,
          pointerEvents: "none",
        },
        body: {
          fill: "var(--color-surface-raised, #f4f7fa)",
          stroke: "var(--color-border-subtle, #cbd6e0)",
          strokeWidth: 1,
          rx: 4,
          ry: 4,
          ref: "label",
          refWidth: "120%",
          refHeight: "150%",
          refX: "-10%",
          refY: "-25%",
          pointerEvents: "none",
        },
      },
      position: { distance: 0.5 },
    }];
    const existing = graph.getCellById(appearance.id);
    if (existing?.isEdge()) {
      existing.setSource(endpoint(tunnel.localDeviceId));
      existing.setTarget(endpoint(tunnel.remoteDeviceId));
      existing.setData(metadata, { overwrite: true });
      existing.setAttrs(attrs);
      existing.setLabels(labels);
      existing.setConnector("smooth");
      existing.setZIndex(TOPOLOGY_EDGE_Z_INDEX - 2);
      return;
    }
    graph.addEdge({
      id: appearance.id,
      source: endpoint(tunnel.localDeviceId),
      target: endpoint(tunnel.remoteDeviceId),
      data: metadata,
      attrs,
      labels,
      connector: { name: "smooth" },
      zIndex: TOPOLOGY_EDGE_Z_INDEX - 2,
    });
  }

  function renderWirelessAssociation(association: WirelessAssociationView): void {
    if (
      !graph.getCellById(association.stationDeviceId)
      || !graph.getCellById(association.accessPointDeviceId)
    ) return;
    const appearance = wirelessAssociationEdgeAppearance(association);
    const metadata = {
      kind: "wireless-association",
      stationDeviceId: association.stationDeviceId,
      accessPointDeviceId: association.accessPointDeviceId,
      ssid: association.ssid,
    };
    const source = {
      cell: association.stationDeviceId,
      anchor: { name: "center" },
      connectionPoint: { name: "boundary" },
    };
    const target = {
      cell: association.accessPointDeviceId,
      anchor: { name: "center" },
      connectionPoint: { name: "boundary" },
    };
    const attrs = {
      line: {
        stroke: appearance.stroke,
        strokeWidth: 1.5,
        strokeDasharray: appearance.dashArray,
        sourceMarker: null,
        targetMarker: null,
        pointerEvents: "none",
        "data-wireless-association": association.id,
        "data-wireless-station": association.stationDeviceId,
        "data-wireless-access-point": association.accessPointDeviceId,
      },
      wrap: {
        stroke: "transparent",
        strokeWidth: 0,
        pointerEvents: "none",
      },
    };
    const labels = appearance.label
      ? [{
          attrs: {
            label: {
              text: appearance.label,
              fill: "var(--color-text-muted, #52657a)",
              fontSize: 10,
              fontWeight: 600,
              pointerEvents: "none",
            },
            body: {
              fill: "var(--color-surface-raised, #f4f7fa)",
              stroke: "var(--color-border-subtle, #cbd6e0)",
              strokeWidth: 1,
              rx: 4,
              ry: 4,
              ref: "label",
              refWidth: "120%",
              refHeight: "150%",
              refX: "-10%",
              refY: "-25%",
              pointerEvents: "none",
            },
          },
          position: { distance: 0.5 },
        }]
      : [];
    const existing = graph.getCellById(appearance.id);
    if (existing?.isEdge()) {
      existing.setSource(source);
      existing.setTarget(target);
      existing.setData(metadata, { overwrite: true });
      existing.setAttrs(attrs);
      existing.setLabels(labels);
      existing.setConnector("smooth");
      existing.setZIndex(TOPOLOGY_EDGE_Z_INDEX - 1);
      return;
    }
    graph.addEdge({
      id: appearance.id,
      source,
      target,
      data: metadata,
      attrs,
      labels,
      connector: { name: "smooth" },
      zIndex: TOPOLOGY_EDGE_Z_INDEX - 1,
    });
  }

  return {
    loadDocument(document) {
      state.document = document;
      refreshLinkProjection(document);
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
    updatePannable(pannable) {
      state.pannable = pannable;
      graph.togglePanning(pannable);
    },
    resize(width, height) {
      if (width <= 0 || height <= 0) return;
      graph.resize(width, height);
      scheduleAdaptiveRefresh();
    },
    reanchorLinks() {
      scheduleAdaptiveRefresh();
    },
    fitToContent() {
      graph.zoomToFit({ padding: 24, maxScale: 1.4 });
      navigation.notify();
    },
    zoomIn() {
      navigation.zoomIn();
    },
    zoomOut() {
      navigation.zoomOut();
    },
    // Reset Zoom returns to 100% only. Fit Topology stays a separate action.
    resetZoom() {
      navigation.resetZoom();
    },
    getViewport() {
      return readViewport();
    },
    setViewport(viewport) {
      writeViewport(viewport);
      navigation.notify();
    },
    selectAll() {
      // Selection is owned by the React store (single-selection model); box/
      // multi-selection is a documented follow-up. No graph-level state to set.
    },
    clearSelection() {
      // Mirror of selectAll — the store clears selection; nothing to clear here.
    },
    // Local-coordinate anchor for an edge label, used to place the inline
    // editor exactly over the label it edits. Accepts a domain link id or a
    // diagram line/arrow annotation id.
    getEdgeLabelAnchor(id: string, ratio = 0.5) {
      const cell = graph.getCellById(id) ?? graph.getCellById(annotationCellId(id));
      if (!cell?.isEdge()) return undefined;
      const view = graph.findViewByCell(cell) as { getPointAtRatio?(value: number): Point | null } | null;
      const point = view?.getPointAtRatio?.(Math.min(1, Math.max(0, ratio)));
      return point ? { x: point.x, y: point.y } : undefined;
    },
    clientToLocal(point: Point) {
      const local = graph.clientToLocal(point);
      return { x: local.x, y: local.y };
    },
    localToClient(point: Point) {
      const client = graph.localToClient(point);
      return { x: client.x, y: client.y };
    },
    getDraftTopology() {
      const links = (state.document?.topology ?? EMPTY_DOCUMENT_TOPOLOGY).links;
      return {
        nodes: graph.getNodes().filter((node) => !annotationId(node.id) && !annotationHandle(node.id)).map((node) => {
          const position = node.position();
          return { id: node.id, position: { x: position.x, y: position.y } };
        }),
        links: links.map((link) => ({ id: link.id, a: link.a, b: link.b })),
      };
    },
    destroy() {
      if (adaptiveRefreshFrame !== undefined) {
        window.cancelAnimationFrame(adaptiveRefreshFrame);
        adaptiveRefreshFrame = undefined;
      }
      nodesAwaitingAnchorRefresh.clear();
      state.anchorHistory.clear();
      detach();
      navigation.destroy();
      window.removeEventListener("pointerup", clearConnectionTargetOnPointerEnd);
      window.removeEventListener("keydown", clearConnectionTargetOnEscape);
      graph.dispose();
    },
  };
}

// Re-export the draft-mutation helper so the surface can build links from the
// same validated path used inside the graph.
export { adapterCreateLink as createDraftLink };
