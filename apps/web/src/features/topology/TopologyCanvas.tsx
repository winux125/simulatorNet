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
  Circle,
  Copy,
  Eye,
  FilePlus2,
  FlaskConical,
  Italic,
  ImagePlus,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  Monitor,
  Network,
  Router as RouterIcon,
  Square,
  Tag,
  Type,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { PortLabelMode, WorkspaceMode, WorkspaceTool } from "../../state/workspace-store";
import { Button, StatusIndicator } from "../../ui";
import type { LabChangeImpact } from "../lab/change-impact";
import {
  addDiagramAnnotation,
  addDiagramImage,
  addDraftDevice,
  allocateId,
  changeDiagramAnnotationZOrder,
  duplicateDiagramAnnotation,
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
import { DeviceConnectionDialog } from "./DeviceConnectionDialog";
import { createDiagramAsset } from "./diagram-image-assets";
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
  onActiveTool(tool: WorkspaceTool): void;
  onPortLabelMode(mode: PortLabelMode): void;
  onChange(document: LabDocument, impact: LabChangeImpact): void;
  onError(message: string): void;
  onLoadDemo(): void;
  onNewLab(): void;
  onImportLab(): void;
}

type ContextMenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "link"; id: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number };

interface ConnectionIntent {
  sourceId: string;
  targetId: string;
  sourcePort?: string;
  targetPort?: string;
}

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
  const [connectionIntent, setConnectionIntent] = useState<ConnectionIntent>();
  const [pendingConnectionSourceId, setPendingConnectionSourceId] = useState<string>();
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string>();
  const [editingTextId, setEditingTextId] = useState<string>();
  const [editingText, setEditingText] = useState("");
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingImagePosition = useRef<Point | undefined>(undefined);
  const graphApi = useRef<{ clientToLocal(point: Point): Point; fit(): void } | undefined>(undefined);
  const status = useMemo(() => new Map(props.snapshot?.nodes.map((node) => [node.id, node])), [props.snapshot]);
  const structuralEditable = props.mode === "edit";

  const insertionPoint = useCallback((): Point => {
    const bounds = panelRef.current?.getBoundingClientRect();
    if (!bounds || !graphApi.current) return { x: 220, y: 140 };
    const center = graphApi.current.clientToLocal({
      x: bounds.left + bounds.width / 2,
      y: bounds.top + bounds.height / 2,
    });
    return { x: center.x - 140, y: center.y - 90 };
  }, []);

  useEffect(() => {
    if (!structuralEditable) {
      setConnectionIntent(undefined);
      setPendingConnectionSourceId(undefined);
    }
  }, [structuralEditable]);

  const startConnection = useCallback((id: string) => {
    setContextMenu(undefined);
    setSelectedAnnotationId(undefined);
    props.onSelectLink(undefined);
    props.onSelectNode(id);
    setPendingConnectionSourceId(id);
  }, [props.onSelectLink, props.onSelectNode]);

  const activateNode = useCallback((id: string) => {
    if (pendingConnectionSourceId && pendingConnectionSourceId !== id) {
      setConnectionIntent({ sourceId: pendingConnectionSourceId, targetId: id });
      setPendingConnectionSourceId(undefined);
      return;
    }
    props.onSelectNode(id);
  }, [pendingConnectionSourceId, props.onSelectNode]);

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
      // Runtime snapshots intentionally do not own diagram coordinates. A moved
      // node is presentation-only and must never receive a pending-rebuild badge.
      const changed = !original;
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
          connectable: structuralEditable,
          onActivate: activateNode,
          onOpen: props.onOpenDevice,
          onConnectStart: startConnection,
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
  }, [props, status, structuralEditable, activateNode, openNodeMenu, selectedAnnotationId, startConnection]);

  if (!props.document) {
    return (
      <section className="topology-empty" aria-label="Topology canvas">
        <div className="welcome-workspace">
          <span className="welcome-workspace__mark" aria-hidden="true"><Network size={26} /></span>
          <p className="section-eyebrow">Browser network laboratory</p>
          <h1>SimulatorNet</h1>
          <div className="welcome-workspace__actions">
            <Button variant="primary" icon={<FilePlus2 size={15} />} onClick={props.onNewLab}>New Lab</Button>
            <Button icon={<Upload size={15} />} onClick={props.onImportLab}>Import Lab</Button>
            <Button icon={<FlaskConical size={15} />} onClick={props.onLoadDemo}>Load Demo Lab</Button>
          </div>
        </div>
      </section>
    );
  }

  const document = props.document;
  const selectedAnnotation = document.diagram?.annotations.find((annotation) => annotation.id === selectedAnnotationId);
  const editingAnnotation = document.diagram?.annotations.find((annotation) =>
    annotation.id === editingTextId && annotation.type === "text") as Extract<DiagramAnnotation, { type: "text" }> | undefined;
  const insertImageFile = async (file: File, requestedPosition?: Point) => {
    try {
      const assetId = allocateId("asset", document.diagram?.assets?.map((asset) => asset.id) ?? []);
      const asset = await createDiagramAsset(file, assetId, document);
      const annotationId = allocateId("annotation", document.diagram?.annotations.map((annotation) => annotation.id) ?? []);
      const maximumWidth = 360;
      const maximumHeight = 240;
      const scale = Math.min(1, maximumWidth / asset.width, maximumHeight / asset.height);
      const width = Math.max(8, Math.round(asset.width * scale));
      const height = Math.max(8, Math.round(asset.height * scale));
      const anchor = requestedPosition ?? insertionPoint();
      const annotation: Extract<DiagramAnnotation, { type: "image" }> = {
        id: annotationId,
        type: "image",
        assetId,
        position: anchor,
        width,
        height,
        rotation: 0,
        opacity: 1,
        preserveAspectRatio: true,
        zIndex: Math.max(0, ...(document.diagram?.annotations.map((item) => item.zIndex) ?? [])) + 1,
        locked: false,
      };
      props.onChange(addDiagramImage(document, asset, annotation), "presentation");
      setSelectedAnnotationId(annotation.id);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "The image could not be inserted.");
    }
  };
  const openImagePicker = (position?: Point) => {
    pendingImagePosition.current = position;
    imageInputRef.current?.click();
  };
  const pasteIntoCanvas = (event: ReactClipboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable='true'], .xterm")) return;
    const image = [...event.clipboardData.items]
      .find((item) => item.kind === "file" && item.type.startsWith("image/"))
      ?.getAsFile();
    if (image) {
      event.preventDefault();
      void insertImageFile(image);
      return;
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const position = insertionPoint();
    const annotation = createAnnotation(document, "annotation-text", position);
    if (annotation?.type === "text") {
      const next = { ...annotation, content: text.slice(0, 4_096) };
      props.onChange(addDiagramAnnotation(document, next), "presentation");
      setSelectedAnnotationId(next.id);
    }
  };
  const addAt = (kind: NodeSpec["kind"], position?: Point) => {
    if (!structuralEditable) return;
    props.onChange(addDraftDevice(document, kind, position), "structural");
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
    if (structuralEditable && props.pendingDeviceKind) {
      addAt(props.pendingDeviceKind, local);
      props.onPlacedDevice();
      return;
    }
    const annotation = createAnnotation(document, props.activeTool, local);
    if (annotation) {
      props.onChange(addDiagramAnnotation(document, annotation), "presentation");
      setSelectedAnnotationId(annotation.id);
      props.onPlacedDevice();
      return;
    }
    setSelectedAnnotationId(undefined);
    setPendingConnectionSourceId(undefined);
    props.onSelectNode(undefined);
    props.onSelectLink(undefined);
  };

  const contextAction = (action: string) => {
    if (!contextMenu) return;
    if (contextMenu.kind === "node") {
      if (action === "terminal") props.onOpenTerminal(contextMenu.id);
      if (action === "inspect") props.onInspect(contextMenu.id);
      if (action === "connect") startConnection(contextMenu.id);
      if (action === "rename") {
        const current = document.configurations[contextMenu.id]?.hostname ?? contextMenu.id;
        const next = window.prompt("Device hostname", current);
        if (next) props.onChange(renameDraftDevice(document, contextMenu.id, next), "configuration");
      }
      if (action === "duplicate") props.onChange(duplicateDraftDevice(document, contextMenu.id), "structural");
      if (action === "delete") props.onChange(removeDraftDevice(document, contextMenu.id), "structural");
    }
    if (contextMenu.kind === "link") {
      if (action === "inspect") props.onSelectLink(contextMenu.id);
      if (action === "label") {
        const current = document.diagram?.linkLabels.find((label) => label.linkId === contextMenu.id)?.text ?? "";
        const next = window.prompt("Link annotation", current);
        if (next !== null) props.onChange(withDiagramLinkLabel(document, contextMenu.id, { text: next, visible: true }), "presentation");
      }
      if (action === "delete") props.onChange(removeDraftLink(document, contextMenu.id), "structural");
    }
    if (contextMenu.kind === "pane") {
      const local = graphApi.current?.clientToLocal({ x: contextMenu.x, y: contextMenu.y }) ?? insertionPoint();
      if (action === "add-text") {
        const annotation = createAnnotation(document, "annotation-text", local);
        if (annotation) {
          props.onChange(addDiagramAnnotation(document, annotation), "presentation");
          setSelectedAnnotationId(annotation.id);
        }
      }
      if (action === "add-image") openImagePicker(local);
      if (action === "add-shape") {
        const annotation = createAnnotation(document, "annotation-rectangle", local);
        if (annotation) {
          props.onChange(addDiagramAnnotation(document, annotation), "presentation");
          setSelectedAnnotationId(annotation.id);
        }
      }
    }
    setContextMenu(undefined);
  };

  const updateSelected = (next: DiagramAnnotation) => {
    props.onChange(updateDiagramAnnotation(document, next), "presentation");
  };

  const startTextEditing = (annotationId: string) => {
    const annotation = document.diagram?.annotations.find((candidate) => candidate.id === annotationId);
    if (annotation?.type !== "text" || annotation.locked) return;
    setSelectedAnnotationId(annotation.id);
    setEditingText(annotation.content);
    setEditingTextId(annotation.id);
  };

  return (
    <section
      ref={panelRef}
      className={`topology-panel topology-panel--${props.mode}`}
      aria-label="Topology canvas"
      tabIndex={0}
      onPaste={pasteIntoCanvas}
      onContextMenu={(event) => event.preventDefault()}
    >
      <input
        ref={imageInputRef}
        className="visually-hidden"
        type="file"
        accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
        aria-label="Choose diagram image"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertImageFile(file, pendingImagePosition.current);
          pendingImagePosition.current = undefined;
          event.target.value = "";
        }}
      />
      <div className="canvas-statusbar">
        <StatusIndicator status={props.mode === "edit" ? "unsaved" : "ready"} label={props.mode === "edit" ? "Edit topology" : "Lab running"} />
        <span>{document.topology.nodes.length} devices</span>
        <span>{document.topology.links.length} links</span>
        {pendingConnectionSourceId && <strong><Cable size={12} /> Select the device to connect</strong>}
        {props.activeTool === "add-link" && <strong><Cable size={12} /> Drag a cable handle onto another device</strong>}
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

      <div className="diagram-insert-toolbar" aria-label="Insert diagram element">
        <span>Insert</span>
        <button type="button" onClick={() => props.onActiveTool("annotation-text")} aria-pressed={props.activeTool === "annotation-text"}><Type size={13} /> Text</button>
        <button type="button" onClick={() => openImagePicker()}><ImagePlus size={13} /> Image</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-rectangle")} aria-pressed={props.activeTool === "annotation-rectangle"}><Square size={13} /> Rectangle</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-ellipse")} aria-pressed={props.activeTool === "annotation-ellipse"}><Circle size={13} /> Ellipse</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-line")} aria-pressed={props.activeTool === "annotation-line"}><Minus size={13} /> Line</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-arrow")} aria-pressed={props.activeTool === "annotation-arrow"}><ArrowUpToLine size={13} /> Arrow</button>
      </div>

      {(selectedAnnotation || ANNOTATION_TOOLS.has(props.activeTool)) && (
        <div className="annotation-toolbar" aria-label="Annotation formatting">
          {selectedAnnotation?.type === "text" && <>
            <button type="button" onClick={() => startTextEditing(selectedAnnotation.id)} disabled={selectedAnnotation.locked}>Edit text</button>
            <label>Size <input type="number" min={8} max={72} value={selectedAnnotation.fontSize} onChange={(event) => updateSelected({ ...selectedAnnotation, fontSize: Number(event.target.value) })} /></label>
            <button type="button" aria-label="Bold" aria-pressed={selectedAnnotation.bold} onClick={() => updateSelected({ ...selectedAnnotation, bold: !selectedAnnotation.bold })}><Bold size={13} /></button>
            <button type="button" aria-label="Italic" aria-pressed={selectedAnnotation.italic} onClick={() => updateSelected({ ...selectedAnnotation, italic: !selectedAnnotation.italic })}><Italic size={13} /></button>
            <button type="button" aria-label="Align left" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "left" })}><AlignLeft size={13} /></button>
            <button type="button" aria-label="Align center" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "center" })}><AlignCenter size={13} /></button>
            <button type="button" aria-label="Align right" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "right" })}><AlignRight size={13} /></button>
            <label title="Text color"><input aria-label="Text color" type="color" value={selectedAnnotation.foreground.startsWith("#") ? selectedAnnotation.foreground : "#284158"} onChange={(event) => updateSelected({ ...selectedAnnotation, foreground: event.target.value })} /></label>
            <label title="Background"><input aria-label="Annotation background" type="color" value={selectedAnnotation.background ?? "#ffffff"} onChange={(event) => updateSelected({ ...selectedAnnotation, background: event.target.value })} /></label>
            <label title="Border"><input aria-label="Annotation border" type="color" value={selectedAnnotation.border ?? "#4d7fa9"} onChange={(event) => updateSelected({ ...selectedAnnotation, border: event.target.value })} /></label>
          </>}
          {selectedAnnotation?.type === "image" && <>
            <label>W <input aria-label="Image width" type="number" min={8} max={4096} value={selectedAnnotation.width} onChange={(event) => {
              const width = Math.max(8, Math.min(4096, Number(event.target.value)));
              const height = selectedAnnotation.preserveAspectRatio
                ? Math.max(8, Math.min(4096, Math.round(width * selectedAnnotation.height / selectedAnnotation.width)))
                : selectedAnnotation.height;
              updateSelected({ ...selectedAnnotation, width, height });
            }} /></label>
            <label>H <input aria-label="Image height" type="number" min={8} max={4096} value={selectedAnnotation.height} onChange={(event) => {
              const height = Math.max(8, Math.min(4096, Number(event.target.value)));
              const width = selectedAnnotation.preserveAspectRatio
                ? Math.max(8, Math.min(4096, Math.round(height * selectedAnnotation.width / selectedAnnotation.height)))
                : selectedAnnotation.width;
              updateSelected({ ...selectedAnnotation, width, height });
            }} /></label>
            <label className="annotation-toolbar__check"><input aria-label="Preserve aspect ratio" type="checkbox" checked={selectedAnnotation.preserveAspectRatio} onChange={(event) => updateSelected({ ...selectedAnnotation, preserveAspectRatio: event.target.checked })} /> Aspect</label>
            <label>Opacity <input aria-label="Image opacity" type="range" min={5} max={100} value={Math.round(selectedAnnotation.opacity * 100)} onChange={(event) => updateSelected({ ...selectedAnnotation, opacity: Number(event.target.value) / 100 })} /></label>
          </>}
          {selectedAnnotation && <>
            {"rotation" in selectedAnnotation && <label>Rotate <input aria-label="Annotation rotation" type="number" min={-360} max={360} value={selectedAnnotation.rotation} onChange={(event) => updateSelected({ ...selectedAnnotation, rotation: Number(event.target.value) })} /></label>}
            <button type="button" aria-label={selectedAnnotation.locked ? "Unlock annotation" : "Lock annotation"} onClick={() => updateSelected({ ...selectedAnnotation, locked: !selectedAnnotation.locked })}>{selectedAnnotation.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
            <button type="button" aria-label="Duplicate annotation" onClick={() => {
              const next = duplicateDiagramAnnotation(document, selectedAnnotation.id);
              props.onChange(next, "presentation");
              const ids = new Set(document.diagram?.annotations.map((annotation) => annotation.id) ?? []);
              setSelectedAnnotationId(next.diagram?.annotations.find((annotation) => !ids.has(annotation.id))?.id);
            }}><Copy size={13} /></button>
            <button type="button" aria-label="Bring forward" onClick={() => props.onChange(changeDiagramAnnotationZOrder(document, selectedAnnotation.id, "forward"), "presentation")}><ArrowUpToLine size={13} /></button>
            <button type="button" aria-label="Send backward" onClick={() => props.onChange(changeDiagramAnnotationZOrder(document, selectedAnnotation.id, "backward"), "presentation")}><ArrowDownToLine size={13} /></button>
            <button type="button" aria-label="Delete annotation" onClick={() => { props.onChange(removeDiagramAnnotation(document, selectedAnnotation.id), "presentation"); setSelectedAnnotationId(undefined); }}><Trash2 size={13} /></button>
          </>}
        </div>
      )}

      <TopologyGraphSurface
        document={document}
        view={view}
        readonly={false}
        draggable={props.activeTool === "select" || Boolean(selectedAnnotation)}
        connectable={structuralEditable}
        fitRequest={props.fitRequest}
        zoomResetRequest={props.zoomResetRequest}
        zoomInRequest={props.zoomInRequest}
        zoomOutRequest={props.zoomOutRequest}
        onReady={(handle) => { graphApi.current = handle; }}
        onNodeMoved={(id, position) => props.onChange(withNodePosition(document, id, position), "presentation")}
        onSelectNode={(id) => {
          setSelectedAnnotationId(undefined);
          props.onSelectLink(undefined);
          props.onSelectNode(id);
        }}
        onOpenDevice={props.onOpenDevice}
        onConnectionIntent={(sourceId, targetId, sourcePort, targetPort) => {
          if (!structuralEditable) return;
          setContextMenu(undefined);
          setSelectedAnnotationId(undefined);
          setPendingConnectionSourceId(undefined);
          props.onSelectLink(undefined);
          props.onSelectNode(sourceId);
          setConnectionIntent({ sourceId, targetId, sourcePort, targetPort });
        }}
        onAnnotationMoved={(id, position) => props.onChange(moveDiagramAnnotation(document, id, position), "presentation")}
        onSelectAnnotation={(id) => {
          setSelectedAnnotationId(id);
          props.onSelectNode(undefined);
          props.onSelectLink(undefined);
        }}
        onEditAnnotation={startTextEditing}
        onConnect={(source, sourcePort, target, targetPort) => {
          if (!structuralEditable) return;
          props.onChange(createLink(document, source, sourcePort, target, targetPort).document, "structural");
        }}
        onConnectionRejected={props.onError}
        onSelectLink={(id) => { setSelectedAnnotationId(undefined); props.onSelectLink(id); }}
        onLinkContextMenu={(id, x, y) => { setSelectedAnnotationId(undefined); props.onSelectLink(id); setContextMenu({ kind: "link", id, x, y }); }}
        onPaneClick={paneClick}
        onPaneContextMenu={(x, y) => setContextMenu({ kind: "pane", x, y })}
        onDropDevice={(kind, local) => { if ((DEVICE_TYPES as readonly string[]).includes(kind)) addAt(kind as NodeSpec["kind"], local); }}
      />

      {connectionIntent && structuralEditable && (
        <DeviceConnectionDialog
          key={`${connectionIntent.sourceId}-${connectionIntent.targetId}`}
          document={document}
          sourceId={connectionIntent.sourceId}
          targetId={connectionIntent.targetId}
          preferredSourcePort={connectionIntent.sourcePort}
          preferredTargetPort={connectionIntent.targetPort}
          onClose={() => { setConnectionIntent(undefined); setPendingConnectionSourceId(undefined); }}
          onConnect={(sourceId, sourcePort, targetId, targetPort) => {
            const result = createLink(document, sourceId, sourcePort, targetId, targetPort);
            props.onChange(result.document, "structural");
            props.onSelectNode(undefined);
            props.onSelectLink(result.link.id);
          }}
        />
      )}

      {editingAnnotation && (
        <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingTextId(undefined); }}>
          <form
            className="workspace-dialog annotation-text-dialog"
            role="dialog"
            aria-label="Edit text annotation"
            onSubmit={(event) => {
              event.preventDefault();
              updateSelected({ ...editingAnnotation, content: editingText.slice(0, 4_096) });
              setEditingTextId(undefined);
            }}
          >
            <header><div><p>Diagram annotation</p><h2>Edit text</h2></div><button type="button" className="dialog-close" aria-label="Close text editor" onClick={() => setEditingTextId(undefined)}><X size={15} /></button></header>
            <div className="workspace-dialog__body"><label className="annotation-text-field">Text<textarea aria-label="Annotation text" rows={7} value={editingText} autoFocus maxLength={4_096} onChange={(event) => setEditingText(event.target.value)} /></label></div>
            <div className="dialog-actions"><Button type="button" variant="ghost" onClick={() => setEditingTextId(undefined)}>Cancel</Button><Button type="submit" variant="primary">Apply</Button></div>
          </form>
        </div>
      )}

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
            {structuralEditable && <>
              <span className="context-menu__separator" />
              <button role="menuitem" type="button" onClick={() => contextAction("connect")}>Connect… <Cable size={13} /></button>
              <button role="menuitem" type="button" onClick={() => contextAction("rename")}>Rename</button>
              <button role="menuitem" type="button" onClick={() => contextAction("duplicate")}>Duplicate</button>
              <button role="menuitem" type="button" className="is-danger" onClick={() => contextAction("delete")}>Delete</button>
            </>}
          </>}
          {contextMenu.kind === "link" && <>
            <button role="menuitem" type="button" onClick={() => contextAction("inspect")}>Inspect link</button>
            <button role="menuitem" type="button" onClick={() => contextAction("label")}>Edit link label…</button>
            {structuralEditable && <button role="menuitem" type="button" className="is-danger" onClick={() => contextAction("delete")}>Delete link</button>}
          </>}
          {contextMenu.kind === "pane" && <>
            {structuralEditable && <>
              <button role="menuitem" type="button" onClick={() => addFromPane("pc")}><Monitor size={14} /> Add PC</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("l2-switch")}><Network size={14} /> Add switch</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("router")}><RouterIcon size={14} /> Add router</button>
              <span className="context-menu__separator" />
            </>}
            <button role="menuitem" type="button" onClick={() => contextAction("add-text")}><Type size={14} /> Add Text</button>
            <button role="menuitem" type="button" onClick={() => contextAction("add-image")}><ImagePlus size={14} /> Add Image</button>
            <button role="menuitem" type="button" onClick={() => contextAction("add-shape")}><Square size={14} /> Add Shape</button>
            <span className="context-menu__separator" />
            <button role="menuitem" type="button" onClick={() => { graphApi.current?.fit(); setContextMenu(undefined); }}><Maximize2 size={14} /> Fit view</button>
          </>}
        </div>
      )}
    </section>
  );
}

export default TopologyCanvas;
