import {
  DEVICE_TYPES,
  getDeviceProfile,
  type DiagramAnnotation,
  type LabDocument,
  type NodeSpec,
} from "@sim/contracts";
import type { LabUiSnapshot } from "@sim/sim-worker";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Cable,
  Eye,
  FilePlus2,
  FlaskConical,
  Italic,
  Maximize2,
  Monitor,
  Network,
  Router as RouterIcon,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { PortLabelMode, WorkspaceMode, WorkspaceTool } from "../../state/workspace-store";
import { Button, StatusIndicator } from "../../ui";
import {
  addDiagramAnnotation,
  addDraftDevice,
  allocateId,
  changeDiagramAnnotationZOrder,
  duplicateDraftDevice,
  moveDiagramAnnotation,
  removeDiagramAnnotation,
  removeDraftDevice,
  removeDraftLink,
  renameDraftDevice,
  updateDiagramAnnotation,
  withDiagramLinkLabel,
  withNodePosition,
} from "../lab/document";
import { TopologyGraphSurface } from "./TopologyGraphSurface";
import { portLabelsVisible } from "./diagram-presentation";
import { createLink } from "./x6/lab-document-adapter";
import type { Point, TopologyView } from "./x6/types";

interface TopologyCanvasProps {
  document: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  pendingDeviceKind: NodeSpec["kind"] | undefined;
  selectedNodeId: string | undefined;
  selectedLinkId: string | undefined;
  terminalTabs: string[];
  portLabelMode: PortLabelMode;
  fitRequest: number;
  zoomResetRequest: number;
  zoomInRequest: number;
  zoomOutRequest: number;
  onSelectNode(id: string | undefined): void;
  onSelectLink(id: string | undefined): void;
  onOpenTerminal(id: string): void;
  onOpenDevice(id: string): void;
  onInspect(id: string): void;
  onPlacedDevice(): void;
  onPortLabelMode(mode: PortLabelMode): void;
  onChange(document: LabDocument): void;
  onError(message: string): void;
  onLoadDemo(): void;
  onNewLab(): void;
  onImportLab(): void;
}

type ContextMenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "link"; id: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number };

const ANNOTATION_TOOLS = new Set<WorkspaceTool>([
  "annotation-text",
  "annotation-rectangle",
  "annotation-ellipse",
  "annotation-line",
  "annotation-arrow",
]);

function createAnnotation(document: LabDocument, tool: WorkspaceTool, position: Point): DiagramAnnotation | undefined {
  if (!ANNOTATION_TOOLS.has(tool)) return undefined;
  const id = allocateId("annotation", document.diagram?.annotations.map((annotation) => annotation.id) ?? []);
  const zIndex = Math.max(0, ...(document.diagram?.annotations.map((annotation) => annotation.zIndex) ?? [])) + 1;
  if (tool === "annotation-text") {
    return {
      id, type: "text", position, width: 180, content: "Text label", fontSize: 16,
      bold: false, italic: false, alignment: "left", foreground: "auto", zIndex, rotation: 0,
    };
  }
  if (tool === "annotation-line" || tool === "annotation-arrow") {
    return {
      id,
      type: tool === "annotation-line" ? "line" : "arrow",
      start: position,
      end: { x: position.x + 180, y: position.y },
      stroke: "#4d7fa9",
      strokeWidth: 1.5,
      zIndex,
    };
  }
  return {
    id,
    type: tool === "annotation-ellipse" ? "ellipse" : "rectangle",
    position,
    width: 180,
    height: 100,
    stroke: "#4d7fa9",
    strokeWidth: 1.5,
    zIndex,
    rotation: 0,
  };
}

export function TopologyCanvas(props: TopologyCanvasProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const graphApi = useRef<{ clientToLocal(point: Point): Point; fit(): void } | undefined>(undefined);
  const status = useMemo(() => new Map(props.snapshot?.nodes.map((node) => [node.id, node])), [props.snapshot]);
  const editable = props.mode === "edit";

  const openNodeMenu = useCallback((id: string, event: ReactMouseEvent) => {
    event.preventDefault();
    setSelectedAnnotationId(undefined);
    setContextMenu({ kind: "node", id, x: event.clientX, y: event.clientY });
  }, []);

  const view = useMemo<TopologyView>(() => {
    const result: TopologyView = { nodes: {}, links: {}, annotations: {} };
    if (!props.document) return result;
    for (const node of props.document.topology.nodes) {
      const live = status.get(node.id);
      const ip = live?.interfaces.find((iface) => iface.ipAddress)?.ipAddress;
      const subtitle = node.kind === "pc" || node.kind === "server"
        ? ip ?? "No IPv4 address"
        : `${node.interfaces.length} ports`;
      const original = props.snapshot?.nodes.find((candidate) => candidate.id === node.id);
      const changed = !original || original.position.x !== node.position?.x || original.position.y !== node.position?.y;
      result.nodes[node.id] = {
        selected: props.selectedNodeId === node.id,
        data: {
          hostname: live?.hostname ?? props.document.configurations[node.id]?.hostname ?? node.name ?? node.id,
          deviceType: node.kind,
          status: live?.status ?? "down",
          subtitle,
          interfaces: node.interfaces.map((iface) => ({
            id: iface.id,
            operationalUp: live?.interfaces.find((candidate) => candidate.id === iface.id)?.operationalUp ?? false,
          })),
          serviceBadges: live?.serviceBadges,
          terminalOpen: props.terminalTabs.includes(node.id),
          configurationChanged: changed,
          onActivate: props.onSelectNode,
          onOpen: props.onOpenDevice,
          onContextMenu: openNodeMenu,
        },
      };
    }
    for (const link of props.document.topology.links) {
      const sourceInterface = status.get(link.a.node)?.interfaces.find((iface) => iface.id === link.a.iface);
      const targetInterface = status.get(link.b.node)?.interfaces.find((iface) => iface.id === link.b.iface);
      const selected = props.selectedLinkId === link.id;
      const showPorts = portLabelsVisible(props.portLabelMode, selected);
      const diagramLabel = props.document.diagram?.linkLabels.find((label) => label.linkId === link.id && label.visible);
      result.links[link.id] = {
        operational: Boolean(sourceInterface?.operationalUp && targetInterface?.operationalUp),
        selected,
        sourceLabel: showPorts ? link.a.iface : undefined,
        targetLabel: showPorts ? link.b.iface : undefined,
        diagramLabel: diagramLabel
          ? {
              text: diagramLabel.text,
              position: diagramLabel.position,
              followLink: diagramLabel.followLink,
              offset: diagramLabel.offset,
            }
          : undefined,
      };
    }
    for (const annotation of props.document.diagram?.annotations ?? []) {
      result.annotations![annotation.id] = { selected: annotation.id === selectedAnnotationId };
    }
    return result;
  }, [props, status, openNodeMenu, selectedAnnotationId]);

  if (!props.document) {
    return (
      <section className="topology-empty" aria-label="Topology canvas">
        <div className="welcome-workspace">
          <span className="welcome-workspace__mark" aria-hidden="true"><Network size={26} /></span>
          <p className="section-eyebrow">Browser network laboratory</p>
          <h1>SimulatorNet</h1>
          <p>Create and test deterministic network topologies directly in your browser.</p>
          <div className="welcome-workspace__actions">
            <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={props.onNewLab}>New Lab</Button>
            <Button icon={<Upload size={15} />} onClick={props.onImportLab}>Import Lab</Button>
            <Button icon={<FlaskConical size={15} />} onClick={props.onLoadDemo}>Load Demo Lab</Button>
          </div>
          <ul><li>Runs locally in your browser</li><li>Cisco-like CLI</li><li>Deterministic simulation</li></ul>
        </div>
      </section>
    );
  }

  const document = props.document;
  const selectedAnnotation = document.diagram?.annotations.find((annotation) => annotation.id === selectedAnnotationId);
  const addAt = (kind: NodeSpec["kind"], position?: Point) => {
    if (!editable) return;
    props.onChange(addDraftDevice(document, kind, position));
    setContextMenu(undefined);
  };
  const addFromPane = (kind: NodeSpec["kind"]) => {
    const position = contextMenu?.kind === "pane" && graphApi.current
      ? graphApi.current.clientToLocal({ x: contextMenu.x, y: contextMenu.y })
      : undefined;
    addAt(kind, position);
  };
  const paneClick = (local: Point) => {
    setContextMenu(undefined);
    if (editable && props.pendingDeviceKind) {
      addAt(props.pendingDeviceKind, local);
      props.onPlacedDevice();
      return;
    }
    if (editable) {
      const annotation = createAnnotation(document, props.activeTool, local);
      if (annotation) {
        props.onChange(addDiagramAnnotation(document, annotation));
        setSelectedAnnotationId(annotation.id);
        props.onPlacedDevice();
        return;
      }
    }
    setSelectedAnnotationId(undefined);
    props.onSelectNode(undefined);
    props.onSelectLink(undefined);
  };

  const contextAction = (action: string) => {
    if (!contextMenu) return;
    if (contextMenu.kind === "node") {
      if (action === "terminal") props.onOpenTerminal(contextMenu.id);
      if (action === "inspect") props.onInspect(contextMenu.id);
      if (action === "rename") {
        const current = document.configurations[contextMenu.id]?.hostname ?? contextMenu.id;
        const next = window.prompt("Device hostname", current);
        if (next) props.onChange(renameDraftDevice(document, contextMenu.id, next));
      }
      if (action === "duplicate") props.onChange(duplicateDraftDevice(document, contextMenu.id));
      if (action === "delete") props.onChange(removeDraftDevice(document, contextMenu.id));
    }
    if (contextMenu.kind === "link") {
      if (action === "inspect") props.onSelectLink(contextMenu.id);
      if (action === "label") {
        const current = document.diagram?.linkLabels.find((label) => label.linkId === contextMenu.id)?.text ?? "";
        const next = window.prompt("Link annotation", current);
        if (next !== null) props.onChange(withDiagramLinkLabel(document, contextMenu.id, { text: next, visible: true }));
      }
      if (action === "delete") props.onChange(removeDraftLink(document, contextMenu.id));
    }
    setContextMenu(undefined);
  };

  const updateSelected = (next: DiagramAnnotation) => {
    props.onChange(updateDiagramAnnotation(document, next));
  };

  return (
    <section
      className={`topology-panel topology-panel--${props.mode}`}
      aria-label="Topology canvas"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="canvas-statusbar">
        <StatusIndicator status={props.mode === "edit" ? "unsaved" : "ready"} label={props.mode === "edit" ? "Edit topology" : "Lab running"} />
        <span>{document.topology.nodes.length} devices</span>
        <span>{document.topology.links.length} links</span>
        {props.activeTool === "add-link" && <strong><Cable size={12} /> Drag between interface endpoints</strong>}
        {ANNOTATION_TOOLS.has(props.activeTool) && <strong>Click the canvas to place annotation</strong>}
        <button
          type="button"
          aria-label="Toggle link labels"
          aria-pressed={props.portLabelMode !== "hidden"}
          onClick={() => props.onPortLabelMode(props.portLabelMode === "hidden" ? "always" : "hidden")}
        >
          <Tag size={13} /> Ports: {props.portLabelMode}
        </button>
      </div>

      {(selectedAnnotation || ANNOTATION_TOOLS.has(props.activeTool)) && (
        <div className="annotation-toolbar" aria-label="Annotation formatting">
          {selectedAnnotation?.type === "text" && <>
            <label>Size <input type="number" min={8} max={72} value={selectedAnnotation.fontSize} onChange={(event) => updateSelected({ ...selectedAnnotation, fontSize: Number(event.target.value) })} /></label>
            <button type="button" aria-label="Bold" aria-pressed={selectedAnnotation.bold} onClick={() => updateSelected({ ...selectedAnnotation, bold: !selectedAnnotation.bold })}><Bold size={13} /></button>
            <button type="button" aria-label="Italic" aria-pressed={selectedAnnotation.italic} onClick={() => updateSelected({ ...selectedAnnotation, italic: !selectedAnnotation.italic })}><Italic size={13} /></button>
            <button type="button" aria-label="Align left" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "left" })}><AlignLeft size={13} /></button>
            <button type="button" aria-label="Align center" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "center" })}><AlignCenter size={13} /></button>
            <button type="button" aria-label="Align right" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "right" })}><AlignRight size={13} /></button>
            <label title="Text color"><input aria-label="Text color" type="color" value={selectedAnnotation.foreground.startsWith("#") ? selectedAnnotation.foreground : "#284158"} onChange={(event) => updateSelected({ ...selectedAnnotation, foreground: event.target.value })} /></label>
            <label title="Background"><input aria-label="Annotation background" type="color" value={selectedAnnotation.background ?? "#ffffff"} onChange={(event) => updateSelected({ ...selectedAnnotation, background: event.target.value })} /></label>
          </>}
          {selectedAnnotation && <>
            <button type="button" aria-label="Bring forward" onClick={() => props.onChange(changeDiagramAnnotationZOrder(document, selectedAnnotation.id, "forward"))}><ArrowUpToLine size={13} /></button>
            <button type="button" aria-label="Send backward" onClick={() => props.onChange(changeDiagramAnnotationZOrder(document, selectedAnnotation.id, "backward"))}><ArrowDownToLine size={13} /></button>
            <button type="button" aria-label="Delete annotation" onClick={() => { props.onChange(removeDiagramAnnotation(document, selectedAnnotation.id)); setSelectedAnnotationId(undefined); }}><Trash2 size={13} /></button>
          </>}
        </div>
      )}

      <TopologyGraphSurface
        document={document}
        view={view}
        readonly={!editable}
        draggable={editable && (props.activeTool === "select" || Boolean(selectedAnnotation))}
        connectable={editable && props.activeTool === "add-link"}
        fitRequest={props.fitRequest}
        zoomResetRequest={props.zoomResetRequest}
        zoomInRequest={props.zoomInRequest}
        zoomOutRequest={props.zoomOutRequest}
        onReady={(handle) => { graphApi.current = handle; }}
        onNodeMoved={(id, position) => { if (editable) props.onChange(withNodePosition(document, id, position)); }}
        onSelectNode={(id) => {
          setSelectedAnnotationId(undefined);
          props.onSelectLink(undefined);
          props.onSelectNode(id);
        }}
        onOpenDevice={props.onOpenDevice}
        onAnnotationMoved={(id, position) => { if (editable) props.onChange(moveDiagramAnnotation(document, id, position)); }}
        onSelectAnnotation={(id) => {
          setSelectedAnnotationId(id);
          props.onSelectNode(undefined);
          props.onSelectLink(undefined);
        }}
        onConnect={(source, sourcePort, target, targetPort) => {
          if (!editable) return;
          props.onChange(createLink(document, source, sourcePort, target, targetPort).document);
        }}
        onConnectionRejected={props.onError}
        onSelectLink={(id) => { setSelectedAnnotationId(undefined); props.onSelectLink(id); }}
        onLinkContextMenu={(id, x, y) => { setSelectedAnnotationId(undefined); props.onSelectLink(id); setContextMenu({ kind: "link", id, x, y }); }}
        onPaneClick={paneClick}
        onPaneContextMenu={(x, y) => setContextMenu({ kind: "pane", x, y })}
        onDropDevice={(kind, local) => { if ((DEVICE_TYPES as readonly string[]).includes(kind)) addAt(kind as NodeSpec["kind"], local); }}
      />

      <button className="instructions-button" type="button" onClick={() => setInstructionsOpen(true)}>Instructions</button>
      {instructionsOpen && (
        <aside className="instructions-panel" aria-label="Lab instructions">
          <header><strong>{document.title}</strong><button type="button" aria-label="Close instructions" onClick={() => setInstructionsOpen(false)}><X size={14} /></button></header>
          {document.description && <p>{document.description}</p>}
          <h3>Instructions</h3>
          <p>{document.instructions ?? "No instructions have been provided for this local lab."}</p>
          {document.expectedOutcome && <><h3>Expected outcome</h3><p>{document.expectedOutcome}</p></>}
        </aside>
      )}

      {contextMenu && (
        <div className="context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.kind === "node" && <>
            {props.mode === "simulate" && getDeviceProfile(document.topology.nodes.find((node) => node.id === contextMenu.id)!.kind).cliProfile
              && <button role="menuitem" type="button" onClick={() => contextAction("terminal")}>Open CLI <kbd>Enter</kbd></button>}
            <button role="menuitem" type="button" onClick={() => contextAction("inspect")}>Inspect <Eye size={13} /></button>
            {editable && <>
              <span className="context-menu__separator" />
              <button role="menuitem" type="button" onClick={() => contextAction("rename")}>Rename</button>
              <button role="menuitem" type="button" onClick={() => contextAction("duplicate")}>Duplicate</button>
              <button role="menuitem" type="button" className="is-danger" onClick={() => contextAction("delete")}>Delete</button>
            </>}
          </>}
          {contextMenu.kind === "link" && <>
            <button role="menuitem" type="button" onClick={() => contextAction("inspect")}>Inspect link</button>
            <button role="menuitem" type="button" onClick={() => contextAction("label")}>Edit link label…</button>
            {editable && <button role="menuitem" type="button" className="is-danger" onClick={() => contextAction("delete")}>Delete link</button>}
          </>}
          {contextMenu.kind === "pane" && <>
            {editable && <>
              <button role="menuitem" type="button" onClick={() => addFromPane("pc")}><Monitor size={14} /> Add PC</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("l2-switch")}><Network size={14} /> Add switch</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("router")}><RouterIcon size={14} /> Add router</button>
              <span className="context-menu__separator" />
            </>}
            <button role="menuitem" type="button" onClick={() => { graphApi.current?.fit(); setContextMenu(undefined); }}><Maximize2 size={14} /> Fit view</button>
          </>}
        </div>
      )}
    </section>
  );
}

export default TopologyCanvas;
