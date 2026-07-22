import { DEVICE_TYPES, getDeviceProfile, type LabDocument, type NodeSpec } from "@sim/contracts";
import type { LabUiSnapshot } from "@sim/sim-worker";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import { Cable, Eye, FilePlus2, FlaskConical, Maximize2, Monitor, Network, Router as RouterIcon, Tag, Upload } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { WorkspaceMode, WorkspaceTool } from "../../state/workspace-store";
import { Button, StatusIndicator } from "../../ui";
import {
  addDraftDevice,
  allocateId,
  duplicateDraftDevice,
  removeDraftDevice,
  removeDraftLink,
  renameDraftDevice,
  withNodePosition,
} from "../lab/document";
import { DeviceNode, type DeviceFlowNode } from "./DeviceNode";

interface TopologyCanvasProps {
  document: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  selectedNodeId: string | undefined;
  selectedLinkId: string | undefined;
  terminalTabs: string[];
  showLinkLabels: boolean;
  fitRequest: number;
  zoomResetRequest: number;
  onSelectNode(id: string | undefined): void;
  onSelectLink(id: string | undefined): void;
  onOpenTerminal(id: string): void;
  onInspect(id: string): void;
  onShowLinkLabels(show: boolean): void;
  onChange(document: LabDocument): void;
  onLoadDemo(): void;
  onNewLab(): void;
  onImportLab(): void;
}

type ContextMenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "link"; id: string; x: number; y: number }
  | { kind: "pane"; x: number; y: number };

const nodeTypes = { device: DeviceNode };

function endpointKey(node: string, iface: string): string {
  return `${node}\u0000${iface}`;
}

export function TopologyCanvas(props: TopologyCanvasProps) {
  const [instance, setInstance] = useState<ReactFlowInstance<DeviceFlowNode, Edge> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const status = useMemo(() => new Map(props.snapshot?.nodes.map((node) => [node.id, node])), [props.snapshot]);
  const editable = props.mode === "edit";

  useEffect(() => {
    if (props.fitRequest > 0) void instance?.fitView({ padding: 0.18, duration: 260 });
  }, [instance, props.fitRequest]);

  useEffect(() => {
    if (props.zoomResetRequest > 0) void instance?.zoomTo(1, { duration: 200 });
  }, [instance, props.zoomResetRequest]);

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
  const openNodeMenu = (id: string, event: ReactMouseEvent) => {
    event.preventDefault();
    props.onSelectNode(id);
    setContextMenu({ kind: "node", id, x: event.clientX, y: event.clientY });
  };
  const nodes: DeviceFlowNode[] = document.topology.nodes.map((node) => {
    const live = status.get(node.id);
    const ip = live?.interfaces.find((iface) => iface.ipAddress)?.ipAddress;
    const subtitle = node.kind === "pc" || node.kind === "server"
      ? ip ?? "No IPv4 address"
      : node.kind === "l2-switch" || node.kind === "l3-switch"
        ? `${node.interfaces.length} ports`
        : node.kind === "hub"
          ? `${node.interfaces.length} shared ports`
          : node.kind === "bridge"
            ? "2 Ethernet segments"
            : `${node.interfaces.length} interfaces`;
    const original = props.snapshot?.nodes.find((candidate) => candidate.id === node.id);
    const changed = !original || original.position.x !== node.position?.x || original.position.y !== node.position?.y;
    return {
      id: node.id,
      type: "device",
      position: node.position ?? { x: 0, y: 0 },
      selected: props.selectedNodeId === node.id,
      draggable: editable,
      connectable: editable,
      data: {
        hostname: live?.hostname ?? document.configurations[node.id]?.hostname ?? node.name ?? node.id,
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
        connectable: editable && props.activeTool === "add-link",
        onActivate: props.onSelectNode,
        onContextMenu: openNodeMenu,
      },
    };
  });
  const edges: Edge[] = document.topology.links.map((link) => {
    const sourceInterface = status.get(link.a.node)?.interfaces.find((iface) => iface.id === link.a.iface);
    const targetInterface = status.get(link.b.node)?.interfaces.find((iface) => iface.id === link.b.iface);
    const operational = sourceInterface?.operationalUp && targetInterface?.operationalUp;
    const selected = props.selectedLinkId === link.id;
    return {
      id: link.id,
      source: link.a.node,
      sourceHandle: link.a.iface,
      target: link.b.node,
      targetHandle: `target:${link.b.iface}`,
      type: "smoothstep",
      selected,
      className: `topology-link ${operational ? "is-up" : "is-down"}`,
      label: props.showLinkLabels && (zoom >= 0.72 || selected) ? `${link.a.iface}  ↔  ${link.b.iface}` : undefined,
      labelStyle: { fill: "var(--color-link-label)", fontSize: 10, fontFamily: "var(--font-mono)" },
      labelBgStyle: { fill: "var(--color-link-label-bg)", fillOpacity: 0.94 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 3,
    };
  });

  const handleNodesChange = (changes: NodeChange<DeviceFlowNode>[]) => {
    if (!editable) return;
    let next = document;
    for (const change of changes) {
      if (change.type === "position" && change.position) next = withNodePosition(next, change.id, change.position);
      if (change.type === "remove") next = removeDraftDevice(next, change.id);
      if (change.type === "select" && change.selected) props.onSelectNode(change.id);
    }
    if (next !== document) props.onChange(next);
  };

  const connect = (connection: Connection) => {
    if (!editable || !connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return;
    const sourceInterface = connection.sourceHandle;
    const targetInterface = connection.targetHandle.replace(/^target:/, "");
    if (connection.source === connection.target && sourceInterface === targetInterface) return;
    const used = new Set(document.topology.links.flatMap((link) => [
      endpointKey(link.a.node, link.a.iface),
      endpointKey(link.b.node, link.b.iface),
    ]));
    if (used.has(endpointKey(connection.source, sourceInterface)) || used.has(endpointKey(connection.target, targetInterface))) return;
    const id = allocateId("link", document.topology.links.map((link) => link.id));
    props.onChange({
      ...document,
      topology: {
        ...document.topology,
        links: [...document.topology.links, {
          id,
          a: { node: connection.source, iface: sourceInterface },
          b: { node: connection.target, iface: targetInterface },
        }],
      },
    });
  };

  const addAt = (kind: NodeSpec["kind"], position?: { x: number; y: number }) => {
    if (!editable) return;
    props.onChange(addDraftDevice(document, kind, position));
    setContextMenu(undefined);
  };
  const dropDevice = (event: DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/x-simulator-device") as NodeSpec["kind"];
    if (!(DEVICE_TYPES as readonly string[]).includes(kind) || !instance) return;
    addAt(kind, instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  };
  const addFromPane = (kind: NodeSpec["kind"]) => {
    const position = contextMenu?.kind === "pane" && instance
      ? instance.screenToFlowPosition({ x: contextMenu.x, y: contextMenu.y })
      : undefined;
    addAt(kind, position);
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
      if (action === "labels") props.onShowLinkLabels(!props.showLinkLabels);
      if (action === "delete") props.onChange(removeDraftLink(document, contextMenu.id));
    }
    setContextMenu(undefined);
  };

  return (
    <section className={`topology-panel topology-panel--${props.mode}`} aria-label="Topology canvas" onContextMenu={(event) => event.preventDefault()}>
      <div className="canvas-statusbar">
        <StatusIndicator status={props.mode === "edit" ? "unsaved" : "ready"} label={props.mode === "edit" ? "Edit topology" : "Live simulation"} />
        <span>{document.topology.nodes.length} devices</span>
        <span>{document.topology.links.length} links</span>
        {props.activeTool === "add-link" && <strong><Cable size={12} /> Drag between interface endpoints</strong>}
        <button type="button" aria-label="Toggle link labels" aria-pressed={props.showLinkLabels} onClick={() => props.onShowLinkLabels(!props.showLinkLabels)}><Tag size={13} /> Port labels</button>
      </div>
      <div className="lab-information" aria-label="Lab information">
        <small>Training laboratory</small>
        <strong>{document.title}</strong>
        <p>{document.description ?? "Build, inspect and validate a deterministic network topology."}</p>
        <span>Seed {document.simulation.seed} · schema v{document.schemaVersion}</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onMove={(_, viewport) => setZoom(viewport.zoom)}
        onNodesChange={handleNodesChange}
        onConnect={connect}
        onEdgesDelete={(deleted) => {
          if (editable && deleted.length > 0) {
            props.onChange(deleted.reduce((draft, edge) => removeDraftLink(draft, edge.id), document));
          }
        }}
        onEdgeClick={(_, edge) => props.onSelectLink(edge.id)}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          props.onSelectLink(edge.id);
          setContextMenu({ kind: "link", id: edge.id, x: event.clientX, y: event.clientY });
        }}
        onPaneClick={() => {
          setContextMenu(undefined);
          props.onSelectNode(undefined);
          props.onSelectLink(undefined);
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ kind: "pane", x: event.clientX, y: event.clientY });
        }}
        onDragOver={(event) => {
          if (editable) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={dropDevice}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesDraggable={editable && props.activeTool === "select"}
        nodesConnectable={editable && props.activeTool === "add-link"}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--color-canvas-grid)" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
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
            <button role="menuitem" type="button" onClick={() => contextAction("labels")}>{props.showLinkLabels ? "Hide" : "Show"} labels</button>
            {editable && <button role="menuitem" type="button" className="is-danger" onClick={() => contextAction("delete")}>Delete link</button>}
          </>}
          {contextMenu.kind === "pane" && <>
            {editable && <>
              <button role="menuitem" type="button" onClick={() => addFromPane("pc")}><Monitor size={14} /> Add PC</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("l2-switch")}><Network size={14} /> Add switch</button>
              <button role="menuitem" type="button" onClick={() => addFromPane("router")}><RouterIcon size={14} /> Add router</button>
              <span className="context-menu__separator" />
            </>}
            <button role="menuitem" type="button" onClick={() => { void instance?.fitView({ padding: 0.18 }); setContextMenu(undefined); }}><Maximize2 size={14} /> Fit view</button>
          </>}
        </div>
      )}
    </section>
  );
}

export default TopologyCanvas;
