import type { LabDocument, NodeSpec } from "@sim/contracts";
import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { create } from "zustand";
import {
  assertLabChangeImpact,
  hasStructuralChanges,
  LabChangeImpactError,
  type LabChangeImpact,
} from "../features/lab/change-impact";

export type WorkspaceMode = "edit" | "simulate";
export type ExecutionMode = "auto" | "step";
export type WorkspaceTool =
  | "select"
  | "add-device"
  | "add-link"
  | "delete"
  | "annotation-text"
  | "annotation-rectangle"
  | "annotation-ellipse"
  | "annotation-line"
  | "annotation-arrow";
export type PortLabelMode = "always" | "selected" | "hidden";

// Lab power lifecycle — a concept distinct from the Edit/Operate workspace mode
// and from the Auto/Step packet execution mode. Topology may only be mutated
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
  source: "worker" | "cli" | "validation" | "runtime";
  message: string;
}

interface TraceFilters {
  device: string;
  type: string;
  search: string;
}

interface WorkspaceState {
  draft: LabDocument | undefined;
  savedDocument: LabDocument | undefined;
  appliedDocument: LabDocument | undefined;
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
  unsaved: boolean;
  pendingTopologyChanges: boolean;
  error: string | undefined;
  problems: WorkspaceProblem[];
  filters: TraceFilters;
  inspectorTab: InspectorTab;
  dockTab: DockTab;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  portLabelMode: PortLabelMode;
  fitRequest: number;
  zoomResetRequest: number;
  zoomInRequest: number;
  zoomOutRequest: number;
  // Bounded topology-edit history (edit-mode drafts only) for Undo/Redo.
  past: LabDocument[];
  future: LabDocument[];
  replaceDraft(draft: LabDocument | undefined): void;
  applyDraft(draft: LabDocument, impact: LabChangeImpact): void;
  synchronizeConfiguration(draft: LabDocument): void;
  acceptTopology(draft: LabDocument): void;
  markSaved(draft: LabDocument): void;
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
  replaceRuntimeWarnings(messages: string[]): void;
  setFilter(filter: Partial<TraceFilters>): void;
  setInspectorTab(tab: InspectorTab): void;
  setDockTab(tab: DockTab): void;
  setPaletteOpen(open: boolean): void;
  setInspectorOpen(open: boolean): void;
  setPortLabelMode(mode: PortLabelMode): void;
  requestFit(): void;
  requestZoomIn(): void;
  requestZoomOut(): void;
  reset(): void;
}

const initialState = {
  draft: undefined,
  savedDocument: undefined,
  appliedDocument: undefined,
  snapshot: undefined,
  traces: [],
  selectedNodeId: undefined,
  selectedLinkId: undefined,
  terminalTabs: [],
  activeTerminalDeviceId: undefined,
  workerStatus: "empty" as const,
  powerState: "stopped" as LabPowerState,
  mode: "simulate" as const,
  executionMode: "auto" as const,
  activeTool: "select" as const,
  pendingDeviceKind: undefined,
  unsaved: false,
  pendingTopologyChanges: false,
  error: undefined,
  problems: [],
  filters: { device: "", type: "", search: "" },
  inspectorTab: "overview" as const,
  dockTab: "terminal" as const,
  paletteOpen: false,
  inspectorOpen: false,
  portLabelMode: "always" as const,
  fitRequest: 0,
  zoomResetRequest: 0,
  zoomInRequest: 0,
  zoomOutRequest: 0,
  past: [] as LabDocument[],
  future: [] as LabDocument[],
};

const MAX_HISTORY = 50;
let nextProblemId = 1;

function matchesSavedDocument(document: LabDocument, saved: LabDocument | undefined): boolean {
  return saved !== undefined && (document === saved || JSON.stringify(document) === JSON.stringify(saved));
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialState,
  replaceDraft: (draft) => set({
    draft,
    savedDocument: draft,
    appliedDocument: draft,
    unsaved: false,
    pendingTopologyChanges: false,
    past: [],
    future: [],
  }),
  applyDraft: (draft, impact) => set((state) => {
    if (!state.draft) return {};
    const actual = assertLabChangeImpact(state.draft, draft, impact);
    if (actual === "none") return {};
    return {
      draft,
      unsaved: true,
      pendingTopologyChanges: hasStructuralChanges(state.appliedDocument, draft),
      past: [...state.past, state.draft].slice(-MAX_HISTORY),
      future: [],
    };
  }),
  synchronizeConfiguration: (draft) => set((state) => {
    if (!state.draft) return {};
    if (hasStructuralChanges(state.draft, draft)) {
      throw new LabChangeImpactError("configuration", "structural");
    }
    if (JSON.stringify(state.draft) === JSON.stringify(draft)) return {};
    const configurationChanged = JSON.stringify(state.draft.configurations) !== JSON.stringify(draft.configurations);
    return {
      draft,
      // Canonical serialization can normalize presentation-only ordering. That
      // normalization is not itself a new user edit; runtime config changes are.
      unsaved: state.unsaved || configurationChanged,
      pendingTopologyChanges: hasStructuralChanges(state.appliedDocument, draft),
    };
  }),
  acceptTopology: (draft) => set((state) => ({
    draft,
    appliedDocument: draft,
    unsaved: state.unsaved,
    pendingTopologyChanges: false,
  })),
  markSaved: (draft) => set((state) => ({
    draft,
    savedDocument: draft,
    unsaved: false,
    pendingTopologyChanges: hasStructuralChanges(state.appliedDocument, draft),
  })),
  undo: () => set((state) => {
    const previous = state.past.at(-1);
    if (!previous || !state.draft) return {};
    return {
      draft: previous,
      past: state.past.slice(0, -1),
      future: [state.draft, ...state.future],
      unsaved: !matchesSavedDocument(previous, state.savedDocument),
      pendingTopologyChanges: hasStructuralChanges(state.appliedDocument, previous),
    };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next || !state.draft) return {};
    return {
      draft: next,
      future: state.future.slice(1),
      past: [...state.past, state.draft],
      unsaved: !matchesSavedDocument(next, state.savedDocument),
      pendingTopologyChanges: hasStructuralChanges(state.appliedDocument, next),
    };
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
  replaceRuntimeWarnings: (messages) => set((state) => ({
    problems: [
      ...state.problems.filter((problem) => problem.source !== "runtime"),
      ...[...new Set(messages)].sort().map((message) => ({ id: nextProblemId++, source: "runtime" as const, message })),
    ].slice(-100),
  })),
  setFilter: (filter) => set((state) => ({ filters: { ...state.filters, ...filter } })),
  setInspectorTab: (inspectorTab) => set({ inspectorTab, inspectorOpen: true }),
  setDockTab: (dockTab) => set({ dockTab }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setPortLabelMode: (portLabelMode) => set({ portLabelMode }),
  requestFit: () => set((state) => ({ fitRequest: state.fitRequest + 1 })),
  requestZoomIn: () => set((state) => ({ zoomInRequest: state.zoomInRequest + 1 })),
  requestZoomOut: () => set((state) => ({ zoomOutRequest: state.zoomOutRequest + 1 })),
  reset: () => {
    nextProblemId = 1;
    set(initialState);
  },
}));
