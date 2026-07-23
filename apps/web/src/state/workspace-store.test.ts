import { describe, expect, it } from "vitest";
import { isTopologyEditable, useWorkspaceStore, type LabPowerState } from "./workspace-store";

describe("M10.2.2c lab power state", () => {
  it("only treats the stopped state as topology-editable", () => {
    expect(isTopologyEditable("stopped")).toBe(true);
    for (const state of ["starting", "running", "stopping", "error"] as LabPowerState[]) {
      expect(isTopologyEditable(state)).toBe(false);
    }
  });

  it("defaults a fresh workspace to stopped", () => {
    useWorkspaceStore.getState().reset();
    expect(useWorkspaceStore.getState().powerState).toBe("stopped");
  });

  it("tracks explicit power transitions", () => {
    const store = useWorkspaceStore.getState();
    store.setPowerState("starting");
    expect(useWorkspaceStore.getState().powerState).toBe("starting");
    store.setPowerState("running");
    expect(useWorkspaceStore.getState().powerState).toBe("running");
    store.reset();
    expect(useWorkspaceStore.getState().powerState).toBe("stopped");
  });
});
