import {
  ChevronsDownUp,
  CircleHelp,
  Download,
  FlaskConical,
  Maximize2,
  PanelBottom,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Upload,
} from "lucide-react";
import type { ChangeEvent } from "react";
import type { EngineUiState } from "@sim/sim-worker";
import type { WorkspaceMode } from "../state/workspace-store";
import { Button, IconButton, StatusIndicator } from "../ui";

interface ToolbarProps {
  labTitle?: string;
  workerStatus: "empty" | "loading" | "ready" | "error";
  engineState?: EngineUiState;
  ready: boolean;
  dirty: boolean;
  mode: WorkspaceMode;
  inspectorOpen: boolean;
  bottomDockOpen: boolean;
  onModeChange(mode: WorkspaceMode): void;
  onLoadDemo(): void;
  onLoadFile(file: File): void;
  onSave(): void;
  onReset(): void;
  onRun(): void;
  onStep(): void;
  onPause(): void;
  onFit(): void;
  onToggleInspector(): void;
  onToggleBottomDock(): void;
  onOpenShortcuts(): void;
}

export function Toolbar(props: ToolbarProps) {
  const loadFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) props.onLoadFile(file);
    event.target.value = "";
  };
  const simulationEnabled = props.ready && props.mode === "simulate";
  const workerLabel = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "Paused" : props.engineState === "running" ? "Running" : "Ready"
    : props.workerStatus === "loading" ? "Loading" : props.workerStatus === "error" ? "Error" : "Offline";
  const status = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "paused" : props.engineState === "running" ? "running" : "ready"
    : props.workerStatus === "loading" ? "loading" : props.workerStatus === "error" ? "error" : "down";

  return (
    <header className="app-bar" aria-label="Simulation toolbar">
      <div className="app-bar__identity">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <div className="brand-copy"><strong>SimulatorNet</strong><span>{props.labTitle ?? "No laboratory loaded"}</span></div>
        {props.dirty && <StatusIndicator status="unsaved" label="Unsaved" />}
        <StatusIndicator status={status} label={workerLabel} />
      </div>

      <div className="mode-switch" role="group" aria-label="Workspace mode">
        <button type="button" className={props.mode === "edit" ? "is-active" : ""} aria-pressed={props.mode === "edit"} disabled={!props.ready} onClick={() => props.onModeChange("edit")}>Edit</button>
        <button type="button" className={props.mode === "simulate" ? "is-active" : ""} aria-pressed={props.mode === "simulate"} disabled={!props.ready} onClick={() => props.onModeChange("simulate")}>Simulate</button>
      </div>

      <div className="simulation-controls" aria-label="Simulation controls">
        <Button size="sm" variant="primary" icon={<Play size={14} />} disabled={!simulationEnabled || props.engineState === "paused"} onClick={props.onRun}>Run</Button>
        <IconButton label="Step 10 ms" icon={<SkipForward size={15} />} disabled={!simulationEnabled || props.engineState === "paused"} onClick={props.onStep} />
        <IconButton label={props.engineState === "paused" ? "Resume simulation" : "Pause simulation"} icon={props.engineState === "paused" ? <Play size={15} /> : <Pause size={15} />} active={props.engineState === "paused"} disabled={!simulationEnabled} onClick={props.onPause} />
        <IconButton label="Reset runtime" icon={<RotateCcw size={15} />} disabled={!simulationEnabled} onClick={props.onReset} />
      </div>

      <div className="app-bar__actions" aria-label="Workspace actions">
        <IconButton label="Load demo lab" icon={<FlaskConical size={15} />} onClick={props.onLoadDemo} />
        <label className="ui-icon-button tooltip-anchor" aria-label="Import lab JSON" data-tooltip="Import lab JSON" htmlFor="load-lab-file"><Upload size={15} /></label>
        <input id="load-lab-file" className="visually-hidden" type="file" accept="application/json,.json" onChange={loadFile} />
        <IconButton label="Export lab JSON" icon={<Download size={15} />} disabled={!props.ready} onClick={props.onSave} />
        <span className="app-bar__divider" />
        <IconButton label="Fit topology" icon={<Maximize2 size={15} />} disabled={!props.ready} onClick={props.onFit} />
        <IconButton label="Toggle inspector" icon={<PanelRight size={15} />} active={props.inspectorOpen} onClick={props.onToggleInspector} />
        <IconButton label="Toggle bottom dock" icon={props.bottomDockOpen ? <ChevronsDownUp size={15} /> : <PanelBottom size={15} />} active={props.bottomDockOpen} onClick={props.onToggleBottomDock} />
        <IconButton label="Keyboard shortcuts" icon={<CircleHelp size={15} />} onClick={props.onOpenShortcuts} />
      </div>
    </header>
  );
}
