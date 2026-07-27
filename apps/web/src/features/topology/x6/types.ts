import type { LabDocument } from "@sim/contracts";
import type { CanvasViewport } from "../canvas-navigation";
import type { DeviceNodeData } from "../DeviceNode";

// Plain-JSON view models exchanged between React and the X6 adapter. X6 never
// owns network truth — it only presents/edits this projection of the draft
// LabDocument. Runtime state (engine, devices, CLI, packet trace) stays in the
// worker behind SimWorkerClient.

export interface Point {
  x: number;
  y: number;
}

/** Structural node projection derived from a LabDocument node. */
export interface GraphNodeModel {
  id: string;
  position: Point;
  interfaces: string[];
  occupiedInterfaces: string[];
}

/** Structural link projection derived from a LabDocument link. */
export interface GraphLinkModel {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  route: "straight" | "orthogonal";
  vertices: Point[];
}

/** Per-node live presentation overlay (status, badges, selection, handlers). */
export interface NodeView {
  data: DeviceNodeData;
  selected: boolean;
}

/** Per-link live presentation overlay. */
export interface LinkView {
  operational: boolean;
  selected: boolean;
  sourceLabel?: string;
  targetLabel?: string;
  diagramLabel?: {
    text: string;
    position: number;
    followLink: boolean;
    offset: number;
  };
}

export interface TopologyView {
  nodes: Record<string, NodeView>;
  links: Record<string, LinkView>;
  wirelessAssociations?: Array<{
    id: string;
    stationDeviceId: string;
    accessPointDeviceId: string;
    ssid: string;
    state:
      | "disabled"
      | "disconnected"
      | "scanning"
      | "authenticating"
      | "associating"
      | "associated"
      | "failed";
  }>;
  /** `editing` blanks the rendered text while the inline editor draws it live. */
  annotations?: Record<string, { selected: boolean; editing?: boolean }>;
}

/** The draft topology as currently held by the graph (positions + wiring). */
export interface TopologyDraftNode {
  id: string;
  position: Point;
}
export interface TopologyDraftLink {
  id: string;
  a: { node: string; iface: string };
  b: { node: string; iface: string };
}
export interface TopologyDraft {
  nodes: TopologyDraftNode[];
  links: TopologyDraftLink[];
}

export type ConnectionValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

/** Callbacks the controller raises for the React layer to fold into the draft. */
export interface TopologyGraphCallbacks {
  onNodeMoved(id: string, position: Point): void;
  onSelectNode(id: string): void;
  onOpenDevice(id: string): void;
  onConnectionIntent(source: string, target: string, sourcePort?: string, targetPort?: string): void;
  onConnect(source: string, sourcePort: string, target: string, targetPort: string): void;
  onConnectionRejected(message: string): void;
  onSelectLink(id: string): void;
  onLinkContextMenu(id: string, clientX: number, clientY: number): void;
  onSelectAnnotation(id: string, additive: boolean): void;
  onEditAnnotation(id: string): void;
  /** Double-clicked a physical link: edit its presentation label inline. */
  onEditLinkLabel(id: string): void;
  onAnnotationMoved(id: string, position: Point): void;
  onAnnotationResized(id: string, width: number, height: number): void;
  onAnnotationRotated(id: string, rotation: number): void;
  onAnnotationEndpointMoved(id: string, endpoint: "start" | "end" | "bend", point: Point): void;
  onPaneClick(local: Point): void;
  onPanePointerDown(local: Point, modifiers: { shift: boolean; alt: boolean }): void;
  onPanePointerMove(local: Point): void;
  onPanePointerUp(local: Point, modifiers: { shift: boolean; alt: boolean }): void;
  onPaneContextMenu(clientX: number, clientY: number): void;
  onDropDevice(kind: string, local: Point): void;
  /** Local viewport changed (pan/zoom/fit). Presentation only — never persisted in a lab. */
  onViewportChanged(viewport: CanvasViewport): void;
}

/**
 * The single seam through which the app drives the X6 topology graph. All X6
 * API access lives behind this interface; React components never call X6
 * directly. Every subscription created here is removed by `destroy()`.
 */
export interface TopologyGraphController {
  loadDocument(document: LabDocument): void;
  applyView(view: TopologyView): void;
  /** Emergency coarse lock; normal running mode uses connectable=false while keeping layout draggable. */
  updateReadonlyState(readonly: boolean): void;
  /** Fine tool gating within edit mode. */
  updateDraggable(draggable: boolean): void;
  updateConnectable(connectable: boolean): void;
  updatePannable(pannable: boolean): void;
  /** Resize the paper without changing world coordinates, translation, or zoom. */
  resize(width: number, height: number): void;
  /** Rebind every rendered edge to its stable device/interface endpoints. */
  reanchorLinks(): void;
  fitToContent(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  getViewport(): CanvasViewport;
  /** Restore a locally remembered viewport without fitting or rebuilding. */
  setViewport(viewport: CanvasViewport): void;
  selectAll(): void;
  clearSelection(): void;
  clientToLocal(point: Point): Point;
  localToClient(point: Point): Point;
  /** Local point on an edge (domain link or diagram line) where its label sits. */
  getEdgeLabelAnchor(id: string, ratio?: number): Point | undefined;
  getDraftTopology(): TopologyDraft;
  destroy(): void;
}
