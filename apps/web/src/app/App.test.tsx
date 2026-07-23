// @vitest-environment jsdom

import type {
  SimWorkerEvent,
  SimWorkerPayloadByType,
  SimWorkerRequest,
  SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { createSimulationWorkerRuntime } from "@sim/sim-worker";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../state/workspace-store";
import { DEMO_LAB } from "../fixtures/demo-lab";
import {
  BRIDGE_MAC_DEMO,
  DNS_WEB_DEMO,
  HUB_ETHERNET_DEMO,
  L3_SWITCH_DEMO,
  NTP_SYSLOG_DEMO,
  SERVER_CONNECTIVITY_DEMO,
  TFTP_BACKUP_DEMO,
} from "../fixtures/m10-demo-labs";
import { THEME_STORAGE_KEY } from "../hooks/useTheme";
import { App } from "./App";
import type { SimulatorClient } from "./simulator-client";

interface MockXterm {
  output: string;
  clears: number;
  focused: number;
  disposed: boolean;
  selection: string;
  dataHandler?: (data: string) => void;
  emit(data: string): void;
}

const xtermHarness = vi.hoisted(() => ({ instances: [] as MockXterm[] }));
const graphHarness = vi.hoisted(() => ({
  fit: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    options = { theme: {} };
    output = "";
    clears = 0;
    focused = 0;
    disposed = false;
    selection = "";
    dataHandler?: (data: string) => void;
    constructor() { xtermHarness.instances.push(this as unknown as MockXterm); }
    loadAddon() {}
    open() {}
    write(chunk: string) { this.output += chunk; }
    clear() { this.clears += 1; this.output = ""; }
    getSelection() { return this.selection; }
    scrollToBottom() {}
    focus() { this.focused += 1; }
    onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose: () => { this.dataHandler = undefined; } }; }
    dispose() { this.disposed = true; }
    emit(data: string) { this.dataHandler?.(data); }
  }
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({ children, className }: { children: React.ReactNode; className?: string }) => React.createElement("div", { className }, children),
    Panel: ({ children }: { children: React.ReactNode }) => React.createElement("div", null, children),
    Separator: ({ className }: { className?: string }) => React.createElement("div", { className }),
  };
});
// The real X6 graph needs DOM measurement that jsdom does not provide, so — as
// with the previous React Flow integration — the canvas library is mocked at our
// own React binding boundary. The mock renders the same accessible DeviceNode
// buttons and link buttons so interaction tests drive the real components.
vi.mock("../features/topology/TopologyGraphSurface", async () => {
  const React = await import("react");
  const { DeviceNode } = await import("../features/topology/DeviceNode");
  function MockSurface(props: Record<string, unknown>) {
    const view = props.view as {
      nodes: Record<string, { selected: boolean; data: Record<string, unknown> }>;
      links: Record<string, { label?: string }>;
    };
    React.useEffect(() => {
      (props.onReady as ((handle: { clientToLocal(p: { x: number; y: number }): { x: number; y: number }; fit(): void }) => void) | undefined)?.({
        clientToLocal: ({ x, y }) => ({ x, y }),
        fit: graphHarness.fit,
      });
    }, []);
    React.useEffect(() => { if ((props.fitRequest as number) > 0) graphHarness.fit(); }, [props.fitRequest]);
    React.useEffect(() => { if ((props.zoomInRequest as number) > 0) graphHarness.zoomIn(); }, [props.zoomInRequest]);
    React.useEffect(() => { if ((props.zoomOutRequest as number) > 0) graphHarness.zoomOut(); }, [props.zoomOutRequest]);
    return React.createElement("div", {
      "data-testid": "topology-graph",
      onClick: (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
          (props.onPaneClick as ((p: { x: number; y: number }) => void) | undefined)?.({ x: event.clientX, y: event.clientY });
        }
      },
    }, [
      ...Object.entries(view.nodes).map(([id, node]) => React.createElement(DeviceNode as React.ComponentType<Record<string, unknown>>, {
        key: id, id, data: node.data, selected: node.selected,
      })),
      ...Object.entries(view.links).map(([id, link]) => React.createElement("button", {
        key: id,
        type: "button",
        "aria-label": `Select link ${id}`,
        onClick: () => (props.onSelectLink as ((linkId: string) => void))(id),
        onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); (props.onLinkContextMenu as ((linkId: string, x: number, y: number) => void))(id, event.clientX, event.clientY); },
      }, String(link.label ?? id))),
    ]);
  }
  return { TopologyGraphSurface: MockSurface, default: MockSurface };
});

class RuntimeClient implements SimulatorClient {
  readonly requestTypes: string[] = [];
  private readonly listeners = new Set<(event: SimWorkerEvent) => void>();
  private readonly runtime = createSimulationWorkerRuntime((message) => {
    if (message.type !== "REQUEST_SUCCEEDED" && message.type !== "REQUEST_FAILED") this.emit(message);
  });
  private nextId = 1;

  async request<Type extends SimWorkerRequest["type"]>(input: SimWorkerRequestInputOf<Type>): Promise<SimWorkerPayloadByType[Type]> {
    this.requestTypes.push(input.type);
    const response = this.runtime.handleRequest({ ...input, requestId: `test-${this.nextId++}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(listener: (event: SimWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: SimWorkerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

let compactViewport = false;
let narrowViewport = false;
let prefersDark = true;

beforeEach(() => {
  compactViewport = false;
  narrowViewport = false;
  prefersDark = true;
  xtermHarness.instances.length = 0;
  graphHarness.fit.mockClear();
  graphHarness.zoomIn.mockClear();
  graphHarness.zoomOut.mockClear();
  window.localStorage.clear();
  useWorkspaceStore.getState().reset();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({
    matches: query.includes("max-width: 999px")
      ? compactViewport
      : query.includes("max-width: 1299px")
        ? narrowViewport
        : query.includes("prefers-color-scheme: dark") ? prefersDark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) });
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => { callback(0); return 1; } });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => cleanup());

async function loadDemo(client: RuntimeClient) {
  render(<App client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: /^Load Demo Lab$/ }));
  await userEvent.click(screen.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }));
  await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe("demo-router-on-a-stick"));
}

async function enterEditMode() {
  await userEvent.click(screen.getByRole("button", { name: "Edit Topology" }));
  await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("edit"));
}

async function chooseTheme(label: "System" | "Dark" | "Light") {
  await openMenu("View");
  await userEvent.click(screen.getByRole("menuitem", { name: "Theme" }));
  await userEvent.click(screen.getByRole("menuitemradio", { name: label }));
}

async function placeDevice(label: string) {
  if (!screen.queryByRole("dialog", { name: "Add topology item" })) {
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
  }
  await userEvent.click(screen.getByRole("button", { name: `Add ${label}` }));
  fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 320, clientY: 240 });
}

async function openMenu(label: string) {
  await userEvent.click(screen.getByRole("menuitem", { name: label }));
}

async function openDeviceTerminal(deviceLabel: string): Promise<MockXterm> {
  fireEvent.contextMenu(screen.getByRole("button", { name: deviceLabel }));
  await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
  await waitFor(() => expect(xtermHarness.instances.length).toBeGreaterThan(0));
  const terminal = xtermHarness.instances.at(-1);
  if (!terminal) throw new Error("terminal not created");
  await waitFor(() => expect(terminal.dataHandler).toBeDefined());
  return terminal;
}

async function type(terminal: MockXterm, text: string) {
  await act(async () => { for (const ch of text) terminal.emit(ch); });
}

describe("M6.1 simulator workspace", () => {
  it("opens on a compact welcome workspace without loading the demo", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    expect(screen.getByRole("banner", { name: "Simulation toolbar" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Topology actions" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "File" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "SimulatorNet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Lab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import Lab" })).toBeTruthy();
    expect(useWorkspaceStore.getState().draft).toBeUndefined();
    expect(client.requestTypes).not.toContain("INITIALIZE_LAB");
    expect(document.querySelector(".app-shell")?.getAttribute("data-workspace-mode")).toBe("simulate");
  });

  it("creates an empty deterministic document from New Lab", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().draft?.id).toBe("untitled-lab"));
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(0);
    expect(useWorkspaceStore.getState().draft?.topology.links).toHaveLength(0);
    expect(useWorkspaceStore.getState().draft?.simulation.seed).toBe(1);
    expect(useWorkspaceStore.getState().mode).toBe("edit");
  });

  it("loads the demo fixture only after an explicit welcome action", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    expect(client.requestTypes).not.toContain("INITIALIZE_LAB");
    await userEvent.click(await screen.findByRole("button", { name: /^Load Demo Lab$/ }));
    await userEvent.click(screen.getByRole("button", { name: /Router-on-a-stick \+ DHCP/ }));
    await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe(DEMO_LAB.id));
    expect(screen.queryByRole("heading", { name: "SimulatorNet" })).toBeNull();
  });

  it("imports a lab directly from the welcome workspace", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const file = new File([JSON.stringify(DEMO_LAB)], "demo.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify(DEMO_LAB) });
    fireEvent.change(document.getElementById("load-lab-file")!, { target: { files: [file] } });
    await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe(DEMO_LAB.id));
    expect(screen.queryByRole("heading", { name: "SimulatorNet" })).toBeNull();
  });

  it("closes a clean lab back to the welcome workspace", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: "Close Lab" }));
    expect(await screen.findByRole("heading", { name: "SimulatorNet" })).toBeTruthy();
    expect(useWorkspaceStore.getState().draft).toBeUndefined();
  });

  it("requires confirmation before closing an unsaved lab", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: "Close Lab" }));
    expect(screen.getByRole("dialog", { name: "Close laboratory?" })).toBeTruthy();
    expect(useWorkspaceStore.getState().draft).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Discard & Close" }));
    expect(await screen.findByRole("heading", { name: "SimulatorNet" })).toBeTruthy();
  });

  it("does not render a topology minimap", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(document.querySelector(".x6-graph-minimap")).toBeNull();
    expect(document.querySelector(".x6-widget-minimap")).toBeNull();
  });

  it("defaults to System theme and switches Dark, Light and System immediately", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.queryByLabelText("Color theme")).toBeNull();
    await chooseTheme("Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await chooseTheme("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    prefersDark = false;
    await chooseTheme("System");
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });

  it("persists the selected theme in localStorage", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await chooseTheme("Light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    cleanup();
    render(<App client={new RuntimeClient()} />);
    expect(document.documentElement.dataset.themePreference).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("keeps topology and terminal mounted in dark and light themes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
    expect(await screen.findByLabelText("PC1 CLI")).toBeTruthy();
    await chooseTheme("Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByTestId("topology-graph")).toBeTruthy();
    expect(screen.getByLabelText("PC1 CLI")).toBeTruthy();
    await chooseTheme("Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("exposes the device palette as a toolbar dropdown", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    expect(screen.queryByRole("dialog", { name: "Add topology item" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    const picker = screen.getByRole("dialog", { name: "Add topology item" });
    expect(within(picker).getByRole("tab", { name: "Network Devices" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "End Devices" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "Connections" })).toBeTruthy();
  });

  it("switches palette categories and selects click-then-place models", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    expect(screen.getByRole("button", { name: "Add Router" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    expect(screen.getByRole("button", { name: "Add PC" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Server" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    expect(useWorkspaceStore.getState().pendingDeviceKind).toBe("pc");
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 300, clientY: 220 });
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(5);
    expect(useWorkspaceStore.getState().pendingDeviceKind).toBeUndefined();
  });

  it("keeps draft-only devices out of worker inspection until Apply & Rebuild", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: "New Lab" }));
    await placeDevice("Bridge");
    await userEvent.click(screen.getByRole("button", { name: "Select BR1" }));
    expect(await screen.findByText("Pending rebuild")).toBeTruthy();
    expect(screen.getByText("Apply & Rebuild to create this device in the simulation worker.")).toBeTruthy();
    expect(client.requestTypes).not.toContain("GET_DEVICE_INSPECTION");
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("selects a topology device", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    expect(useWorkspaceStore.getState().selectedNodeId).toBe("pc-1");
    expect(screen.getByRole("button", { name: "Select PC1" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("updates inspector content with selection", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select SW1" }));
    expect(await screen.findByText("switch-1")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Interfaces" }));
    expect(await screen.findByText("Gi0/8")).toBeTruthy();
  });

  it("opens, switches and closes multiple terminal tabs", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select SW1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["switch-1", "pc-1"]);
    await userEvent.click(screen.getByLabelText("Close SW1 CLI"));
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);
  });

  it("closes a device CLI when that device is deleted", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select SW1");
    expect(useWorkspaceStore.getState().terminalTabs).toContain("switch-1");

    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Select SW1" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(useWorkspaceStore.getState().terminalTabs).not.toContain("switch-1");
    expect(screen.queryByRole("tab", { name: /SW1/ })).toBeNull();
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("transitions between Edit and Simulate through rebuild", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Edit Topology" }));
    await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("simulate"));
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
    expect(client.requestTypes).toContain("REBUILD_LAB");
  });

  it("shows pending topology changes and rebuild action", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    expect(screen.getByText("Topology changes pending")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Apply & Rebuild" }).length).toBeGreaterThanOrEqual(1);
  });

  it("executes device context menu actions", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(5);
  });

  it("toggles topology link labels", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const toggle = screen.getByRole("button", { name: "Toggle link labels" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("reports imported document validation errors", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const file = new File(["not-json"], "broken.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => "not-json" });
    fireEvent.change(document.getElementById("load-lab-file")!, { target: { files: [file] } });
    expect((await screen.findByRole("alert")).textContent).toContain("not valid JSON");
  });

  it("exports the canonical LabDocument", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: /Save \/ Export Lab/ }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
  });

  it("does not trigger global shortcuts while typing in terminal", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    const before = client.requestTypes.filter((type) => type === "SERIALIZE_LAB").length;
    fireEvent.keyDown(screen.getByLabelText("PC1 CLI"), { key: "s", ctrlKey: true });
    expect(client.requestTypes.filter((type) => type === "SERIALIZE_LAB")).toHaveLength(before);
  });

  it("shows worker errors in the Problems panel", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    act(() => client.emit({ type: "RUNTIME_ERROR", error: { name: "Error", code: "worker-crash", message: "Worker transport crashed" } }));
    expect((await screen.findAllByText("Worker transport crashed")).length).toBeGreaterThanOrEqual(1);
    const problemsTab = screen.getByRole("tab", { name: /Problems/ });
    expect(within(problemsTab).getByText("1")).toBeTruthy();
  });

  it("collapses the desktop inspector into a responsive drawer", async () => {
    compactViewport = true;
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select R1" }));
    expect(document.querySelector(".app-shell")?.getAttribute("data-responsive")).toBe("compact");
    expect(document.querySelector(".inspector-panel.is-drawer")).toBeTruthy();
  });
});

describe("M10.2.1 Packet Tracer-style workspace", () => {
  it("renders the seven desktop menus and a separate compact action toolbar", () => {
    render(<App client={new RuntimeClient()} />);
    for (const label of ["File", "Edit", "View", "Lab", "Simulation", "Tools", "Help"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
    const actions = screen.getByLabelText("Workspace actions");
    for (const label of ["New lab", "Open lab", "Save lab", "Undo", "Redo", "Select tool", "Add link", "Delete selected", "Zoom in", "Zoom out", "Fit topology", "Run until idle", "Advance one step"]) {
      expect(within(actions).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("keeps topology editing distinct from Realtime and Simulation execution modes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const edit = screen.getByRole("button", { name: "Edit Topology" });
    const realtime = screen.getByRole("button", { name: "Realtime" });
    const simulation = screen.getByRole("button", { name: "Simulation" });
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    expect(realtime.getAttribute("aria-pressed")).toBe("true");
    expect(realtime.getAttribute("title")).toContain("automatically");
    expect(simulation.getAttribute("title")).toContain("virtual time");
    await userEvent.click(simulation);
    expect(useWorkspaceStore.getState().executionMode).toBe("simulation");
    expect(simulation.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(edit);
    expect(useWorkspaceStore.getState().mode).toBe("edit");
    expect(useWorkspaceStore.getState().executionMode).toBe("simulation");
  });

  it("offers network, end-device and connection sub-palettes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    for (const label of ["Router", "L2 Switch", "L3 Switch", "Hub", "Bridge"]) {
      expect(screen.getByRole("button", { name: `Add ${label}` })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    expect(screen.getByRole("button", { name: "Add PC" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Server" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByRole("button", { name: "Automatic Ethernet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ethernet Link" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Link" })).toBeTruthy();
  });

  it("supports drag data for palette models", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByRole("button", { name: "Add Router" }), {
      dataTransfer: { effectAllowed: "none", setData },
    });
    expect(setData).toHaveBeenCalledWith("application/x-simulator-device", "router");
  });

  it("opens profile-specific Router and PC windows on double click", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Select R1" }));
    let dialog = await screen.findByRole("dialog", { name: "R1 device window" });
    for (const tab of ["Overview", "Config", "CLI", "Interfaces", "Attributes"]) {
      expect(within(dialog).getByRole("tab", { name: tab })).toBeTruthy();
    }
    await userEvent.click(within(dialog).getByRole("button", { name: "Close device window" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Select PC1" }));
    dialog = await screen.findByRole("dialog", { name: "PC1 device window" });
    for (const tab of ["Desktop", "Config", "Terminal", "Attributes"]) {
      expect(within(dialog).getByRole("tab", { name: tab })).toBeTruthy();
    }
    for (const tool of ["IP Configuration", "Command Prompt", "Web Browser", "TFTP Client", "NTP Client", "Syslog Tool", "Transport Viewer"]) {
      expect(within(dialog).getByRole("button", { name: tool })).toBeTruthy();
    }
  });

  it("renders the shared DeviceIcon across topology nodes, device windows and the palette", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(screen.getByRole("button", { name: "Select PC1" }).querySelector("svg[data-device-type='pc']")).toBeTruthy();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Select R1" }));
    const router = await screen.findByRole("dialog", { name: "R1 device window" });
    expect(router.querySelector("svg[data-device-type='router']")).toBeTruthy();
    await userEvent.click(within(router).getByRole("button", { name: "Close device window" }));
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    expect(screen.getByRole("button", { name: "Add Router" }).querySelector("svg[data-device-type='router']")).toBeTruthy();
  });

  it("opens the Server window with Services and Desktop tabs", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Select SRV1" }));
    const dialog = await screen.findByRole("dialog", { name: "SRV1 device window" });
    for (const tab of ["Config", "Services", "Desktop", "Terminal", "Attributes"]) {
      expect(within(dialog).getByRole("tab", { name: tab })).toBeTruthy();
    }
  });

  it("renders the topology graph without any third-party watermark", async () => {
    await loadDemo(new RuntimeClient());
    expect(screen.getByTestId("topology-graph")).toBeTruthy();
    expect(document.querySelector(".x6-graph-watermark")).toBeNull();
  });

  it("keeps the theme selector exclusively under View > Theme", async () => {
    render(<App client={new RuntimeClient()} />);
    expect(screen.queryByLabelText("Color theme")).toBeNull();
    expect(document.querySelector(".theme-control")).toBeNull();
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Theme" }));
    for (const label of ["System", "Dark", "Light"]) {
      expect(screen.getByRole("menuitemradio", { name: label })).toBeTruthy();
    }
  });

  it("routes compact toolbar zoom controls through the topology graph", async () => {
    await loadDemo(new RuntimeClient());
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(graphHarness.zoomIn).toHaveBeenCalled();
    expect(graphHarness.zoomOut).toHaveBeenCalled();
  });

  it("starts with the inspector closed at the 1280-wide desktop breakpoint", async () => {
    narrowViewport = true;
    await loadDemo(new RuntimeClient());
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(false);
    expect(document.querySelector(".inspector-panel")).toBeNull();
    await openMenu("View");
    expect(screen.getByRole("menuitem", { name: "Show Inspector" })).toBeTruthy();
  });

  it("marks the dock and terminal as bounded overflow regions", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(screen.getByLabelText("Workspace bottom panel").getAttribute("data-overflow-boundary")).toBe("hidden");
    await openDeviceTerminal("Select PC1");
    expect(document.querySelector(".terminal-workspace")?.getAttribute("data-overflow-boundary")).toBe("hidden");
    expect(screen.getByLabelText("PC1 terminal").getAttribute("data-scroll-owner")).toBe("xterm");
  });
});

describe("M8.3 desktop menus and terminal", () => {
  it("removes the separate terminal command form — xterm is the only CLI input", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    expect(document.querySelector(".terminal-command")).toBeNull();
    expect(document.querySelector(".terminal-session form")).toBeNull();
    expect(screen.queryByLabelText("CLI command")).toBeNull();
  });

  it("executes a command typed directly into xterm", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "ping 192.168.20.10");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(screen.getByTestId("terminal-transcript").textContent).toContain("Success rate is 100 percent"));
  });

  it("supports mid-line cursor editing before submit", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    // Type a wrong last octet then repair it with ArrowLeft + Backspace.
    await type(terminal, "ping 192.168.20.100");
    await act(async () => { terminal.emit("\x1b[D"); terminal.emit("\x7f"); terminal.emit("\r"); });
    await waitFor(() => expect(screen.getByTestId("terminal-transcript").textContent).toContain("Success rate is 100 percent"));
    expect(screen.getByTestId("terminal-transcript").textContent).not.toContain("192.168.20.100");
  });

  it("returns a fresh prompt on an empty Enter without an error", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    const before = client.requestTypes.filter((type) => type === "EXECUTE_CLI").length;
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(client.requestTypes.filter((type) => type === "EXECUTE_CLI").length).toBeGreaterThan(before));
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("Ctrl+L clears the viewport idempotently and keeps the session open", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "arp");
    await act(async () => {
      terminal.emit("\x0c");
      terminal.emit("\x0c");
      terminal.emit("\x0c");
      terminal.emit("\x0c");
    });
    expect(terminal.clears).toBeGreaterThanOrEqual(4);
    expect(terminal.output.match(/C:\\>/g)).toHaveLength(1);
    expect(client.requestTypes).not.toContain("CLOSE_CLI_SESSION");
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);
  });

  it("keeps command history isolated per terminal session", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const pc = await openDeviceTerminal("Select PC1");
    await type(pc, "arp");
    await act(async () => { pc.emit("\r"); });
    const sw = await openDeviceTerminal("Select SW1");
    sw.output = "";
    await act(async () => { sw.emit("\x1b[A"); }); // ArrowUp on the fresh session
    expect(sw.output).not.toContain("arp");
  });

  it("opens the File menu on click", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await openMenu("File");
    expect(screen.getByRole("menuitem", { name: /New Lab/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Save \/ Export Lab/ })).toBeTruthy();
  });

  it("triggers Import from the File menu", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const input = document.getElementById("load-lab-file") as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: /Open \/ Import Lab/ }));
    expect(clickSpy).toHaveBeenCalled();
  });

  it("exports the lab from the File menu", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: /Save \/ Export Lab/ }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
  });

  it("toggles the Inspector from the View menu", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(true);
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide Inspector" }));
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(false);
  });

  it("changes the theme through the View menu submenu", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Theme" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("switches to Edit mode through the Lab menu", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Lab");
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Edit Topology" }));
    await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("edit"));
  });

  it("disables Apply & Rebuild when there are no pending changes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Lab");
    expect((screen.getByRole("menuitem", { name: "Apply & Rebuild" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs Run Until Idle from the Simulation menu", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Simulation");
    await userEvent.click(screen.getByRole("menuitem", { name: /Run Until Idle/ }));
    expect(client.requestTypes).toContain("RUN_UNTIL_IDLE");
  });

  it("navigates dropdown items with the keyboard", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const file = screen.getByRole("menuitem", { name: "File" });
    file.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /New Lab/ }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: /Open \/ Import Lab/ }));
  });

  it("closes a menu with Escape and restores trigger focus", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const file = screen.getByRole("menuitem", { name: "File" });
    await userEvent.click(file);
    expect(screen.getByRole("menuitem", { name: /New Lab/ })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: /New Lab/ })).toBeNull();
    expect(document.activeElement).toBe(file);
  });

  it("shows the desktop scope label for a local anonymous lab", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    expect(within(screen.getByLabelText("Active laboratory")).getByText("Local Lab")).toBeTruthy();
  });
});

describe("M10.1 expanded device palette", () => {
  it("offers all device profiles and creates a Hub with stable interfaces", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: "New Lab" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    for (const label of ["Hub", "Bridge", "L2 Switch", "L3 Switch", "Router"]) {
      expect(screen.getByRole("button", { name: `Add ${label}` })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    for (const label of ["PC", "Server"]) expect(screen.getByRole("button", { name: `Add ${label}` })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Network Devices" }));
    await placeDevice("Hub");
    const hub = useWorkspaceStore.getState().draft?.topology.nodes.find((node) => node.kind === "hub");
    expect(hub).toMatchObject({ id: "hub-1", name: "HUB1" });
    expect(hub?.interfaces.map((iface) => iface.id)).toEqual(["Eth0/1", "Eth0/2", "Eth0/3", "Eth0/4", "Eth0/5", "Eth0/6", "Eth0/7", "Eth0/8"]);
  });

  it("selects and loads each focused M10 demo", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const demos = [
      [HUB_ETHERNET_DEMO, "Hub Ethernet Basics"],
      [BRIDGE_MAC_DEMO, "Bridge MAC Learning"],
      [L3_SWITCH_DEMO, "L3 Switch Inter-VLAN Routing"],
      [SERVER_CONNECTIVITY_DEMO, "Server Connectivity"],
    ] as const;
    for (const [document, label] of demos) {
      if (useWorkspaceStore.getState().draft) {
        await openMenu("File");
        await userEvent.click(screen.getByRole("menuitem", { name: "Load Demo Lab" }));
      } else {
        await userEvent.click(screen.getByRole("button", { name: /^Load Demo Lab$/ }));
      }
      await userEvent.click(screen.getByRole("button", { name: new RegExp(label) }));
      await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe(document.id));
    }
  });

  it("hides unsupported Hub CLI actions and shows capability-specific counters", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: /^Load Demo Lab$/ }));
    await userEvent.click(screen.getByRole("button", { name: /Hub Ethernet Basics/ }));
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Select HUB1" }));
    expect(screen.queryByRole("menuitem", { name: /Open CLI/ })).toBeNull();
    await userEvent.click(screen.getByRole("menuitem", { name: /Inspect/ }));
    await userEvent.click(screen.getByRole("tab", { name: "Runtime" }));
    expect(await screen.findByText("Repeater counters")).toBeTruthy();
  });

  it("shows L3 Switch SVIs and real Server transport runtime", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: /^Load Demo Lab$/ }));
    await userEvent.click(screen.getByRole("button", { name: /L3 Switch Inter-VLAN Routing/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Select DSW1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Runtime" }));
    expect(await screen.findByText("SVIs")).toBeTruthy();
    expect(screen.getByText("Enabled")).toBeTruthy();

    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: "Load Demo Lab" }));
    await userEvent.click(screen.getByRole("button", { name: /Server Connectivity/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Runtime" }));
    expect(await screen.findByText("Application services")).toBeTruthy();
    expect(screen.getByText("UDP sockets")).toBeTruthy();
  });
});

async function loadFocusedDemo(client: RuntimeClient, label: RegExp, expectedId: string) {
  render(<App client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: /^Load Demo Lab$/ }));
  await userEvent.click(screen.getByRole("button", { name: label }));
  await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe(expectedId));
}

async function submitTerminal(terminal: MockXterm, command: string) {
  await type(terminal, command);
  await act(async () => terminal.emit("\r"));
}

describe("M10.2 transport and server applications", () => {
  it("offers the three focused service demos without auto-loading them", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: /^Load Demo Lab$/ }));
    expect(screen.getByRole("button", { name: /DNS \+ Web Services/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /TFTP Configuration Backup/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /NTP \+ Syslog Operations/ })).toBeTruthy();
    expect(useWorkspaceStore.getState().snapshot).toBeUndefined();
  });

  it("shows compact listening service badges on a Server node", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    expect(await screen.findByLabelText("Enabled services: DNS, HTTP")).toBeTruthy();
  });

  it("renders DNS, HTTP, TFTP, NTP, and Syslog configuration sections", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const services = await screen.findByLabelText("Server services");
    for (const type of ["dns", "http", "tftp", "ntp", "syslog"]) {
      expect(services.querySelector(`[data-service-type="${type}"]`)).toBeTruthy();
    }
  });

  it("applies edited DNS records through the typed worker boundary", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    fireEvent.change(await screen.findByLabelText("DNS records"), { target: { value: "portal.lab 172.20.10.10\napi.lab 172.20.10.10" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply DNS" }));
    await waitFor(() => expect(client.requestTypes).toContain("CONFIGURE_SERVER_SERVICE"));
    expect((screen.getByLabelText("DNS records") as HTMLTextAreaElement).value).toContain("api.lab");
  });

  it("disables and re-enables HTTP through explicit worker requests", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const enabled = await screen.findByLabelText("http enabled");
    await userEvent.click(enabled);
    await waitFor(() => expect(client.requestTypes).toContain("DISABLE_SERVER_SERVICE"));
    await userEvent.click(screen.getByLabelText("http enabled"));
    await waitFor(() => expect(client.requestTypes).toContain("ENABLE_SERVER_SERVICE"));
  });

  it("shows service validation failures as workspace problems", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    fireEvent.change(await screen.findByLabelText("dns port"), { target: { value: "70000" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply DNS" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/less than or equal to 65535/i);
  });

  it("inspects UDP sockets and TCP listeners separately", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Runtime" }));
    expect(await screen.findByText("UDP sockets")).toBeTruthy();
    expect(screen.getByText("TCP connections")).toBeTruthy();
    expect(screen.getAllByText("dns").length).toBeGreaterThan(0);
    expect(screen.getAllByText("LISTEN").length).toBeGreaterThan(0);
  });

  it("inspects PC resolver, runtime files, and virtual clock", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /TFTP Configuration Backup/, TFTP_BACKUP_DEMO.id);
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Runtime" }));
    expect(await screen.findByText("DNS resolver")).toBeTruthy();
    expect(screen.getByText("Downloaded files")).toBeTruthy();
    expect(screen.getByText("Clock")).toBeTruthy();
  });

  it("executes nslookup end-to-end in the PC terminal", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "nslookup portal.lab");
    await waitFor(() => expect(terminal.output).toContain("Address: 172.20.10.10"));
  });

  it("executes an HTTP GET over TCP in the PC terminal", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "sim http get http://172.20.10.10/");
    await waitFor(() => expect(terminal.output).toContain("HTTP/1.1 200"));
    expect(terminal.output).toContain("Welcome to SimulatorNet");
  });

  it("downloads a TFTP backup through the terminal", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /TFTP Configuration Backup/, TFTP_BACKUP_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "sim tftp get 172.20.10.10 branch-r1.cfg");
    await waitFor(() => expect(terminal.output).toContain("Received"));
    expect(terminal.output).toContain("branch-r1.cfg");
  });

  it("queries NTP and sends Syslog through the terminal", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /NTP \+ Syslog Operations/, NTP_SYSLOG_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "sim ntp query 172.20.10.10");
    await waitFor(() => expect(terminal.output).toContain("NTP server time"));
    await submitTerminal(terminal, "sim syslog send 172.20.10.10 warning uplink changed");
    await waitFor(() => expect(terminal.output).toContain("message sent"));
  });

  it("filters packet trace by application and transport protocols", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /DNS \+ Web Services/, DNS_WEB_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "nslookup portal.lab");
    await waitFor(() => expect(terminal.output).toContain("Address:"));
    await userEvent.click(screen.getByRole("tab", { name: /Packet trace/ }));
    const filter = await screen.findByLabelText("Packet trace protocol filter");
    await userEvent.selectOptions(filter, "DNS");
    expect(screen.getAllByText(/dns-/i).length).toBeGreaterThan(0);
  });

  it("clears Syslog runtime without removing service configuration", async () => {
    const client = new RuntimeClient();
    await loadFocusedDemo(client, /NTP \+ Syslog Operations/, NTP_SYSLOG_DEMO.id);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "sim syslog send 172.20.10.10 notice ready");
    await waitFor(() => expect(terminal.output).toContain("message sent"));
    await userEvent.click(screen.getByRole("button", { name: "Select SRV1" }));
    await userEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    expect(await screen.findByText("ready")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("No received messages.")).toBeTruthy();
    expect((screen.getByLabelText("syslog enabled") as HTMLInputElement).checked).toBe(true);
  });
});
