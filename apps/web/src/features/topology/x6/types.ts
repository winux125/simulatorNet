import type { LabDocument } from "@sim/contracts";
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
  annotations?: Record<string, { selected: boolean }>;
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
  onSelectAnnotation(id: string): void;
  onAnnotationMoved(id: string, position: Point): void;
  onPaneClick(local: Point): void;
  onPaneContextMenu(clientX: number, clientY: number): void;
  onDropDevice(kind: string, local: Point): void;
}

/**
 * The single seam through which the app drives the X6 topology graph. All X6
 * API access lives behind this interface; React components never call X6
 * directly. Every subscription created here is removed by `destroy()`.
 */
export interface TopologyGraphController {
  loadDocument(document: LabDocument): void;
  applyView(view: TopologyView): void;
  /** Coarse topology lock (simulate mode / running lab): blocks all mutation. */
  updateReadonlyState(readonly: boolean): void;
  /** Fine tool gating within edit mode. */
  updateDraggable(draggable: boolean): void;
  updateConnectable(connectable: boolean): void;
  fitToContent(): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  selectAll(): void;
  clearSelection(): void;
  clientToLocal(point: Point): Point;
  getDraftTopology(): TopologyDraft;
  destroy(): void;
}
