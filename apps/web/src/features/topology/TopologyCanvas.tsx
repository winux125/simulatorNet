import {
  DEVICE_TYPES,
  DEVICE_HARDWARE_PROFILE_IDS,
  getDeviceProfile,
  resolveDeviceInterfaceTemplates,
  type DiagramAnnotation,
  type LabDocument,
  type NodeSpec,
  type DeviceHardwareProfileId,
} from "@sim/contracts";
import type { LabUiSnapshot } from "@sim/sim-worker";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Cable,
  Circle,
  Copy,
  Eye,
  FilePlus2,
  FlaskConical,
  Hand,
  Italic,
  ImagePlus,
  Lock,
  LockOpen,
  Maximize2,
  Minus,
  Monitor,
  MousePointer2,
  Network,
  Router as RouterIcon,
  Search,
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
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  duplicateDraftDevice,
  removeDraftDevice,
  removeDraftLink,
  renameDraftDevice,
  updateDiagramAnnotation,
  withDiagramLinkLabel,
  withDiagramLinkStyle,
  withNodePosition,
  withoutDiagramLinkLabel,
} from "../lab/document";
import { DeviceConnectionDialog } from "./DeviceConnectionDialog";
import { createDiagramAsset } from "./diagram-image-assets";
import {
  alignAnnotations,
  annotationsInsideBounds,
  changeAnnotationsZOrder,
  createDiagramAnnotation,
  DIAGRAM_CLIPBOARD_TYPE,
  distributeAnnotations,
  duplicateAnnotations,
  isValidDiagramHex,
  MAX_ANNOTATION_TEXT_LENGTH,
  MAX_LABEL_TEXT_LENGTH,
  moveAnnotations,
  normalizeDiagramText,
  pasteDiagramClipboard,
  rectangleFromDrag,
  removeAnnotations,
  resizeAnnotation,
  rotateAnnotation,
  serializeDiagramClipboard,
  setAnnotationLock,
  snapTranslationToSmartGuides,
  TEXT_ANNOTATION_MIN_WIDTH,
  textAnnotationHeight,
  updateLineEndpoint,
  type TextDiagramAnnotation,
} from "./diagram-editor";
import { TopologyGraphSurface } from "./TopologyGraphSurface";
import { formatZoomPercent, type CanvasViewport } from "./canvas-navigation";
import { portLabelsVisible } from "./diagram-presentation";
import { createLink } from "./x6/lab-document-adapter";
import type { Point, TopologyView } from "./x6/types";

interface TopologyCanvasProps {
  document: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  pendingDeviceKind: NodeSpec["kind"] | undefined;
  pendingHardwareProfileId: DeviceHardwareProfileId | undefined;
  selectedNodeId: string | undefined;
  selectedLinkId: string | undefined;
  terminalTabs: string[];
  portLabelMode: PortLabelMode;
  wirelessAssociationsShown: boolean;
  /** View → Protocol Overlays → VPN Tunnels. Local workspace state only. */
  vpnTunnelsShown: boolean;
  fitRequest: number;
  zoomResetRequest: number;
  zoomInRequest: number;
  zoomOutRequest: number;
  viewport: CanvasViewport;
  onViewport(viewport: CanvasViewport): void;
  onResetZoom(): void;
  onSelectNode(id: string | undefined): void;
  onSelectLink(id: string | undefined): void;
  onOpenTerminal(id: string): void;
  onOpenDevice(id: string): void;
  onInspect(id: string): void;
  /** Per-device Saved/Modified state, derived from the worker while running. */
  configurationStatus?: ReadonlyArray<{ deviceId: string; drift: string; supportsConfigurationText: boolean }>;
  onSaveDeviceConfiguration(id: string): void;
  onReloadDevice(id: string): void;
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
  replaceLinkId?: string;
}

/**
 * What the inline canvas editor is currently editing. Diagram text is never
 * edited in a modal window; the editor is an absolutely positioned overlay
 * drawn over the annotation itself.
 *
 * A brand-new text annotation is held here as a `draft` and only enters the
 * LabDocument when the edit is committed, so creating text is a single
 * undo step and cancelling leaves no empty annotation behind.
 */
type InlineTextTarget =
  | { kind: "annotation"; id: string; draft?: TextDiagramAnnotation }
  | { kind: "line-label"; id: string }
  | { kind: "link-label"; id: string };

const INLINE_EDITOR_LABEL: Record<InlineTextTarget["kind"], string> = {
  annotation: "Editing topology text",
  "line-label": "Editing diagram line label",
  "link-label": "Editing link label",
};

interface InlineEditorLayout {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  color?: string;
  background?: string;
}

const ANNOTATION_TOOLS = new Set<WorkspaceTool>([
  "annotation-text",
  "annotation-rectangle",
  "annotation-ellipse",
  "annotation-line",
  "annotation-arrow",
]);

const DIAGRAM_COLORS = ["#2563eb", "#4d7fa9", "#0f766e", "#15803d", "#b45309", "#b91c1c", "#7e22ce", "#334155"];

/**
 * Trailing delay before a pan/zoom gesture is published to the workspace store.
 * The graph itself is already updated per animation frame; this only keeps a
 * continuous gesture from re-rendering the whole application at frame rate.
 */
const VIEWPORT_COMMIT_DELAY_MS = 150;

function readDiagramPreference(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function storeDiagramPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Local-only preferences may be unavailable in privacy-restricted contexts.
  }
}

function boundedDiagramNumber(value: string, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function DiagramColorControl(props: {
  label: string;
  value: string | undefined;
  transparent?: boolean;
  onChange(value: string): void;
}) {
  const normalized = props.value === "transparent" || props.value === "auto" || !props.value
    ? "#4d7fa9"
    : props.value;
  const [draft, setDraft] = useState(normalized);
  useEffect(() => setDraft(normalized), [normalized]);
  const commit = () => {
    if (isValidDiagramHex(draft)) props.onChange(draft.toLowerCase());
    else setDraft(normalized);
  };
  return (
    <div className="diagram-color-control">
      <span>{props.label}</span>
      <div className="diagram-color-control__presets">
        {DIAGRAM_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`${props.label} ${color}`}
            title={color}
            style={{ backgroundColor: color }}
            onClick={() => props.onChange(color)}
          />
        ))}
      </div>
      <input
        aria-label={`${props.label} color`}
        value={draft}
        maxLength={7}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      {props.transparent && (
        <button type="button" onClick={() => props.onChange("transparent")}>Transparent</button>
      )}
    </div>
  );
}

export function TopologyCanvas(props: TopologyCanvasProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const [connectionIntent, setConnectionIntent] = useState<ConnectionIntent>();
  const [pendingConnectionSourceId, setPendingConnectionSourceId] = useState<string>();
  const [selectedAnnotationIds, setSelectedAnnotationIds] = useState<string[]>([]);
  const [textEditing, setTextEditing] = useState<InlineTextTarget>();
  const [editingText, setEditingText] = useState("");
  // Re-published on every canvas transform while an editor is open, so the
  // overlay follows pan/zoom instead of blocking navigation.
  const [liveViewport, setLiveViewport] = useState<CanvasViewport>();
  const [dragStart, setDragStart] = useState<Point>();
  const [dragCurrent, setDragCurrent] = useState<Point>();
  const [marqueeStart, setMarqueeStart] = useState<Point>();
  const [marqueeCurrent, setMarqueeCurrent] = useState<Point>();
  const [snapToGrid, setSnapToGrid] = useState(() => readDiagramPreference("simulatornet.diagram.snapToGrid", true));
  const [smartGuides, setSmartGuides] = useState(() => readDiagramPreference("simulatornet.diagram.smartGuides", true));
  const [smartGuide, setSmartGuide] = useState<{ x?: number; y?: number }>({});
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const textEditingRef = useRef<InlineTextTarget | undefined>(undefined);
  textEditingRef.current = textEditing;
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingImagePosition = useRef<Point | undefined>(undefined);
  const pendingReplaceImageId = useRef<string | undefined>(undefined);
  const graphApi = useRef<{
    clientToLocal(point: Point): Point;
    localToClient(point: Point): Point;
    getViewport(): CanvasViewport;
    getEdgeLabelAnchor(id: string, ratio?: number): Point | undefined;
    fit(): void;
  } | undefined>(undefined);
  const suppressPaneClick = useRef(false);
  const viewportTimer = useRef<number | undefined>(undefined);
  const latestViewport = useRef<CanvasViewport | undefined>(undefined);
  const onViewportRef = useRef(props.onViewport);
  onViewportRef.current = props.onViewport;
  const restoreViewport = useRef(props.viewport).current;
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

  useEffect(() => () => {
    if (viewportTimer.current !== undefined) window.clearTimeout(viewportTimer.current);
  }, []);

  // Keep the inline editor glued to its annotation while the canvas moves.
  useEffect(() => {
    if (!textEditing || typeof ResizeObserver === "undefined") return;
    const panel = panelRef.current;
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const current = graphApi.current?.getViewport();
      if (current) setLiveViewport({ ...current });
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [textEditing]);

  useEffect(() => {
    const element = editorRef.current;
    if (!textEditing || !element) return;
    element.focus();
    // A brand-new annotation starts empty, so put the caret at the end;
    // existing text is selected so typing replaces it.
    if (textEditing.kind === "annotation" && textEditing.draft) {
      element.setSelectionRange(element.value.length, element.value.length);
    } else {
      element.select();
    }
  }, [textEditing]);

  const viewportChanged = useCallback((viewport: CanvasViewport) => {
    latestViewport.current = viewport;
    if (textEditingRef.current) setLiveViewport(viewport);
    if (viewportTimer.current !== undefined) return;
    viewportTimer.current = window.setTimeout(() => {
      viewportTimer.current = undefined;
      if (latestViewport.current) onViewportRef.current(latestViewport.current);
    }, VIEWPORT_COMMIT_DELAY_MS);
  }, []);

  const startConnection = useCallback((id: string) => {
    setContextMenu(undefined);
    setSelectedAnnotationIds([]);
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
    setSelectedAnnotationIds([]);
    setContextMenu({ kind: "node", id, x: event.clientX, y: event.clientY });
  }, []);

  // The cable handle is the one visible way to start a connection, so it is
  // hidden whenever a drag would mean something else: Hand/Pan, an annotation
  // tool, an open inline editor, or a locked (running) topology.
  const cableHandleAvailable = structuralEditable
    && (props.activeTool === "select" || props.activeTool === "add-link")
    && textEditing === undefined;

  const view = useMemo<TopologyView>(() => {
    const result: TopologyView = {
      nodes: {},
      links: {},
      annotations: {},
      wirelessAssociations: props.wirelessAssociationsShown
        ? props.snapshot?.wirelessAssociations?.map((association) => ({
            ...association,
            state: association.state,
          }))
        : [],
      vpnTunnels: props.vpnTunnelsShown
        ? props.snapshot?.vpnTunnels?.map((tunnel) => ({
            id: tunnel.id,
            localDeviceId: tunnel.localDeviceId,
            remoteDeviceId: tunnel.remoteDeviceId,
            label: tunnel.label,
            state: tunnel.state,
          }))
        : [],
    };
    if (!props.document) return result;
    for (const node of props.document.topology.nodes) {
      const live = status.get(node.id);
      const ip = live?.interfaces.find((iface) => iface.ipAddress)?.ipAddress;
      const subtitle = node.kind === "pc"
        || node.kind === "server"
        || node.kind === "laptop"
        || node.kind === "smartphone"
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
          unsavedConfiguration: props.configurationStatus
            ?.some((entry) => entry.deviceId === node.id && entry.drift === "modified") ?? false,
          // An appliance with no known/supported interfaces cannot be wired.
          connectable: cableHandleAvailable && (
            resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId).some((template) =>
              template.media !== "wireless"
              && node.interfaces.some((iface) => iface.id === template.id),
            ) || ((node.kind === "l2-switch" || node.kind === "l3-switch") && node.interfaces.length > 0)
          ),
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
      const editingLabel = textEditing?.kind === "link-label" && textEditing.id === link.id;
      const diagramLabel = editingLabel
        ? undefined
        : props.document.diagram?.linkLabels.find((label) => label.linkId === link.id && label.visible);
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
      result.annotations![annotation.id] = {
        selected: selectedAnnotationIds.includes(annotation.id),
        // The inline editor draws the live text; the canvas must not draw the
        // committed text underneath it.
        editing: textEditing !== undefined && textEditing.kind !== "link-label" && textEditing.id === annotation.id,
      };
    }
    return result;
  }, [props, status, cableHandleAvailable, activateNode, openNodeMenu, selectedAnnotationIds, startConnection, textEditing]);

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
  const editingDraft = textEditing?.kind === "annotation" ? textEditing.draft : undefined;
  const selectedAnnotation = editingDraft
    ?? document.diagram?.annotations.find((annotation) => annotation.id === selectedAnnotationIds.at(-1));
  const editingAnnotation: TextDiagramAnnotation | undefined = editingDraft
    ?? (textEditing?.kind === "annotation"
      ? document.diagram?.annotations.find((annotation) =>
          annotation.id === textEditing.id && annotation.type === "text") as TextDiagramAnnotation | undefined
      : undefined);
  const editorTextLimit = textEditing?.kind === "annotation" ? MAX_ANNOTATION_TEXT_LENGTH : MAX_LABEL_TEXT_LENGTH;
  const editorCommitsOnEnter = textEditing !== undefined && textEditing.kind !== "annotation";
  const insertImageFile = async (file: File, requestedPosition?: Point) => {
    try {
      const replacing = document.diagram?.annotations.find((annotation): annotation is Extract<DiagramAnnotation, { type: "image" }> =>
        annotation.id === pendingReplaceImageId.current && annotation.type === "image");
      const assetId = replacing?.assetId
        ?? allocateId("asset", document.diagram?.assets?.map((asset) => asset.id) ?? []);
      const asset = await createDiagramAsset(file, assetId, document);
      if (replacing) {
        const annotation = { ...replacing, alt: replacing.alt || file.name.replace(/\.[^.]+$/, "") };
        props.onChange(addDiagramImage(document, asset, annotation), "presentation");
        setSelectedAnnotationIds([annotation.id]);
        pendingReplaceImageId.current = undefined;
        props.onActiveTool("select");
        return;
      }
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
        alt: file.name.replace(/\.[^.]+$/, ""),
        zIndex: Math.max(0, ...(document.diagram?.annotations.map((item) => item.zIndex) ?? [])) + 1,
        locked: false,
      };
      props.onChange(addDiagramImage(document, asset, annotation), "presentation");
      setSelectedAnnotationIds([annotation.id]);
      props.onActiveTool("select");
    } catch (error) {
      pendingReplaceImageId.current = undefined;
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
    const diagramPayload = event.clipboardData.getData(DIAGRAM_CLIPBOARD_TYPE);
    if (diagramPayload) {
      const pasted = pasteDiagramClipboard(document, diagramPayload);
      if (pasted) {
        event.preventDefault();
        props.onChange(pasted.document, "presentation");
        setSelectedAnnotationIds(pasted.ids);
        return;
      }
    }
    const text = event.clipboardData.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    const position = insertionPoint();
    const annotation = createDiagramAnnotation(document, "annotation-text", position, position, { snap: snapToGrid });
    if (annotation?.type === "text") {
      const next = { ...annotation, content: text.slice(0, 4_096) };
      props.onChange(addDiagramAnnotation(document, next), "presentation");
      setSelectedAnnotationIds([next.id]);
    }
  };
  const addAt = (kind: NodeSpec["kind"], position?: Point, hardwareProfileId?: DeviceHardwareProfileId) => {
    if (!structuralEditable) return;
    props.onChange(addDraftDevice(document, kind, position, hardwareProfileId), "structural");
    setContextMenu(undefined);
  };
  const addFromPane = (kind: NodeSpec["kind"]) => {
    const position = contextMenu?.kind === "pane" && graphApi.current
      ? graphApi.current.clientToLocal({ x: contextMenu.x, y: contextMenu.y })
      : undefined;
    addAt(kind, position);
  };
  const paneClick = (local: Point) => {
    if (suppressPaneClick.current) {
      suppressPaneClick.current = false;
      return;
    }
    setContextMenu(undefined);
    if (structuralEditable && props.pendingDeviceKind) {
      addAt(props.pendingDeviceKind, local, props.pendingHardwareProfileId);
      props.onPlacedDevice();
      return;
    }
    if (props.activeTool === "annotation-text") {
      // Text tool: place a caret on the canvas immediately, never a dialog.
      startNewTextEditing(local);
      props.onPlacedDevice();
      return;
    }
    setSelectedAnnotationIds([]);
    setPendingConnectionSourceId(undefined);
    props.onSelectNode(undefined);
    props.onSelectLink(undefined);
  };

  const panePointerDown = (local: Point, modifiers: { shift: boolean; alt: boolean }) => {
    if (ANNOTATION_TOOLS.has(props.activeTool) && props.activeTool !== "annotation-text") {
      setDragStart(local);
      setDragCurrent(local);
      return;
    }
    if (props.activeTool === "select") {
      setMarqueeStart(local);
      setMarqueeCurrent(local);
      if (!modifiers.shift) setSelectedAnnotationIds([]);
    }
  };

  const panePointerMove = (local: Point) => {
    if (dragStart) setDragCurrent(local);
    if (marqueeStart) setMarqueeCurrent(local);
  };

  const panePointerUp = (local: Point, modifiers: { shift: boolean; alt: boolean }) => {
    if (dragStart && ANNOTATION_TOOLS.has(props.activeTool)) {
      const annotation = createDiagramAnnotation(document, props.activeTool, dragStart, local, {
        shift: modifiers.shift,
        alt: modifiers.alt,
        snap: snapToGrid,
      });
      if (annotation) {
        props.onChange(addDiagramAnnotation(document, annotation), "presentation");
        setSelectedAnnotationIds([annotation.id]);
        props.onPlacedDevice();
      }
      suppressPaneClick.current = true;
      window.setTimeout(() => { suppressPaneClick.current = false; }, 0);
      setDragStart(undefined);
      setDragCurrent(undefined);
      return;
    }
    if (marqueeStart) {
      const bounds = rectangleFromDrag(marqueeStart, local);
      if (Math.hypot(local.x - marqueeStart.x, local.y - marqueeStart.y) >= 4) {
        setSelectedAnnotationIds(annotationsInsideBounds(document, bounds));
        suppressPaneClick.current = true;
        window.setTimeout(() => { suppressPaneClick.current = false; }, 0);
      }
      setMarqueeStart(undefined);
      setMarqueeCurrent(undefined);
    }
  };

  const contextAction = (action: string) => {
    if (!contextMenu) return;
    if (contextMenu.kind === "node") {
      if (action === "terminal") props.onOpenTerminal(contextMenu.id);
      if (action === "inspect") props.onInspect(contextMenu.id);
      if (action === "configuration") props.onOpenDevice(contextMenu.id);
      if (action === "save-configuration") props.onSaveDeviceConfiguration(contextMenu.id);
      if (action === "reload") props.onReloadDevice(contextMenu.id);
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
      if (action === "label") startLinkLabelEditing(contextMenu.id);
      if (action === "route-straight") {
        props.onChange(withDiagramLinkStyle(document, contextMenu.id, { route: "straight", vertices: [] }), "presentation");
      }
      if (action === "route-orthogonal") {
        props.onChange(withDiagramLinkStyle(document, contextMenu.id, { route: "orthogonal" }), "presentation");
      }
      if (action === "reconnect" && structuralEditable) {
        const link = document.topology.links.find((candidate) => candidate.id === contextMenu.id);
        if (link) {
          setConnectionIntent({
            sourceId: link.a.node,
            sourcePort: link.a.iface,
            targetId: link.b.node,
            targetPort: link.b.iface,
            replaceLinkId: link.id,
          });
        }
      }
      if (action === "delete") props.onChange(removeDraftLink(document, contextMenu.id), "structural");
    }
    if (contextMenu.kind === "pane") {
      const local = graphApi.current?.clientToLocal({ x: contextMenu.x, y: contextMenu.y }) ?? insertionPoint();
      if (action === "add-text") startNewTextEditing(local);
      if (action === "add-image") openImagePicker(local);
      if (action === "add-shape") {
        const annotation = createDiagramAnnotation(document, "annotation-rectangle", local, local, { snap: snapToGrid });
        if (annotation) {
          props.onChange(addDiagramAnnotation(document, annotation), "presentation");
          setSelectedAnnotationIds([annotation.id]);
        }
      }
    }
    setContextMenu(undefined);
  };

  const updateSelected = (next: DiagramAnnotation) => {
    // Styling an uncommitted new annotation edits the draft, so the contextual
    // toolbar stays usable while the inline editor is open.
    if (editingDraft && next.id === editingDraft.id && next.type === "text") {
      setTextEditing({ kind: "annotation", id: next.id, draft: next });
      return;
    }
    props.onChange(updateDiagramAnnotation(document, next), "presentation");
  };

  const startTextEditing = (annotationId: string) => {
    const annotation = document.diagram?.annotations.find((candidate) => candidate.id === annotationId);
    if (annotation?.type !== "text" || annotation.locked) return;
    setSelectedAnnotationIds([annotation.id]);
    setEditingText(annotation.content);
    setTextEditing({ kind: "annotation", id: annotation.id });
  };

  const startNewTextEditing = (position: Point) => {
    const annotation = createDiagramAnnotation(document, "annotation-text", position, position, { snap: snapToGrid });
    if (annotation?.type !== "text") return;
    setSelectedAnnotationIds([]);
    setEditingText("");
    setTextEditing({ kind: "annotation", id: annotation.id, draft: annotation });
  };

  const startLineLabelEditing = (annotationId: string) => {
    const annotation = document.diagram?.annotations.find((candidate) => candidate.id === annotationId);
    if (!annotation || (annotation.type !== "line" && annotation.type !== "arrow") || annotation.locked) return;
    setSelectedAnnotationIds([annotation.id]);
    setEditingText(annotation.label ?? "");
    setTextEditing({ kind: "line-label", id: annotation.id });
  };

  const startLinkLabelEditing = (linkId: string) => {
    if (!document.topology.links.some((link) => link.id === linkId)) return;
    setContextMenu(undefined);
    setSelectedAnnotationIds([]);
    props.onSelectLink(linkId);
    setEditingText(document.diagram?.linkLabels.find((label) => label.linkId === linkId)?.text ?? "");
    setTextEditing({ kind: "link-label", id: linkId });
  };

  const editAnnotation = (annotationId: string) => {
    const annotation = document.diagram?.annotations.find((candidate) => candidate.id === annotationId);
    if (annotation?.type === "text") startTextEditing(annotationId);
    else if (annotation?.type === "line" || annotation?.type === "arrow") startLineLabelEditing(annotationId);
    else if (annotation?.type === "image") setSelectedAnnotationIds([annotationId]);
  };

  const closeTextEditing = () => {
    setTextEditing(undefined);
    setEditingText("");
    setLiveViewport(undefined);
  };

  // Escape discards the session: an uncommitted new annotation never existed,
  // and an existing one is untouched because edits are only applied on commit.
  const cancelTextEditing = () => closeTextEditing();

  const commitTextEditing = () => {
    const target = textEditing;
    if (!target) return;
    const value = normalizeDiagramText(
      editingText,
      target.kind === "annotation" ? MAX_ANNOTATION_TEXT_LENGTH : MAX_LABEL_TEXT_LENGTH,
    );
    if (target.kind === "annotation") {
      const draft = target.draft;
      if (draft) {
        // An empty new annotation is discarded and leaves no history entry.
        if (value.trim() !== "") {
          props.onChange(addDiagramAnnotation(document, { ...draft, content: value }), "presentation");
          setSelectedAnnotationIds([draft.id]);
        }
      } else if (editingAnnotation && editingAnnotation.content !== value) {
        // Existing text may become empty; it stays until it is explicitly deleted.
        props.onChange(updateDiagramAnnotation(document, { ...editingAnnotation, content: value }), "presentation");
      }
    } else if (target.kind === "line-label") {
      const annotation = document.diagram?.annotations.find((candidate) => candidate.id === target.id);
      const isLine = annotation?.type === "line" || annotation?.type === "arrow";
      if (annotation && isLine && (annotation.label ?? "") !== value) {
        props.onChange(updateDiagramAnnotation(document, { ...annotation, label: value || undefined }), "presentation");
      }
    } else {
      const current = document.diagram?.linkLabels.find((label) => label.linkId === target.id);
      if ((current?.text ?? "") !== value || (value !== "" && current?.visible === false)) {
        props.onChange(
          value === ""
            ? withoutDiagramLinkLabel(document, target.id)
            : withDiagramLinkLabel(document, target.id, { text: value, visible: true }),
          "presentation",
        );
      }
    }
    closeTextEditing();
  };

  const duplicateSelectedAnnotations = () => {
    const duplicated = duplicateAnnotations(document, selectedAnnotationIds);
    if (duplicated.ids.length === 0) return;
    props.onChange(duplicated.document, "presentation");
    setSelectedAnnotationIds(duplicated.ids);
  };

  const deleteSelectedAnnotations = () => {
    if (selectedAnnotationIds.length === 0) return;
    props.onChange(removeAnnotations(document, selectedAnnotationIds), "presentation");
    setSelectedAnnotationIds([]);
  };

  const copyFromCanvas = (event: ReactClipboardEvent<HTMLElement>) => {
    if (selectedAnnotationIds.length === 0) return;
    const selected = (document.diagram?.annotations ?? [])
      .filter((annotation) => selectedAnnotationIds.includes(annotation.id));
    event.preventDefault();
    event.clipboardData.setData(DIAGRAM_CLIPBOARD_TYPE, serializeDiagramClipboard(document, selectedAnnotationIds));
    event.clipboardData.setData("text/plain", selected.map((annotation) =>
      annotation.type === "text" ? annotation.content : `[${annotation.type}]`).join("\n"));
  };

  const handleCanvasKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .xterm")) return;
      const commandKey = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === "Escape") {
        setDragStart(undefined);
        setDragCurrent(undefined);
        setMarqueeStart(undefined);
        setMarqueeCurrent(undefined);
        setSelectedAnnotationIds([]);
        // Cancelling also abandons a started cable connection, so the canvas
        // never keeps prompting for a target device.
        setPendingConnectionSourceId(undefined);
        props.onActiveTool("select");
        return;
      }
      if (commandKey && key === "a") {
        event.preventDefault();
        setSelectedAnnotationIds((document.diagram?.annotations ?? []).map((annotation) => annotation.id));
        return;
      }
      if (selectedAnnotationIds.length === 0) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedAnnotations();
      } else if (commandKey && key === "d") {
        event.preventDefault();
        duplicateSelectedAnnotations();
      } else if (event.key.startsWith("Arrow")) {
        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        const dx = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
        const dy = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
        props.onChange(moveAnnotations(document, selectedAnnotationIds, dx, dy, snapToGrid && !event.shiftKey), "presentation");
      } else if (event.key === "Enter" && selectedAnnotation?.type === "text") {
        event.preventDefault();
        startTextEditing(selectedAnnotation.id);
      } else if (event.key === "]") {
        event.preventDefault();
        props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "forward"), "presentation");
      } else if (event.key === "[") {
        event.preventDefault();
        props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "backward"), "presentation");
      }
  };

  const overlayPoint = (point: Point | undefined): Point | undefined => {
    const panel = panelRef.current?.getBoundingClientRect();
    const client = point && graphApi.current?.localToClient(point);
    return panel && client ? { x: client.x - panel.left, y: client.y - panel.top } : undefined;
  };
  const dragOverlayStart = overlayPoint(dragStart);
  const dragOverlayEnd = overlayPoint(dragCurrent);
  const marqueeOverlayStart = overlayPoint(marqueeStart);
  const marqueeOverlayEnd = overlayPoint(marqueeCurrent);
  const smartGuideOverlayX = smartGuide.x === undefined ? undefined : overlayPoint({ x: smartGuide.x, y: 0 })?.x;
  const smartGuideOverlayY = smartGuide.y === undefined ? undefined : overlayPoint({ x: 0, y: smartGuide.y })?.y;

  // Place the inline editor over the object it edits, in the canvas transform.
  // Recomputed on every render; `liveViewport` re-renders on pan/zoom/resize.
  const editorLayout = ((): InlineEditorLayout | undefined => {
    if (!textEditing) return undefined;
    const scale = liveViewport?.scale ?? graphApi.current?.getViewport().scale ?? 1;
    if (editingAnnotation) {
      const topLeft = overlayPoint(editingAnnotation.position);
      if (!topLeft) return undefined;
      return {
        left: topLeft.x,
        top: topLeft.y,
        width: Math.max(TEXT_ANNOTATION_MIN_WIDTH, editingAnnotation.width) * scale,
        height: textAnnotationHeight(editingAnnotation, editingText) * scale,
        rotation: editingAnnotation.rotation,
        fontSize: editingAnnotation.fontSize * scale,
        bold: editingAnnotation.bold,
        italic: editingAnnotation.italic,
        align: editingAnnotation.alignment,
        color: editingAnnotation.foreground === "auto" ? undefined : editingAnnotation.foreground,
        background: !editingAnnotation.background || editingAnnotation.background === "transparent"
          ? undefined
          : editingAnnotation.background,
      };
    }
    if (textEditing.kind === "annotation") return undefined;
    const ratio = textEditing.kind === "link-label"
      ? document.diagram?.linkLabels.find((label) => label.linkId === textEditing.id)?.position ?? 0.5
      : 0.5;
    const anchor = overlayPoint(graphApi.current?.getEdgeLabelAnchor(textEditing.id, ratio));
    if (!anchor) return undefined;
    const width = 200 * scale;
    const height = 30 * scale;
    return {
      left: anchor.x - width / 2,
      top: anchor.y - height / 2,
      width,
      height,
      rotation: 0,
      fontSize: 12 * scale,
      bold: false,
      italic: false,
      align: "center",
    };
  })();

  const editorKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); cancelTextEditing(); return; }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commitTextEditing(); return; }
    // Enter adds a line to multiline text; a single-line label commits instead.
    if (event.key === "Enter" && editorCommitsOnEnter) { event.preventDefault(); commitTextEditing(); return; }
    // Tab always commits and returns focus to the canvas — it never inserts a tab.
    if (event.key === "Tab") { event.preventDefault(); commitTextEditing(); panelRef.current?.focus(); }
  };

  const editorPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    // Plain text only: clipboard HTML, styles and embedded content are ignored.
    event.preventDefault();
    const element = event.currentTarget;
    const pasted = normalizeDiagramText(event.clipboardData.getData("text/plain"), editorTextLimit);
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const next = normalizeDiagramText(
      `${element.value.slice(0, start)}${pasted}${element.value.slice(end)}`,
      editorTextLimit,
    );
    setEditingText(next);
    const caret = Math.min(next.length, start + pasted.length);
    window.requestAnimationFrame(() => element.setSelectionRange(caret, caret));
  };

  const editorBlur = (event: ReactFocusEvent<HTMLTextAreaElement>) => {
    // Formatting controls keep the session alive so styles apply without
    // closing the editor; anything else commits the text.
    if ((event.relatedTarget as HTMLElement | null)?.closest(".annotation-toolbar, .diagram-insert-toolbar")) return;
    commitTextEditing();
  };

  return (
    <section
      ref={panelRef}
      className={`topology-panel topology-panel--${props.mode}`}
      data-active-tool={props.activeTool}
      aria-label="Topology canvas"
      tabIndex={0}
      onPaste={pasteIntoCanvas}
      onCopy={copyFromCanvas}
      onKeyDown={handleCanvasKeyDown}
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
          else props.onActiveTool("select");
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
        <button
          type="button"
          className="canvas-statusbar__zoom"
          aria-label={`Canvas zoom ${formatZoomPercent(props.viewport.scale)}. Reset zoom to 100%`}
          title="Reset zoom to 100% (Fit Topology stays separate)"
          onClick={props.onResetZoom}
        >
          <Search size={13} /> Zoom: {formatZoomPercent(props.viewport.scale)}
        </button>
      </div>

      <div className="diagram-insert-toolbar" role="toolbar" aria-label="Diagram tools">
        <span>Diagram</span>
        <button type="button" title="Select (Escape)" onClick={() => props.onActiveTool("select")} aria-pressed={props.activeTool === "select"}><MousePointer2 size={13} /> Select</button>
        <button type="button" title="Hand / Pan" onClick={() => props.onActiveTool("pan")} aria-pressed={props.activeTool === "pan"}><Hand size={13} /> Hand</button>
        <span className="diagram-insert-toolbar__separator" />
        <button type="button" onClick={() => props.onActiveTool("annotation-text")} aria-pressed={props.activeTool === "annotation-text"}><Type size={13} /> Text</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-rectangle")} aria-pressed={props.activeTool === "annotation-rectangle"}><Square size={13} /> Rectangle</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-ellipse")} aria-pressed={props.activeTool === "annotation-ellipse"}><Circle size={13} /> Ellipse</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-line")} aria-pressed={props.activeTool === "annotation-line"}><Minus size={13} /> Line</button>
        <button type="button" onClick={() => props.onActiveTool("annotation-arrow")} aria-pressed={props.activeTool === "annotation-arrow"}><ArrowUpToLine size={13} /> Arrow</button>
        <button type="button" onClick={() => { props.onActiveTool("annotation-image"); openImagePicker(); }} aria-pressed={props.activeTool === "annotation-image"}><ImagePlus size={13} /> Image</button>
        <span className="diagram-insert-toolbar__separator" />
        <button type="button" disabled={!structuralEditable} title={structuralEditable ? "Create a physical network connection" : "Stop the lab to edit connectivity"} onClick={() => props.onActiveTool("add-link")} aria-pressed={props.activeTool === "add-link"}><Cable size={13} /> Connection</button>
        <label className="diagram-toolbar-toggle"><input type="checkbox" checked={snapToGrid} onChange={(event) => { setSnapToGrid(event.target.checked); storeDiagramPreference("simulatornet.diagram.snapToGrid", event.target.checked); }} /> Grid snap</label>
        <label className="diagram-toolbar-toggle"><input type="checkbox" checked={smartGuides} onChange={(event) => { setSmartGuides(event.target.checked); storeDiagramPreference("simulatornet.diagram.smartGuides", event.target.checked); }} /> Guides</label>
      </div>

      {(selectedAnnotation || ANNOTATION_TOOLS.has(props.activeTool)) && (
        <div className="annotation-toolbar" aria-label="Annotation formatting">
          {selectedAnnotationIds.length > 1 && <strong>{selectedAnnotationIds.length} selected</strong>}
          {selectedAnnotation?.type === "text" && <>
            <button type="button" onClick={() => startTextEditing(selectedAnnotation.id)} disabled={selectedAnnotation.locked}>Edit text</button>
            <label>Size <input type="number" min={8} max={72} value={selectedAnnotation.fontSize} onChange={(event) => updateSelected({ ...selectedAnnotation, fontSize: boundedDiagramNumber(event.target.value, 8, 72, selectedAnnotation.fontSize) })} /></label>
            <button type="button" aria-label="Bold" aria-pressed={selectedAnnotation.bold} onClick={() => updateSelected({ ...selectedAnnotation, bold: !selectedAnnotation.bold })}><Bold size={13} /></button>
            <button type="button" aria-label="Italic" aria-pressed={selectedAnnotation.italic} onClick={() => updateSelected({ ...selectedAnnotation, italic: !selectedAnnotation.italic })}><Italic size={13} /></button>
            <button type="button" aria-label="Align left" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "left" })}><AlignLeft size={13} /></button>
            <button type="button" aria-label="Align center" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "center" })}><AlignCenter size={13} /></button>
            <button type="button" aria-label="Align right" onClick={() => updateSelected({ ...selectedAnnotation, alignment: "right" })}><AlignRight size={13} /></button>
            <DiagramColorControl label="Text" value={selectedAnnotation.foreground} onChange={(foreground) => updateSelected({ ...selectedAnnotation, foreground: foreground as typeof selectedAnnotation.foreground })} />
            <DiagramColorControl label="Background" transparent value={selectedAnnotation.background} onChange={(background) => updateSelected({ ...selectedAnnotation, background: background as typeof selectedAnnotation.background })} />
            <DiagramColorControl label="Border" transparent value={selectedAnnotation.border} onChange={(border) => updateSelected({ ...selectedAnnotation, border: border as typeof selectedAnnotation.border })} />
            <label>Border <input aria-label="Text border width" type="number" min={0} max={12} step={0.5} value={selectedAnnotation.borderWidth ?? 0} onChange={(event) => updateSelected({ ...selectedAnnotation, borderWidth: boundedDiagramNumber(event.target.value, 0, 12, selectedAnnotation.borderWidth ?? 0) })} /></label>
            <label className="annotation-toolbar__check"><input type="checkbox" checked={selectedAnnotation.autoHeight !== false} onChange={(event) => updateSelected({ ...selectedAnnotation, autoHeight: event.target.checked })} /> Auto height</label>
          </>}
          {(selectedAnnotation?.type === "rectangle" || selectedAnnotation?.type === "ellipse") && <>
            <DiagramColorControl label="Fill" transparent value={selectedAnnotation.fill} onChange={(fill) => updateSelected({ ...selectedAnnotation, fill: fill as typeof selectedAnnotation.fill })} />
            <DiagramColorControl label="Border" value={selectedAnnotation.stroke} onChange={(stroke) => updateSelected({ ...selectedAnnotation, stroke: stroke as typeof selectedAnnotation.stroke })} />
            <label>Width <input aria-label="Shape border width" type="number" min={0.5} max={12} step={0.5} value={selectedAnnotation.strokeWidth} onChange={(event) => updateSelected({ ...selectedAnnotation, strokeWidth: boundedDiagramNumber(event.target.value, 0.5, 12, selectedAnnotation.strokeWidth) })} /></label>
            <label>Dash <select aria-label="Shape dash" value={selectedAnnotation.strokeDash ?? "solid"} onChange={(event) => updateSelected({ ...selectedAnnotation, strokeDash: event.target.value as typeof selectedAnnotation.strokeDash })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label>
            {selectedAnnotation.type === "rectangle" && <label>Radius <input aria-label="Rectangle radius" type="number" min={0} max={200} value={selectedAnnotation.radius ?? 0} onChange={(event) => updateSelected({ ...selectedAnnotation, radius: boundedDiagramNumber(event.target.value, 0, 200, selectedAnnotation.radius ?? 0) })} /></label>}
          </>}
          {(selectedAnnotation?.type === "line" || selectedAnnotation?.type === "arrow") && <>
            <DiagramColorControl label="Stroke" value={selectedAnnotation.stroke} onChange={(stroke) => updateSelected({ ...selectedAnnotation, stroke: stroke as typeof selectedAnnotation.stroke })} />
            <label>Width <input aria-label="Line width" type="number" min={0.5} max={12} step={0.5} value={selectedAnnotation.strokeWidth} onChange={(event) => updateSelected({ ...selectedAnnotation, strokeWidth: boundedDiagramNumber(event.target.value, 0.5, 12, selectedAnnotation.strokeWidth) })} /></label>
            <label>Dash <select aria-label="Line dash" value={selectedAnnotation.strokeDash ?? "solid"} onChange={(event) => updateSelected({ ...selectedAnnotation, strokeDash: event.target.value as typeof selectedAnnotation.strokeDash })}><option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option></select></label>
            <label>Start <select aria-label="Start marker" value={selectedAnnotation.startMarker ?? "none"} onChange={(event) => updateSelected({ ...selectedAnnotation, startMarker: event.target.value as typeof selectedAnnotation.startMarker })}><option value="none">None</option><option value="arrow">Arrow</option><option value="circle">Circle</option><option value="diamond">Diamond</option></select></label>
            <label>End <select aria-label="End marker" value={selectedAnnotation.endMarker ?? (selectedAnnotation.type === "arrow" ? "arrow" : "none")} onChange={(event) => updateSelected({ ...selectedAnnotation, endMarker: event.target.value as typeof selectedAnnotation.endMarker })}><option value="none">None</option><option value="arrow">Arrow</option><option value="circle">Circle</option><option value="diamond">Diamond</option></select></label>
            <label>Label <input aria-label="Line label" value={selectedAnnotation.label ?? ""} maxLength={512} onChange={(event) => updateSelected({ ...selectedAnnotation, label: event.target.value || undefined })} /></label>
            <button type="button" onClick={() => updateSelected({ ...selectedAnnotation, bend: selectedAnnotation.bend ? undefined : { x: (selectedAnnotation.start.x + selectedAnnotation.end.x) / 2, y: (selectedAnnotation.start.y + selectedAnnotation.end.y) / 2 } })}>{selectedAnnotation.bend ? "Remove bend" : "Add bend"}</button>
          </>}
          {selectedAnnotation?.type === "image" && <>
            <label>W <input aria-label="Image width" type="number" min={8} max={4096} value={selectedAnnotation.width} onChange={(event) => {
              const width = boundedDiagramNumber(event.target.value, 8, 4096, selectedAnnotation.width);
              const height = selectedAnnotation.preserveAspectRatio
                ? Math.max(8, Math.min(4096, Math.round(width * selectedAnnotation.height / selectedAnnotation.width)))
                : selectedAnnotation.height;
              updateSelected({ ...selectedAnnotation, width, height });
            }} /></label>
            <label>H <input aria-label="Image height" type="number" min={8} max={4096} value={selectedAnnotation.height} onChange={(event) => {
              const height = boundedDiagramNumber(event.target.value, 8, 4096, selectedAnnotation.height);
              const width = selectedAnnotation.preserveAspectRatio
                ? Math.max(8, Math.min(4096, Math.round(height * selectedAnnotation.width / selectedAnnotation.height)))
                : selectedAnnotation.width;
              updateSelected({ ...selectedAnnotation, width, height });
            }} /></label>
            <label className="annotation-toolbar__check"><input aria-label="Preserve aspect ratio" type="checkbox" checked={selectedAnnotation.preserveAspectRatio} onChange={(event) => updateSelected({ ...selectedAnnotation, preserveAspectRatio: event.target.checked })} /> Aspect</label>
            <label>Alt <input aria-label="Image alt description" value={selectedAnnotation.alt ?? ""} maxLength={512} onChange={(event) => updateSelected({ ...selectedAnnotation, alt: event.target.value })} /></label>
            <button type="button" onClick={() => { pendingReplaceImageId.current = selectedAnnotation.id; openImagePicker(); }}>Replace</button>
          </>}
          {selectedAnnotation && <>
            {"opacity" in selectedAnnotation && <label>Opacity <input aria-label={selectedAnnotation.type === "image" ? "Image opacity" : "Annotation opacity"} type="range" min={5} max={100} value={Math.round((selectedAnnotation.opacity ?? 1) * 100)} onChange={(event) => updateSelected({ ...selectedAnnotation, opacity: Number(event.target.value) / 100 })} /></label>}
            {"rotation" in selectedAnnotation && <label>Rotate <input aria-label="Annotation rotation" type="number" min={-360} max={360} value={selectedAnnotation.rotation} onChange={(event) => updateSelected({ ...selectedAnnotation, rotation: boundedDiagramNumber(event.target.value, -360, 360, selectedAnnotation.rotation) })} /></label>}
            <button type="button" aria-label={selectedAnnotation.locked ? "Unlock annotation" : "Lock annotation"} onClick={() => props.onChange(setAnnotationLock(document, selectedAnnotationIds, !selectedAnnotation.locked), "presentation")}>{selectedAnnotation.locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
            <button type="button" aria-label="Duplicate annotation" onClick={duplicateSelectedAnnotations}><Copy size={13} /></button>
            <button type="button" aria-label="Bring forward" onClick={() => props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "forward"), "presentation")}><ArrowUpToLine size={13} /></button>
            <button type="button" aria-label="Send backward" onClick={() => props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "backward"), "presentation")}><ArrowDownToLine size={13} /></button>
            <button type="button" onClick={() => props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "front"), "presentation")}>Front</button>
            <button type="button" onClick={() => props.onChange(changeAnnotationsZOrder(document, selectedAnnotationIds, "back"), "presentation")}>Back</button>
            <button type="button" aria-label="Delete annotation" onClick={deleteSelectedAnnotations}><Trash2 size={13} /></button>
          </>}
          {selectedAnnotationIds.length > 1 && <>
            <button type="button" aria-label="Align left edges" onClick={() => props.onChange(alignAnnotations(document, selectedAnnotationIds, "left"), "presentation")}><AlignLeft size={13} /></button>
            <button type="button" aria-label="Align vertical centers" onClick={() => props.onChange(alignAnnotations(document, selectedAnnotationIds, "middle"), "presentation")}><AlignCenter size={13} /></button>
            <button type="button" aria-label="Distribute horizontally" onClick={() => props.onChange(distributeAnnotations(document, selectedAnnotationIds, "horizontal"), "presentation")}><AlignHorizontalDistributeCenter size={13} /></button>
            <button type="button" aria-label="Distribute vertically" onClick={() => props.onChange(distributeAnnotations(document, selectedAnnotationIds, "vertical"), "presentation")}><AlignVerticalDistributeCenter size={13} /></button>
          </>}
        </div>
      )}

      <TopologyGraphSurface
        document={document}
        view={view}
        readonly={false}
        draggable={props.activeTool === "select" || Boolean(selectedAnnotation)}
        connectable={structuralEditable}
        pannable={props.activeTool === "pan"}
        fitRequest={props.fitRequest}
        zoomResetRequest={props.zoomResetRequest}
        zoomInRequest={props.zoomInRequest}
        zoomOutRequest={props.zoomOutRequest}
        restoreViewport={restoreViewport}
        onViewportChanged={viewportChanged}
        onReady={(handle) => { graphApi.current = handle; }}
        onNodeMoved={(id, position) => props.onChange(withNodePosition(document, id, position), "presentation")}
        onSelectNode={(id) => {
          panelRef.current?.focus();
          setSelectedAnnotationIds([]);
          props.onSelectLink(undefined);
          props.onSelectNode(id);
        }}
        onOpenDevice={props.onOpenDevice}
        onConnectionIntent={(sourceId, targetId, sourcePort, targetPort) => {
          if (!structuralEditable) return;
          setContextMenu(undefined);
          setSelectedAnnotationIds([]);
          setPendingConnectionSourceId(undefined);
          props.onSelectLink(undefined);
          props.onSelectNode(sourceId);
          setConnectionIntent({ sourceId, targetId, sourcePort, targetPort });
        }}
        onAnnotationMoved={(id, position) => {
          const annotation = document.diagram?.annotations.find((candidate) => candidate.id === id);
          if (!annotation || !("position" in annotation)) return;
          const ids = selectedAnnotationIds.includes(id) ? selectedAnnotationIds : [id];
          const guided = snapTranslationToSmartGuides(
            document,
            ids,
            position.x - annotation.position.x,
            position.y - annotation.position.y,
            smartGuides,
          );
          setSmartGuide({ x: guided.guideX, y: guided.guideY });
          window.setTimeout(() => setSmartGuide({}), 350);
          props.onChange(moveAnnotations(
            document,
            ids,
            guided.dx,
            guided.dy,
            snapToGrid,
          ), "presentation");
        }}
        onAnnotationResized={(id, width, height) => {
          const annotation = document.diagram?.annotations.find((candidate) => candidate.id === id);
          if (annotation) props.onChange(updateDiagramAnnotation(document, resizeAnnotation(annotation, width, height)), "presentation");
        }}
        onAnnotationRotated={(id, rotation) => {
          const annotation = document.diagram?.annotations.find((candidate) => candidate.id === id);
          if (annotation) props.onChange(updateDiagramAnnotation(document, rotateAnnotation(annotation, rotation)), "presentation");
        }}
        onAnnotationEndpointMoved={(id, endpoint, point) => {
          const annotation = document.diagram?.annotations.find((candidate) => candidate.id === id);
          if (annotation) props.onChange(updateDiagramAnnotation(document, updateLineEndpoint(annotation, endpoint, point)), "presentation");
        }}
        onSelectAnnotation={(id, additive) => {
          panelRef.current?.focus();
          setSelectedAnnotationIds((current) => additive
            ? current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]
            : [id]);
          props.onSelectNode(undefined);
          props.onSelectLink(undefined);
        }}
        onEditAnnotation={editAnnotation}
        onEditLinkLabel={startLinkLabelEditing}
        onConnect={(source, sourcePort, target, targetPort) => {
          if (!structuralEditable) return;
          props.onChange(createLink(document, source, sourcePort, target, targetPort).document, "structural");
        }}
        onConnectionRejected={props.onError}
        onSelectLink={(id) => { setSelectedAnnotationIds([]); props.onSelectLink(id); }}
        onLinkContextMenu={(id, x, y) => { setSelectedAnnotationIds([]); props.onSelectLink(id); setContextMenu({ kind: "link", id, x, y }); }}
        onPaneClick={paneClick}
        onPanePointerDown={panePointerDown}
        onPanePointerMove={panePointerMove}
        onPanePointerUp={panePointerUp}
        onPaneContextMenu={(x, y) => setContextMenu({ kind: "pane", x, y })}
        onDropDevice={(kind, local, hardwareProfileId) => {
          const validKind = (DEVICE_TYPES as readonly string[]).includes(kind);
          const validProfile = hardwareProfileId === undefined
            || (DEVICE_HARDWARE_PROFILE_IDS as readonly string[]).includes(hardwareProfileId);
          if (validKind && validProfile) addAt(kind as NodeSpec["kind"], local, hardwareProfileId);
        }}
        onDropImage={(file, local) => { void insertImageFile(file, local); }}
      />

      {dragOverlayStart && dragOverlayEnd && (
        <svg className="diagram-drag-preview" aria-hidden="true">
          {(props.activeTool === "annotation-line" || props.activeTool === "annotation-arrow") ? (
            <line
              x1={dragOverlayStart.x}
              y1={dragOverlayStart.y}
              x2={dragOverlayEnd.x}
              y2={dragOverlayEnd.y}
              markerEnd={props.activeTool === "annotation-arrow" ? "url(#diagram-preview-arrow)" : undefined}
            />
          ) : (
            <rect
              x={Math.min(dragOverlayStart.x, dragOverlayEnd.x)}
              y={Math.min(dragOverlayStart.y, dragOverlayEnd.y)}
              width={Math.abs(dragOverlayEnd.x - dragOverlayStart.x)}
              height={Math.abs(dragOverlayEnd.y - dragOverlayStart.y)}
              rx={props.activeTool === "annotation-ellipse" ? 999 : 4}
            />
          )}
          <defs><marker id="diagram-preview-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" /></marker></defs>
        </svg>
      )}
      {marqueeOverlayStart && marqueeOverlayEnd && (
        <div
          className="diagram-marquee"
          aria-hidden="true"
          style={{
            left: Math.min(marqueeOverlayStart.x, marqueeOverlayEnd.x),
            top: Math.min(marqueeOverlayStart.y, marqueeOverlayEnd.y),
            width: Math.abs(marqueeOverlayEnd.x - marqueeOverlayStart.x),
            height: Math.abs(marqueeOverlayEnd.y - marqueeOverlayStart.y),
          }}
        />
      )}
      {smartGuideOverlayX !== undefined && <span className="diagram-smart-guide diagram-smart-guide--vertical" style={{ left: smartGuideOverlayX }} />}
      {smartGuideOverlayY !== undefined && <span className="diagram-smart-guide diagram-smart-guide--horizontal" style={{ top: smartGuideOverlayY }} />}

      {connectionIntent && structuralEditable && (
        <DeviceConnectionDialog
          key={`${connectionIntent.sourceId}-${connectionIntent.targetId}`}
          document={document}
          sourceId={connectionIntent.sourceId}
          targetId={connectionIntent.targetId}
          preferredSourcePort={connectionIntent.sourcePort}
          preferredTargetPort={connectionIntent.targetPort}
          reconnectLinkId={connectionIntent.replaceLinkId}
          onClose={() => { setConnectionIntent(undefined); setPendingConnectionSourceId(undefined); }}
          onConnect={(sourceId, sourcePort, targetId, targetPort) => {
            const result = connectionIntent.replaceLinkId
              ? {
                  document: {
                    ...document,
                    topology: {
                      ...document.topology,
                      links: document.topology.links.map((link) => link.id === connectionIntent.replaceLinkId
                        ? { ...link, a: { node: sourceId, iface: sourcePort }, b: { node: targetId, iface: targetPort } }
                        : link),
                    },
                  },
                  link: { id: connectionIntent.replaceLinkId },
                }
              : createLink(document, sourceId, sourcePort, targetId, targetPort);
            props.onChange(result.document, "structural");
            props.onSelectNode(undefined);
            props.onSelectLink(result.link.id);
          }}
        />
      )}

      {textEditing && editorLayout && (
        <div
          className="inline-text-editor"
          data-inline-text-editor={textEditing.kind}
          style={{
            left: editorLayout.left,
            top: editorLayout.top,
            width: editorLayout.width,
            height: editorLayout.height,
            transform: editorLayout.rotation ? `rotate(${editorLayout.rotation}deg)` : undefined,
          }}
        >
          <textarea
            ref={editorRef}
            aria-label={INLINE_EDITOR_LABEL[textEditing.kind]}
            spellCheck={false}
            maxLength={editorTextLimit}
            value={editingText}
            style={{
              fontSize: editorLayout.fontSize,
              fontWeight: editorLayout.bold ? 700 : 400,
              fontStyle: editorLayout.italic ? "italic" : "normal",
              textAlign: editorLayout.align,
              color: editorLayout.color,
              background: editorLayout.background,
            }}
            onChange={(event) => setEditingText(normalizeDiagramText(event.target.value, editorTextLimit))}
            onKeyDown={editorKeyDown}
            onPaste={editorPaste}
            onBlur={editorBlur}
          />
          <span className="visually-hidden" role="status">{INLINE_EDITOR_LABEL[textEditing.kind]}</span>
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
            {(() => {
              const status = props.configurationStatus?.find((entry) => entry.deviceId === contextMenu.id);
              if (!status?.supportsConfigurationText) return null;
              return <>
                <button role="menuitem" type="button" onClick={() => contextAction("configuration")}>
                  Open Configuration <small>{status.drift === "saved" ? "Saved" : status.drift === "modified" ? "Modified" : "No startup"}</small>
                </button>
                <button role="menuitem" type="button" onClick={() => contextAction("save-configuration")}>Save Running Configuration</button>
                <button role="menuitem" type="button" onClick={() => contextAction("reload")}>Reload Device</button>
              </>;
            })()}
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
            <span className="context-menu__separator" />
            <button
              role="menuitemradio"
              aria-checked={(document.diagram?.linkStyles.find((style) => style.linkId === contextMenu.id)?.route ?? "straight") === "straight"}
              type="button"
              onClick={() => contextAction("route-straight")}
            >
              Straight route
            </button>
            <button
              role="menuitemradio"
              aria-checked={document.diagram?.linkStyles.find((style) => style.linkId === contextMenu.id)?.route === "orthogonal"}
              type="button"
              onClick={() => contextAction("route-orthogonal")}
            >
              Orthogonal route
            </button>
            <span className="context-menu__separator" />
            <button role="menuitem" type="button" disabled={!structuralEditable} onClick={() => contextAction("reconnect")}>Reconnect…</button>
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
