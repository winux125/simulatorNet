import type { Node as X6Node } from "@antv/x6";
import type { LabDocument } from "@sim/contracts";
import { createGraph } from "./create-graph";
import { addLinkEdge, updateLinkEdge } from "./edge-registry";
import { attachGraphEvents } from "./graph-events";
import { createLink as adapterCreateLink, toGraphLinks, toGraphNodes, validateConnection } from "./lab-document-adapter";
import { registerDeviceNode, type DeviceCellData } from "./node-registry";
import { buildPorts, portsMatch } from "./port-registry";
import { NODE_HEIGHT, NODE_WIDTH, portBodyAttrs, SIM_DEVICE_SHAPE } from "./styles";
import type { Point, TopologyGraphCallbacks, TopologyGraphController, TopologyView } from "./types";

export interface CreateControllerOptions {
  container: HTMLElement;
  callbacks: TopologyGraphCallbacks;
}

const EMPTY_DOCUMENT_TOPOLOGY = { schemaVersion: 1 as const, nodes: [], links: [] };

/** Instantiate the sole owner of the X6 graph for a topology surface. */
export function createTopologyGraphController(options: CreateControllerOptions): TopologyGraphController {
  registerDeviceNode();

  const state = {
    document: undefined as LabDocument | undefined,
    view: { nodes: {}, links: {} } as TopologyView,
    readonly: false,
    draggable: false,
    connectable: false,
  };

  const graph = createGraph({
    container: options.container,
    isNodeMovable: () => state.draggable && !state.readonly,
    isConnectable: () => state.connectable && !state.readonly,
    validateConnection: (sourcePort, targetPort, sourceCell, targetCell) => {
      if (!sourcePort || !targetPort || !sourceCell || !targetCell || !state.document) return false;
      return validateConnection(state.document, sourceCell, sourcePort, targetCell, targetPort, { locked: state.readonly }).ok;
    },
  });

  const detach = attachGraphEvents(graph, {
    onNodeMoved: (id, position) => options.callbacks.onNodeMoved(id, position),
    onEdgeConnected: (edge) => {
      const sourceCell = edge.getSourceCell();
      const targetCell = edge.getTargetCell();
      const sourcePort = edge.getSourcePortId();
      const targetPort = edge.getTargetPortId();
      graph.removeEdge(edge); // Authoritative edges are re-rendered from the draft.
      if (!sourceCell || !targetCell || !sourcePort || !targetPort || !state.document) return;
      const result = validateConnection(state.document, sourceCell.id, sourcePort, targetCell.id, targetPort, { locked: state.readonly });
      if (!result.ok) { options.callbacks.onConnectionRejected(result.message); return; }
      options.callbacks.onConnect(sourceCell.id, sourcePort, targetCell.id, targetPort);
    },
    onEdgeClick: (id) => options.callbacks.onSelectLink(id),
    onEdgeContextMenu: (id, x, y) => options.callbacks.onLinkContextMenu(id, x, y),
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

  function render(): void {
    if (!state.document) return;
    const nodes = toGraphNodes(state.document);
    const links = toGraphLinks(state.document);
    const nodeIds = new Set(nodes.map((node) => node.id));

    for (const model of nodes) {
      const nodeView = state.view.nodes[model.id];
      const data: DeviceCellData | undefined = nodeView ? { device: nodeView.data, selected: nodeView.selected } : undefined;
      const up = upInterfaces(model.id);
      const occupied = new Set(model.occupiedInterfaces);
      const existing = graph.getCellById(model.id);
      if (existing && existing.isNode()) {
        if (data) existing.setData(data, { overwrite: true });
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
        });
      }
    }
    for (const cell of graph.getNodes()) {
      if (!nodeIds.has(cell.id)) graph.removeCell(cell);
    }

    const linkIds = new Set(links.map((link) => link.id));
    for (const link of links) {
      const linkView = state.view.links[link.id];
      const existing = graph.getCellById(link.id);
      if (existing && existing.isEdge()) updateLinkEdge(existing, linkView);
      else addLinkEdge(graph, link, linkView);
    }
    for (const cell of graph.getEdges()) {
      if (!linkIds.has(cell.id)) graph.removeCell(cell);
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
        nodes: graph.getNodes().map((node) => {
          const position = node.position();
          return { id: node.id, position: { x: position.x, y: position.y } };
        }),
        links: links.map((link) => ({ id: link.id, a: link.a, b: link.b })),
      };
    },
    destroy() {
      detach();
      graph.dispose();
    },
  };
}

// Re-export the draft-mutation helper so the surface can build links from the
// same validated path used inside the graph.
export { adapterCreateLink as createDraftLink };
