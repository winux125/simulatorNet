import { Pause, Play, RotateCcw, SkipForward, SunMoon, LogOut, UserRound } from "lucide-react";
import type { EngineUiState } from "@sim/sim-worker";
import type { WorkspaceMode } from "../state/workspace-store";
import type { ThemePreference } from "../hooks/useTheme";
import { IconButton, StatusIndicator } from "../ui";
import { MenuBar, type MenuDef } from "./MenuBar";

interface ToolbarProps {
  menus: MenuDef[];
  labTitle?: string;
  sessionScope: string;
  workerStatus: "empty" | "loading" | "ready" | "error";
  engineState?: EngineUiState;
  ready: boolean;
  dirty: boolean;
  mode: WorkspaceMode;
  theme: ThemePreference;
  session?: { displayName: string; organizationName: string; role: string };
  sessionPending: boolean;
  onModeChange(mode: WorkspaceMode): void;
  onRun(): void;
  onStep(): void;
  onPause(): void;
  onReset(): void;
  onThemeChange(theme: ThemePreference): void;
  onLogout(): void;
}

export function Toolbar(props: ToolbarProps) {
  const simulationEnabled = props.ready && props.mode === "simulate";
  const workerLabel = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "Paused" : props.engineState === "running" ? "Running" : "Ready"
    : props.workerStatus === "loading" ? "Loading" : props.workerStatus === "error" ? "Error" : "Offline";
  const status = props.workerStatus === "ready"
    ? props.engineState === "paused" ? "paused" : props.engineState === "running" ? "running" : "ready"
    : props.workerStatus === "loading" ? "loading" : props.workerStatus === "error" ? "error" : "down";

  return (
    <header className="app-bar" aria-label="Simulation toolbar">
      <div className="app-bar__lead">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
        <strong className="brand-wordmark">SimulatorNet</strong>
        <MenuBar menus={props.menus} />
      </div>

      <div className="app-bar__actions" aria-label="Workspace actions">
        <div className="app-bar__lab" aria-label="Active laboratory">
          <span className="app-bar__scope" data-scope={props.session ? "organization" : "local"}>{props.sessionScope}</span>
          <strong>{props.labTitle ?? "No laboratory loaded"}</strong>
          {props.dirty && <StatusIndicator status="unsaved" label="Unsaved" />}
        </div>

        <div className="mode-switch" role="group" aria-label="Workspace mode">
          <button type="button" className={props.mode === "edit" ? "is-active" : ""} aria-pressed={props.mode === "edit"} disabled={!props.ready} onClick={() => props.onModeChange("edit")}>Edit</button>
          <button type="button" className={props.mode === "simulate" ? "is-active" : ""} aria-pressed={props.mode === "simulate"} disabled={!props.ready} onClick={() => props.onModeChange("simulate")}>Simulate</button>
        </div>

        <div className="simulation-controls" aria-label="Simulation controls">
          <IconButton label="Run until idle" icon={<Play size={15} />} disabled={!simulationEnabled || props.engineState === "paused"} onClick={props.onRun} />
          <IconButton label="Advance one step" icon={<SkipForward size={15} />} disabled={!simulationEnabled || props.engineState === "paused"} onClick={props.onStep} />
          <IconButton label={props.engineState === "paused" ? "Resume simulation" : "Pause simulation"} icon={props.engineState === "paused" ? <Play size={15} /> : <Pause size={15} />} active={props.engineState === "paused"} disabled={!simulationEnabled} onClick={props.onPause} />
          <IconButton label="Reset runtime" icon={<RotateCcw size={15} />} disabled={!simulationEnabled} onClick={props.onReset} />
        </div>

        <span className="app-bar__divider" />
        <StatusIndicator status={status} label={workerLabel} />

        {props.session ? (
          <div className="session-identity" aria-label="Authenticated organization session">
            <UserRound size={14} aria-hidden="true" />
            <span><strong>{props.session.displayName}</strong><small>{props.session.organizationName} · {props.session.role.replaceAll("_", " ")}</small></span>
            <IconButton label="Log out organization session" icon={<LogOut size={14} />} onClick={props.onLogout} />
          </div>
        ) : <span className="session-anonymous">{props.sessionPending ? "Checking session…" : "Anonymous"}</span>}

        <label className="theme-control tooltip-anchor" data-tooltip="Theme" title="Theme">
          <SunMoon size={15} aria-hidden="true" />
          <span className="visually-hidden">Color theme</span>
          <select aria-label="Color theme" value={props.theme} onChange={(event) => props.onThemeChange(event.target.value as ThemePreference)}>
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
      </div>
    </header>
  );
}
