import type { LabDocument, NodeSpec } from "@sim/contracts";
import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { create } from "zustand";

export type WorkspaceMode = "edit" | "simulate";
export type ExecutionMode = "realtime" | "simulation";
export type WorkspaceTool = "select" | "add-device" | "add-link" | "delete";

// Lab power lifecycle — a concept distinct from the Edit/Operate workspace mode
// and from the Realtime/Simulation execution mode. Topology may only be mutated
// while "stopped".
export type LabPowerState = "stopped" | "starting" | "running" | "stopping" | "error";

export type LabLifecycleErrorCode =
  | "LAB_NOT_STOPPED"
  | "LAB_ALREADY_RUNNING"
  | "LAB_ALREADY_STOPPED"
  | "LAB_START_FAILED"
  | "LAB_STOP_FAILED"
  | "TOPOLOGY_LOCKED"
  | "TOPOLOGY_MUTATION_REJECTED";

/** True only when the physical topology may be edited. */
export function isTopologyEditable(powerState: LabPowerState): boolean {
  return powerState === "stopped";
}
export type InspectorTab = "overview" | "interfaces" | "configuration" | "runtime";
export type DockTab = "terminal" | "events" | "packet-trace" | "problems";

export interface WorkspaceProblem {
  id: number;
  source: "worker" | "cli" | "validation";
  message: string;
}

interface TraceFilters {
  device: string;
  type: string;
  search: string;
}

interface WorkspaceState {
  draft: LabDocument | undefined;
  snapshot: LabUiSnapshot | undefined;
  traces: SimulationTraceEvent[];
  selectedNodeId: string | undefined;
  selectedLinkId: string | undefined;
  terminalTabs: string[];
  activeTerminalDeviceId: string | undefined;
  workerStatus: "empty" | "loading" | "ready" | "error";
  powerState: LabPowerState;
  mode: WorkspaceMode;
  executionMode: ExecutionMode;
  activeTool: WorkspaceTool;
  pendingDeviceKind: NodeSpec["kind"] | undefined;
  dirty: boolean;
  error: string | undefined;
  problems: WorkspaceProblem[];
  filters: TraceFilters;
  inspectorTab: InspectorTab;
  dockTab: DockTab;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  showLinkLabels: boolean;
  fitRequest: number;
  zoomResetRequest: number;
  zoomInRequest: number;
  zoomOutRequest: number;
  // Bounded topology-edit history (edit-mode drafts only) for Undo/Redo.
  past: LabDocument[];
  future: LabDocument[];
  setDraft(draft: LabDocument | undefined, dirty?: boolean): void;
  undo(): void;
  redo(): void;
  requestZoomReset(): void;
  setSnapshot(snapshot: LabUiSnapshot): void;
  appendTraces(events: SimulationTraceEvent[]): void;
  clearTraces(): void;
  selectNode(id: string | undefined): void;
  selectLink(id: string | undefined): void;
  openTerminal(deviceId: string): void;
  closeTerminal(deviceId: string): void;
  setActiveTerminal(deviceId: string): void;
  setWorkerStatus(status: WorkspaceState["workerStatus"]): void;
  setPowerState(state: LabPowerState): void;
  setMode(mode: WorkspaceMode): void;
  setExecutionMode(mode: ExecutionMode): void;
  setActiveTool(tool: WorkspaceTool): void;
  setPendingDeviceKind(kind: NodeSpec["kind"] | undefined): void;
  setError(error: string | undefined, source?: WorkspaceProblem["source"]): void;
  clearProblems(): void;
  setFilter(filter: Partial<TraceFilters>): void;
  setInspectorTab(tab: InspectorTab): void;
  setDockTab(tab: DockTab): void;
  setPaletteOpen(open: boolean): void;
  setInspectorOpen(open: boolean): void;
  setShowLinkLabels(show: boolean): void;
  requestFit(): void;
  requestZoomIn(): void;
  requestZoomOut(): void;
  reset(): void;
}

const initialState = {
  draft: undefined,
  snapshot: undefined,
  traces: [],
  selectedNodeId: undefined,
  selectedLinkId: undefined,
  terminalTabs: [],
  activeTerminalDeviceId: undefined,
  workerStatus: "empty" as const,
  powerState: "stopped" as LabPowerState,
  mode: "simulate" as const,
  executionMode: "realtime" as const,
  activeTool: "select" as const,
  pendingDeviceKind: undefined,
  dirty: false,
  error: undefined,
  problems: [],
  filters: { device: "", type: "", search: "" },
  inspectorTab: "overview" as const,
  dockTab: "terminal" as const,
  paletteOpen: false,
  inspectorOpen: true,
  showLinkLabels: true,
  fitRequest: 0,
  zoomResetRequest: 0,
  zoomInRequest: 0,
  zoomOutRequest: 0,
  past: [] as LabDocument[],
  future: [] as LabDocument[],
};

const MAX_HISTORY = 50;
let nextProblemId = 1;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialState,
  // A `dirty` write is a user topology edit: snapshot the previous draft so it can
  // be undone. Programmatic syncs (rebuild/merge/import) pass `dirty === false` and
  // leave the history untouched.
  setDraft: (draft, dirty = false) => set((state) => dirty && state.draft
    ? { draft, dirty, past: [...state.past, state.draft].slice(-MAX_HISTORY), future: [] }
    : { draft, dirty }),
  undo: () => set((state) => {
    const previous = state.past.at(-1);
    if (!previous || !state.draft) return {};
    return { draft: previous, past: state.past.slice(0, -1), future: [state.draft, ...state.future], dirty: true };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next || !state.draft) return {};
    return { draft: next, future: state.future.slice(1), past: [...state.past, state.draft], dirty: true };
  }),
  requestZoomReset: () => set((state) => ({ zoomResetRequest: state.zoomResetRequest + 1 })),
  setSnapshot: (snapshot) => set((state) => {
    const deviceIds = new Set(snapshot.nodes.map((node) => node.id));
    const terminalTabs = state.terminalTabs.filter((deviceId) => deviceIds.has(deviceId));
    const activeTerminalDeviceId = state.activeTerminalDeviceId && deviceIds.has(state.activeTerminalDeviceId)
      ? state.activeTerminalDeviceId
      : terminalTabs.at(-1);
    return { snapshot, workerStatus: "ready", terminalTabs, activeTerminalDeviceId };
  }),
  appendTraces: (events) => set((state) => ({ traces: [...state.traces, ...events].slice(-500) })),
  clearTraces: () => set({ traces: [] }),
  selectNode: (id) => set({ selectedNodeId: id, selectedLinkId: undefined }),
  selectLink: (id) => set({ selectedLinkId: id, selectedNodeId: undefined }),
  openTerminal: (deviceId) => set((state) => ({
    terminalTabs: state.terminalTabs.includes(deviceId) ? state.terminalTabs : [...state.terminalTabs, deviceId],
    activeTerminalDeviceId: deviceId,
    dockTab: "terminal",
  })),
  closeTerminal: (deviceId) => set((state) => {
    const terminalTabs = state.terminalTabs.filter((id) => id !== deviceId);
    const activeTerminalDeviceId = state.activeTerminalDeviceId === deviceId
      ? terminalTabs.at(-1)
      : state.activeTerminalDeviceId;
    return { terminalTabs, activeTerminalDeviceId };
  }),
  setActiveTerminal: (activeTerminalDeviceId) => set({ activeTerminalDeviceId, dockTab: "terminal" }),
  setWorkerStatus: (workerStatus) => set({ workerStatus }),
  setPowerState: (powerState) => set({ powerState }),
  setMode: (mode) => set({ mode, activeTool: "select", pendingDeviceKind: undefined, paletteOpen: false }),
  setExecutionMode: (executionMode) => set({ executionMode }),
  setActiveTool: (activeTool) => set({ activeTool, pendingDeviceKind: undefined, paletteOpen: false }),
  setPendingDeviceKind: (pendingDeviceKind) => set({
    pendingDeviceKind,
    activeTool: pendingDeviceKind ? "add-device" : "select",
  }),
  setError: (error, source = "worker") => error
    ? set((state) => ({
      error,
      workerStatus: source === "worker" ? "error" : state.workerStatus,
      problems: [...state.problems, { id: nextProblemId++, source, message: error }].slice(-100),
    }))
    : set({ error: undefined }),
  clearProblems: () => set({ problems: [], error: undefined }),
  setFilter: (filter) => set((state) => ({ filters: { ...state.filters, ...filter } })),
  setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
  setDockTab: (dockTab) => set({ dockTab }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setShowLinkLabels: (showLinkLabels) => set({ showLinkLabels }),
  requestFit: () => set((state) => ({ fitRequest: state.fitRequest + 1 })),
  requestZoomIn: () => set((state) => ({ zoomInRequest: state.zoomInRequest + 1 })),
  requestZoomOut: () => set((state) => ({ zoomOutRequest: state.zoomOutRequest + 1 })),
  reset: () => {
    nextProblemId = 1;
    set(initialState);
  },
}));
