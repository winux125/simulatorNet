import type { LabDocument } from "@sim/contracts";
import type { LabUiSnapshot, SimulationTraceEvent } from "@sim/sim-worker";
import { create } from "zustand";

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
  activeTerminalDeviceId: string | undefined;
  workerStatus: "empty" | "loading" | "ready" | "error";
  dirty: boolean;
  error: string | undefined;
  filters: TraceFilters;
  setDraft(draft: LabDocument | undefined, dirty?: boolean): void;
  setSnapshot(snapshot: LabUiSnapshot): void;
  appendTraces(events: SimulationTraceEvent[]): void;
  clearTraces(): void;
  selectNode(id: string | undefined): void;
  setWorkerStatus(status: WorkspaceState["workerStatus"]): void;
  setError(error: string | undefined): void;
  setFilter(filter: Partial<TraceFilters>): void;
  reset(): void;
}

const initialState = {
  draft: undefined,
  snapshot: undefined,
  traces: [],
  selectedNodeId: undefined,
  activeTerminalDeviceId: undefined,
  workerStatus: "empty" as const,
  dirty: false,
  error: undefined,
  filters: { device: "", type: "", search: "" },
};

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  ...initialState,
  setDraft: (draft, dirty = false) => set({ draft, dirty }),
  setSnapshot: (snapshot) => set({ snapshot, workerStatus: "ready" }),
  appendTraces: (events) => set((state) => ({ traces: [...state.traces, ...events].slice(-300) })),
  clearTraces: () => set({ traces: [] }),
  selectNode: (id) => set({ selectedNodeId: id, activeTerminalDeviceId: id }),
  setWorkerStatus: (workerStatus) => set({ workerStatus }),
  setError: (error) => error ? set({ error, workerStatus: "error" }) : set({ error: undefined }),
  setFilter: (filter) => set((state) => ({ filters: { ...state.filters, ...filter } })),
  reset: () => set(initialState),
}));
