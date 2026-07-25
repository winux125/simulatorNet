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

describe("M10.3.2c unified terminal state", () => {
  it("opens the first terminal in the current docked presentation", () => {
    const store = useWorkspaceStore.getState();
    store.setTerminalPresentationMode("docked");
    store.reset();
    store.openTerminal("router-1");
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["router-1"],
      activeTerminalDeviceId: "router-1",
      terminalPresentationMode: "docked",
      terminalVisible: true,
      terminalMinimized: false,
      dockTab: "terminal",
    });
  });

  it("shares, reorders, and activates one tab list across presentations", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.openTerminal("router-1");
    store.openTerminal("switch-1");
    store.openTerminal("pc-1");
    store.reorderTerminal(2, 0);
    store.setTerminalPresentationMode("floating");
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["pc-1", "router-1", "switch-1"],
      activeTerminalDeviceId: "pc-1",
      terminalPresentationMode: "floating",
    });
  });

  it("closes other tabs and tabs to the right without touching the retained session", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    for (const id of ["router-1", "switch-1", "pc-1"]) store.openTerminal(id);
    store.closeTerminalsToRight("router-1");
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["router-1"]);
    store.openTerminal("switch-1");
    store.openTerminal("pc-1");
    store.closeOtherTerminals("switch-1");
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["switch-1"],
      activeTerminalDeviceId: "switch-1",
    });
  });

  it("hides the terminal without closing tabs and restores it without minimizing", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.openTerminal("pc-1");
    store.setTerminalMinimized(true);
    store.setTerminalVisible(false);
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["pc-1"],
      terminalVisible: false,
      terminalMinimized: true,
    });
    store.setTerminalVisible(true);
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["pc-1"],
      terminalVisible: true,
      terminalMinimized: false,
    });
  });

  it("restores maximized presentation to the previous dock or floating mode", () => {
    const store = useWorkspaceStore.getState();
    store.setTerminalPresentationMode("floating");
    store.setTerminalPresentationMode("maximized");
    store.restoreTerminalPresentation();
    expect(useWorkspaceStore.getState().terminalPresentationMode).toBe("floating");
  });

  it("keeps local presentation preferences while clearing lab-owned sessions", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.setTerminalPresentationMode("floating");
    store.setTerminalFloatingBounds({ x: 10, y: 20, width: 600, height: 300 });
    store.setTerminalDockHeight(240);
    store.openTerminal("router-1");
    store.reset();
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: [],
      activeTerminalDeviceId: undefined,
      terminalPresentationMode: "floating",
      terminalFloatingBounds: { x: 10, y: 20, width: 600, height: 300 },
      terminalDockHeight: 240,
      terminalVisible: false,
    });
  });
});

describe("M10.3.2d presentation history", () => {
  it("keeps diagram and position history bounded to 150 documents", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);

    for (let index = 1; index <= 155; index += 1) {
      const current = useWorkspaceStore.getState().draft!;
      store.applyDraft(withNodePosition(current, "pc-1", { x: 90 + index, y: 130 }), "presentation");
    }

    expect(useWorkspaceStore.getState().past).toHaveLength(150);
    for (let index = 0; index < 150; index += 1) store.undo();
    expect(useWorkspaceStore.getState().draft?.topology.nodes.find((node) => node.id === "pc-1")?.position?.x).toBe(95);
  });

  it("rebases network configuration across presentation undo and redo", () => {
    const store = useWorkspaceStore.getState();
    store.reset();
    store.replaceDraft(HUB_ETHERNET_DEMO);
    store.applyDraft(withNodePosition(HUB_ETHERNET_DEMO, "pc-1", { x: 190, y: 130 }), "presentation");
    const configured = structuredClone(useWorkspaceStore.getState().draft!);
    configured.configurations["pc-1"]!.hostname = "RENAMED-PC";

    store.applyDraft(configured, "configuration");
    store.undo();
    expect(useWorkspaceStore.getState().draft?.configurations["pc-1"]?.hostname).toBe("RENAMED-PC");
    expect(useWorkspaceStore.getState().draft?.topology.nodes.find((node) => node.id === "pc-1")?.position?.x).toBe(90);
    store.redo();
    expect(useWorkspaceStore.getState().draft?.configurations["pc-1"]?.hostname).toBe("RENAMED-PC");
    expect(useWorkspaceStore.getState().draft?.topology.nodes.find((node) => node.id === "pc-1")?.position?.x).toBe(190);

    store.undo();
    const reconfigured = structuredClone(useWorkspaceStore.getState().draft!);
    reconfigured.configurations["pc-1"]!.hostname = "RENAMED-AGAIN";
    store.applyDraft(reconfigured, "configuration");
    store.redo();
    expect(useWorkspaceStore.getState().draft?.configurations["pc-1"]?.hostname).toBe("RENAMED-AGAIN");
    expect(useWorkspaceStore.getState().draft?.topology.nodes.find((node) => node.id === "pc-1")?.position?.x).toBe(190);
  });
});
