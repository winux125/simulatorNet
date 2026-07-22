import type { LabDocument } from "@sim/contracts";
import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { create } from "zustand";

export type WorkspaceMode = "edit" | "simulate";
export type WorkspaceTool = "select" | "add-device" | "add-link" | "delete";
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
  mode: WorkspaceMode;
  activeTool: WorkspaceTool;
  dirty: boolean;
  error: string | undefined;
  problems: WorkspaceProblem[];
  filters: TraceFilters;
  inspectorTab: InspectorTab;
  dockTab: DockTab;
  paletteOpen: boolean;
  inspectorOpen: boolean;
  bottomDockOpen: boolean;
  showLinkLabels: boolean;
  fitRequest: number;
  setDraft(draft: LabDocument | undefined, dirty?: boolean): void;
  setSnapshot(snapshot: LabUiSnapshot): void;
  appendTraces(events: SimulationTraceEvent[]): void;
  clearTraces(): void;
  selectNode(id: string | undefined): void;
  selectLink(id: string | undefined): void;
  openTerminal(deviceId: string): void;
  closeTerminal(deviceId: string): void;
  setActiveTerminal(deviceId: string): void;
  setWorkerStatus(status: WorkspaceState["workerStatus"]): void;
  setMode(mode: WorkspaceMode): void;
  setActiveTool(tool: WorkspaceTool): void;
  setError(error: string | undefined, source?: WorkspaceProblem["source"]): void;
  clearProblems(): void;
  setFilter(filter: Partial<TraceFilters>): void;
  setInspectorTab(tab: InspectorTab): void;
  setDockTab(tab: DockTab): void;
  setPaletteOpen(open: boolean): void;
  setInspectorOpen(open: boolean): void;
  setBottomDockOpen(open: boolean): void;
  setShowLinkLabels(show: boolean): void;
  requestFit(): void;
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
  mode: "simulate" as const,
  activeTool: "select" as const,
  dirty: false,
  error: undefined,
  problems: [],
  filters: { device: "", type: "", search: "" },
  inspectorTab: "overview" as const,
  dockTab: "terminal" as const,
  paletteOpen: false,
  inspectorOpen: true,
  bottomDockOpen: true,
  showLinkLabels: true,
  fitRequest: 0,
};

let nextProblemId = 1;

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialState,
  setDraft: (draft, dirty = false) => set({ draft, dirty }),
  setSnapshot: (snapshot) => set({ snapshot, workerStatus: "ready" }),
  appendTraces: (events) => set((state) => ({ traces: [...state.traces, ...events].slice(-500) })),
  clearTraces: () => set({ traces: [] }),
  selectNode: (id) => set({ selectedNodeId: id, selectedLinkId: undefined }),
  selectLink: (id) => set({ selectedLinkId: id, selectedNodeId: undefined }),
  openTerminal: (deviceId) => set((state) => ({
    terminalTabs: state.terminalTabs.includes(deviceId) ? state.terminalTabs : [...state.terminalTabs, deviceId],
    activeTerminalDeviceId: deviceId,
    dockTab: "terminal",
    bottomDockOpen: true,
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
  setMode: (mode) => set({ mode, activeTool: "select", paletteOpen: false }),
  setActiveTool: (activeTool) => set({ activeTool, paletteOpen: activeTool === "add-device" }),
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
  setDockTab: (dockTab) => set({ dockTab, bottomDockOpen: true }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setBottomDockOpen: (bottomDockOpen) => set({ bottomDockOpen }),
  setShowLinkLabels: (showLinkLabels) => set({ showLinkLabels }),
  requestFit: () => set((state) => ({ fitRequest: state.fitRequest + 1 })),
  reset: () => {
    nextProblemId = 1;
    set(initialState);
  },
}));
