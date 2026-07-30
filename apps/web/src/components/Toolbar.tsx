import type { EngineUiState } from "@sim/sim-worker";
import {
  Cable, FilePlus2, FolderOpen, Lock, LogOut, Maximize2, MousePointer2, Network, Play,
  Redo2, Save, Square, Trash2, Undo2, Unlock, UserRound, ZoomIn, ZoomOut,
} from "lucide-react";
import type { ReactNode } from "react";
import { canZoomIn, canZoomOut, formatZoomPercent } from "../features/topology/canvas-navigation";
import type { ExecutionMode, LabPowerState, WorkspaceMode, WorkspaceTool } from "../state/workspace-store";
import { IconButton, StatusIndicator } from "../ui";
import { MenuBar, type MenuDef } from "./MenuBar";

interface ToolbarProps {
  menus: MenuDef[];
  devicePicker?: ReactNode;
  labTitle?: string;
  sessionScope: string;
  workerStatus: "empty" | "loading" | "ready" | "error";
  engineState?: EngineUiState;
  ready: boolean;
  unsaved: boolean;
  powerState: LabPowerState;
  mode: WorkspaceMode;
  executionMode: ExecutionMode;
  activeTool: WorkspaceTool;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  /** Current canvas scale, so the zoom controls can bound themselves. */
  zoomScale: number;
  session?: { displayName: string; organizationName: string; role: string };
  sessionPending: boolean;
  onModeChange(mode: WorkspaceMode): void;
  onTool(tool: WorkspaceTool): void;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onDelete(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onFit(): void;
  onOpenPacketTrace(): void;
  onStartLab(): void;
  onStopLab(): void;
  onLogout(): void;
}

const POWER_LABEL: Record<LabPowerState, string> = {
  stopped: "Stopped", starting: "Starting", running: "Running", stopping: "Stopping", error: "Error",
};

export function Toolbar(props: ToolbarProps) {
  const workerLabel = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "Paused" : props.engineState === "running" ? "Running" : "Ready"
    : props.workerStatus === "loading" ? "Loading" : props.workerStatus === "error" ? "Error" : "Offline";
  const status = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "paused" : props.engineState === "running" ? "running" : "ready"
    : props.workerStatus === "loading" ? "loading" : props.workerStatus === "error" ? "error" : "down";

  return (
    <header className="desktop-chrome" aria-label="Simulation toolbar">
      <div className="app-menu-row">
        <div className="app-menu-row__lead">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <strong className="brand-wordmark">SimulatorNet</strong>
          <MenuBar menus={props.menus} />
        </div>
        <div className="app-menu-row__context">
          <div className="app-bar__lab" aria-label="Active laboratory">
            <span className="app-bar__scope" data-scope={props.session ? "organization" : "local"}>{props.sessionScope}</span>
            <strong>{props.labTitle ?? "No laboratory loaded"}</strong>
            {props.unsaved && <StatusIndicator status="unsaved" label="Unsaved" />}
          </div>
          <StatusIndicator status={status} label={workerLabel} />
          {props.session ? (
            <div className="session-identity" aria-label="Authenticated organization session">
              <UserRound size={14} aria-hidden="true" />
              <span><strong>{props.session.displayName}</strong><small>{props.session.organizationName} · {props.session.role.replaceAll("_", " ")}</small></span>
              <IconButton label="Log out organization session" icon={<LogOut size={14} />} onClick={props.onLogout} />
            </div>
          ) : <span className="session-anonymous">{props.sessionPending ? "Checking session…" : "Anonymous"}</span>}
        </div>
      </div>

      <div className="action-toolbar" aria-label="Workspace actions">
        <ToolbarGroup label="File actions">
          <IconButton label="New lab" icon={<FilePlus2 size={15} />} onClick={props.onNew} />
          <IconButton label="Open lab" icon={<FolderOpen size={15} />} onClick={props.onOpen} />
          <IconButton label="Save lab" icon={<Save size={15} />} disabled={!props.ready} onClick={props.onSave} />
        </ToolbarGroup>
        <ToolbarGroup label="History actions">
          <IconButton label="Undo" icon={<Undo2 size={15} />} disabled={!props.canUndo} onClick={props.onUndo} />
          <IconButton label="Redo" icon={<Redo2 size={15} />} disabled={!props.canRedo} onClick={props.onRedo} />
        </ToolbarGroup>
        {props.devicePicker && <ToolbarGroup label="Add topology item">{props.devicePicker}</ToolbarGroup>}
        <ToolbarGroup label="Topology actions">
          <IconButton label="Select tool" icon={<MousePointer2 size={15} />} active={props.activeTool === "select"} onClick={() => props.onTool("select")} />
          <IconButton label="Add link" icon={<Cable size={15} />} active={props.activeTool === "add-link"} disabled={props.mode !== "edit"} onClick={() => props.onTool("add-link")} />
          <IconButton label="Delete selected" icon={<Trash2 size={15} />} disabled={props.mode !== "edit" || !props.canDelete} onClick={props.onDelete} />
        </ToolbarGroup>
        <ToolbarGroup label="Canvas actions">
          <IconButton label="Zoom out" icon={<ZoomOut size={15} />} disabled={!props.ready || !canZoomOut(props.zoomScale)} onClick={props.onZoomOut} />
          <span className="toolbar-zoom-level" aria-label={`Canvas zoom ${formatZoomPercent(props.zoomScale)}`}>{formatZoomPercent(props.zoomScale)}</span>
          <IconButton label="Zoom in" icon={<ZoomIn size={15} />} disabled={!props.ready || !canZoomIn(props.zoomScale)} onClick={props.onZoomIn} />
          <IconButton label="Fit topology" icon={<Maximize2 size={15} />} disabled={!props.ready} onClick={props.onFit} />
        </ToolbarGroup>

        <div className="toolbar-spacer" />
        <div className="lab-power" role="group" aria-label="Lab power">
          <StatusIndicator
            status={props.powerState === "running" ? "running" : props.powerState === "error" ? "error" : props.powerState === "stopped" ? "ready" : "loading"}
            label={POWER_LABEL[props.powerState]}
          />
          {props.powerState === "running" || props.powerState === "stopping" ? (
            <button type="button" className="lab-power__toggle is-running" disabled={!props.ready || props.powerState === "stopping"} onClick={props.onStopLab}>
              <Square size={13} /> Stop Lab
            </button>
          ) : (
            <button type="button" className="lab-power__toggle" disabled={!props.ready || props.powerState !== "stopped"} onClick={props.onStartLab}>
              <Play size={13} /> Start Lab
            </button>
          )}
          <span
            className="lab-power__lock"
            data-locked={props.powerState === "running"}
            aria-label={props.powerState === "running" ? "Topology connectivity locked" : "Topology connectivity unlocked"}
            title={props.powerState === "running"
              ? "Topology connectivity is locked while the lab is running. Layout, labels and notes can still be edited."
              : "Topology connectivity is unlocked — devices and links are editable."}
          >
            {props.powerState === "running" ? <Lock size={13} /> : <Unlock size={13} />}
          </span>
        </div>
        <button
          type="button"
          className={`edit-topology-toggle${props.mode === "edit" ? " is-active" : ""}`}
          aria-pressed={props.mode === "edit"}
          disabled={!props.ready}
          title={props.powerState === "running" ? "Stop the lab before changing devices or links." : undefined}
          onClick={() => props.onModeChange(props.mode === "edit" ? "simulate" : "edit")}
        >
          Edit Topology
        </button>
        <button
          type="button"
          className="execution-mode-indicator"
          aria-label={`Packet execution mode: ${props.executionMode === "auto" ? "Auto" : "Step"}. Open Packet Trace`}
          title="Open Packet Trace controls"
          disabled={!props.ready}
          onClick={props.onOpenPacketTrace}
        >
          <Network size={13} aria-hidden="true" />
          <span>Packet execution</span>
          <strong>{props.executionMode === "auto" ? "Auto" : "Step"}</strong>
        </button>
      </div>
    </header>
  );
}

function ToolbarGroup({ label, children }: { label: string; children: ReactNode }) {
  return <div className="toolbar-group" role="group" aria-label={label}>{children}</div>;
}
