import { DEVICE_TYPES, getDeviceProfile, type LabDocument, type NodeSpec } from "@sim/contracts";
import type { LabUiSnapshot } from "@sim/sim-worker";
import { Cable, Eye, FilePlus2, FlaskConical, Maximize2, Monitor, Network, Router as RouterIcon, Tag, Upload } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { WorkspaceMode, WorkspaceTool } from "../../state/workspace-store";
import { Button, StatusIndicator } from "../../ui";
import {
  addDraftDevice,
  duplicateDraftDevice,
  removeDraftDevice,
  removeDraftLink,
  renameDraftDevice,
  withNodePosition,
} from "../lab/document";
import { TopologyGraphSurface } from "./TopologyGraphSurface";
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
  showLinkLabels: boolean;
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
  onShowLinkLabels(show: boolean): void;
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

export function TopologyCanvas(props: TopologyCanvasProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>();
  const graphApi = useRef<{ clientToLocal(point: Point): Point; fit(): void } | undefined>(undefined);
  const status = useMemo(() => new Map(props.snapshot?.nodes.map((node) => [node.id, node])), [props.snapshot]);
  const editable = props.mode === "edit";

  const openNodeMenu = useCallback((id: string, event: ReactMouseEvent) => {
    event.preventDefault();
    props.onSelectNode(id);
    setContextMenu({ kind: "node", id, x: event.clientX, y: event.clientY });
  }, [props]);

  const view = useMemo<TopologyView>(() => {
    const result: TopologyView = { nodes: {}, links: {} };
    if (!props.document) return result;
    for (const node of props.document.topology.nodes) {
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
      result.links[link.id] = {
        operational: Boolean(sourceInterface?.operationalUp && targetInterface?.operationalUp),
        selected,
        label: props.showLinkLabels || selected ? `${link.a.iface}  ↔  ${link.b.iface}` : undefined,
      };
    }
    return result;
  }, [props, status, openNodeMenu]);

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
      if (action === "labels") props.onShowLinkLabels(!props.showLinkLabels);
      if (action === "delete") props.onChange(removeDraftLink(document, contextMenu.id));
    }
    setContextMenu(undefined);
  };

  return (
    <section
      className={`topology-panel topology-panel--${props.mode}`}
      aria-label="Topology canvas"
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="canvas-statusbar">
        <StatusIndicator status={props.mode === "edit" ? "unsaved" : "ready"} label={props.mode === "edit" ? "Edit topology" : "Live simulation"} />
        <span>{document.topology.nodes.length} devices</span>
        <span>{document.topology.links.length} links</span>
        {props.activeTool === "add-link" && <strong><Cable size={12} /> Drag between interface endpoints</strong>}
        <button type="button" aria-label="Toggle link labels" aria-pressed={props.showLinkLabels} onClick={() => props.onShowLinkLabels(!props.showLinkLabels)}><Tag size={13} /> Port labels</button>
      </div>
      <TopologyGraphSurface
        document={document}
        view={view}
        readonly={!editable}
        draggable={editable && props.activeTool === "select"}
        connectable={editable && props.activeTool === "add-link"}
        fitRequest={props.fitRequest}
        zoomResetRequest={props.zoomResetRequest}
        zoomInRequest={props.zoomInRequest}
        zoomOutRequest={props.zoomOutRequest}
        onReady={(handle) => { graphApi.current = handle; }}
        onNodeMoved={(id, position) => { if (editable) props.onChange(withNodePosition(document, id, position)); }}
        onConnect={(source, sourcePort, target, targetPort) => {
          if (!editable) return;
          props.onChange(createLink(document, source, sourcePort, target, targetPort).document);
        }}
        onConnectionRejected={props.onError}
        onSelectLink={props.onSelectLink}
        onLinkContextMenu={(id, x, y) => { props.onSelectLink(id); setContextMenu({ kind: "link", id, x, y }); }}
        onPaneClick={paneClick}
        onPaneContextMenu={(x, y) => setContextMenu({ kind: "pane", x, y })}
        onDropDevice={(kind, local) => { if ((DEVICE_TYPES as readonly string[]).includes(kind)) addAt(kind as NodeSpec["kind"], local); }}
      />
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
            <button role="menuitem" type="button" onClick={() => { graphApi.current?.fit(); setContextMenu(undefined); }}><Maximize2 size={14} /> Fit view</button>
          </>}
        </div>
      )}
    </section>
  );
}

export default TopologyCanvas;
