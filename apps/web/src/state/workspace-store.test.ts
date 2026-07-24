import { describe, expect, it } from "vitest";
import { HUB_ETHERNET_DEMO } from "../fixtures/m10-demo-labs";
import { addDraftDevice, withNodePosition } from "../features/lab/document";
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

describe("M10.2.3c workspace change state", () => {
  it("keeps Unsaved independent from Pending topology changes", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);

    store.applyDraft(withNodePosition(HUB_ETHERNET_DEMO, "pc-1", { x: 240, y: 180 }), "presentation");
    expect(useWorkspaceStore.getState()).toMatchObject({
      unsaved: true,
      pendingTopologyChanges: false,
    });

    const moved = useWorkspaceStore.getState().draft!;
    store.applyDraft(addDraftDevice(moved, "router"), "structural");
    expect(useWorkspaceStore.getState()).toMatchObject({
      unsaved: true,
      pendingTopologyChanges: true,
    });
  });

  it("clears only the relevant state when topology is applied or the document is saved", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);
    store.applyDraft(addDraftDevice(HUB_ETHERNET_DEMO, "router"), "structural");
    const changed = useWorkspaceStore.getState().draft!;

    store.acceptTopology(changed);
    expect(useWorkspaceStore.getState()).toMatchObject({
      unsaved: true,
      pendingTopologyChanges: false,
    });

    store.markSaved(changed);
    expect(useWorkspaceStore.getState()).toMatchObject({
      unsaved: false,
      pendingTopologyChanges: false,
    });
  });

  it("can save a structural draft while it remains pending application", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);
    store.applyDraft(addDraftDevice(HUB_ETHERNET_DEMO, "router"), "structural");
    const changed = useWorkspaceStore.getState().draft!;
    store.markSaved(changed);
    expect(useWorkspaceStore.getState()).toMatchObject({
      unsaved: false,
      pendingTopologyChanges: true,
    });
  });

  it("recomputes structural pending state across undo and redo", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);
    store.applyDraft(addDraftDevice(HUB_ETHERNET_DEMO, "router"), "structural");
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(true);
    store.undo();
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(false);
    store.redo();
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(true);
  });
});
