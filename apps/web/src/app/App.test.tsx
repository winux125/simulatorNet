// @vitest-environment jsdom

import type {
  SimWorkerEvent,
  SimWorkerPayloadByType,
  SimWorkerRequest,
  SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { createSimulationWorkerRuntime } from "@sim/sim-worker";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
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
import {
  WORKSPACE_BOTTOM_PANEL_ID,
  WORKSPACE_BOTTOM_SEPARATOR_ID,
  WORKSPACE_PANEL_GROUP_ID,
} from "../features/layout/workspace-panel-layout";
import { App } from "./App";
import type { SimulatorClient } from "./simulator-client";

interface MockXterm {
  output: string;
  clears: number;
  focused: number;
  disposed: boolean;
  selection: string;
  selectAllCalls: number;
  dataHandler?: (data: string) => void;
  emit(data: string): void;
}

const xtermHarness = vi.hoisted(() => ({ instances: [] as MockXterm[] }));
const fitHarness = vi.hoisted(() => ({ calls: 0 }));
const graphHarness = vi.hoisted(() => ({
  fit: vi.fn(),
  zoomIn: vi.fn(),
  zoomOut: vi.fn(),
  connectionIntent: undefined as ((source: string, target: string, sourcePort?: string, targetPort?: string) => void) | undefined,
  nodeMoved: undefined as ((id: string, position: { x: number; y: number }) => void) | undefined,
  panePointerDown: undefined as ((point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }) => void) | undefined,
  panePointerMove: undefined as ((point: { x: number; y: number }) => void) | undefined,
  panePointerUp: undefined as ((point: { x: number; y: number }, modifiers: { shift: boolean; alt: boolean }) => void) | undefined,
  selectAnnotation: undefined as ((id: string, additive: boolean) => void) | undefined,
  resizeAnnotation: undefined as ((id: string, width: number, height: number) => void) | undefined,
  endpointMoved: undefined as ((id: string, endpoint: "start" | "end" | "bend", point: { x: number; y: number }) => void) | undefined,
  editAnnotation: undefined as ((id: string) => void) | undefined,
  editLinkLabel: undefined as ((id: string) => void) | undefined,
  viewportChanged: undefined as ((viewport: { scale: number; translateX: number; translateY: number }) => void) | undefined,
  viewport: { scale: 1, translateX: 0, translateY: 0 },
}));

vi.mock("@xterm/xterm", () => {
  class MockTerminal {
    options = { theme: {} };
    // A real xterm always reports its grid size; the pager threshold depends on it.
    rows = 8;
    output = "";
    clears = 0;
    focused = 0;
    disposed = false;
    selection = "";
    selectAllCalls = 0;
    dataHandler?: (data: string) => void;
    constructor() { xtermHarness.instances.push(this as unknown as MockXterm); }
    loadAddon() {}
    open() {}
    write(chunk: string) { this.output += chunk; }
    clear() { this.clears += 1; this.output = ""; }
    getSelection() { return this.selection; }
    selectAll() { this.selectAllCalls += 1; }
    scrollToBottom() {}
    focus() { this.focused += 1; }
    onData(handler: (data: string) => void) { this.dataHandler = handler; return { dispose: () => { this.dataHandler = undefined; } }; }
    dispose() { this.disposed = true; }
    emit(data: string) { this.dataHandler?.(data); }
  }
  return { Terminal: MockTerminal };
});
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() { fitHarness.calls += 1; } } }));
vi.mock("react-resizable-panels", async () => {
  const React = await import("react");
  return {
    Group: ({
      children,
      className,
      defaultLayout,
      id,
    }: {
      children: React.ReactNode;
      className?: string;
      defaultLayout?: Record<string, number>;
      id?: string;
    }) => React.createElement("div", {
      className,
      "data-group": id,
      "data-testid": id,
      "data-layout": JSON.stringify(defaultLayout),
    }, children),
    Panel: ({ children, id }: { children: React.ReactNode; id?: string }) =>
      React.createElement("div", { id, "data-panel": id }, children),
    Separator: ({ className, id }: { className?: string; id?: string }) =>
      React.createElement("div", { className, id, "data-separator": id }),
    usePanelRef: () => React.useRef(null),
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
      annotations?: Record<string, { selected: boolean }>;
    };
    React.useEffect(() => {
      (props.onReady as ((handle: {
        clientToLocal(p: { x: number; y: number }): { x: number; y: number };
        localToClient(p: { x: number; y: number }): { x: number; y: number };
        getViewport(): { scale: number; translateX: number; translateY: number };
        getEdgeLabelAnchor(id: string, ratio?: number): { x: number; y: number } | undefined;
        fit(): void;
      }) => void) | undefined)?.({
        clientToLocal: ({ x, y }) => ({ x, y }),
        localToClient: ({ x, y }) => ({ x, y }),
        getViewport: () => graphHarness.viewport,
        // jsdom has no SVG geometry; a stable anchor is enough to place the
        // inline label editor in tests.
        getEdgeLabelAnchor: () => ({ x: 120, y: 90 }),
        fit: graphHarness.fit,
      });
    }, []);
    React.useEffect(() => { if ((props.fitRequest as number) > 0) graphHarness.fit(); }, [props.fitRequest]);
    React.useEffect(() => { if ((props.zoomInRequest as number) > 0) graphHarness.zoomIn(); }, [props.zoomInRequest]);
    React.useEffect(() => { if ((props.zoomOutRequest as number) > 0) graphHarness.zoomOut(); }, [props.zoomOutRequest]);
    React.useEffect(() => {
      graphHarness.connectionIntent = props.onConnectionIntent as typeof graphHarness.connectionIntent;
      graphHarness.nodeMoved = props.onNodeMoved as typeof graphHarness.nodeMoved;
      graphHarness.panePointerDown = props.onPanePointerDown as typeof graphHarness.panePointerDown;
      graphHarness.panePointerMove = props.onPanePointerMove as typeof graphHarness.panePointerMove;
      graphHarness.panePointerUp = props.onPanePointerUp as typeof graphHarness.panePointerUp;
      graphHarness.selectAnnotation = props.onSelectAnnotation as typeof graphHarness.selectAnnotation;
      graphHarness.resizeAnnotation = props.onAnnotationResized as typeof graphHarness.resizeAnnotation;
      graphHarness.endpointMoved = props.onAnnotationEndpointMoved as typeof graphHarness.endpointMoved;
      graphHarness.editAnnotation = props.onEditAnnotation as typeof graphHarness.editAnnotation;
      graphHarness.editLinkLabel = props.onEditLinkLabel as typeof graphHarness.editLinkLabel;
      graphHarness.viewportChanged = props.onViewportChanged as typeof graphHarness.viewportChanged;
      return () => {
        graphHarness.connectionIntent = undefined;
        graphHarness.nodeMoved = undefined;
        graphHarness.panePointerDown = undefined;
        graphHarness.panePointerMove = undefined;
        graphHarness.panePointerUp = undefined;
        graphHarness.selectAnnotation = undefined;
        graphHarness.resizeAnnotation = undefined;
        graphHarness.endpointMoved = undefined;
        graphHarness.editAnnotation = undefined;
        graphHarness.editLinkLabel = undefined;
        graphHarness.viewportChanged = undefined;
      };
    }, [props.onConnectionIntent, props.onNodeMoved, props.onPanePointerDown, props.onPanePointerMove, props.onPanePointerUp, props.onSelectAnnotation, props.onAnnotationResized, props.onAnnotationEndpointMoved, props.onEditAnnotation, props.onEditLinkLabel, props.onViewportChanged]);
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
      ...Object.entries(view.annotations ?? {}).map(([id, annotation]) => React.createElement("button", {
        key: `annotation-${id}`,
        type: "button",
        "aria-label": `Select annotation ${id}`,
        "aria-pressed": annotation.selected,
        onClick: (event: React.MouseEvent) => (props.onSelectAnnotation as ((annotationId: string, additive: boolean) => void))(id, event.shiftKey),
      }, id)),
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
let clipboardText = "";
let clipboardReadDenied = false;

beforeEach(() => {
  compactViewport = false;
  narrowViewport = false;
  prefersDark = true;
  clipboardText = "";
  clipboardReadDenied = false;
  xtermHarness.instances.length = 0;
  fitHarness.calls = 0;
  graphHarness.fit.mockClear();
  graphHarness.zoomIn.mockClear();
  graphHarness.zoomOut.mockClear();
  graphHarness.connectionIntent = undefined;
  graphHarness.nodeMoved = undefined;
  useWorkspaceStore.getState().setTerminalPresentationMode("docked");
  useWorkspaceStore.getState().reset();
  window.localStorage.clear();
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
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: vi.fn(async () => undefined),
    readText: vi.fn(async () => {
      if (clipboardReadDenied) throw new Error("Read permission denied");
      return clipboardText;
    }),
  } });
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
    expect(within(picker).getByRole("tab", { name: "Wireless Devices" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "End Devices" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "Security" })).toBeTruthy();
    expect(within(picker).getByRole("tab", { name: "Infrastructure" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "Add Laptop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Smartphone" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Wireless Devices" }));
    expect(screen.getByRole("button", { name: "Add Access Point" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Wireless Router" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Security" }));
    expect(screen.getByRole("button", { name: "Add Firewall" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Infrastructure" }));
    expect(screen.getByRole("button", { name: "Add Cloud / ISP" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add Traffic Generator" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    expect(useWorkspaceStore.getState().pendingDeviceKind).toBe("pc");
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 300, clientY: 220 });
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(5);
    expect(useWorkspaceStore.getState().pendingDeviceKind).toBeUndefined();
  });

  it("keeps draft-only devices out of worker inspection until Apply Topology", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(screen.getByRole("button", { name: "New Lab" }));
    await placeDevice("Bridge");
    await userEvent.click(screen.getByRole("button", { name: "Select BR1" }));
    expect(await screen.findByText("Pending rebuild")).toBeTruthy();
    expect(screen.getByText("Apply Topology to create this device in the simulation worker.")).toBeTruthy();
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
    expect(screen.getByText("Pending topology changes")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Apply Topology" }).length).toBeGreaterThanOrEqual(1);
  });

  it("executes device context menu actions", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(5);
  });

  it("opens interface selection after a device-to-device drag and creates the connection", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 240, clientY: 220 });
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "Network Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add L2 Switch" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 520, clientY: 260 });

    expect(screen.getByRole("button", { name: "Connect PC1 to another device" })).toBeTruthy();
    act(() => graphHarness.connectionIntent?.("pc-1", "switch-1"));
    let dialog = screen.getByRole("dialog", { name: "Configure connection" });
    expect(within(dialog).getAllByText("PC1")).toHaveLength(2);
    expect(within(dialog).getAllByText("SW1")).toHaveLength(2);
    expect((within(dialog).getByLabelText("Connection type") as HTMLSelectElement).value).toBe("ethernet");
    expect((within(dialog).getByLabelText("From interface") as HTMLSelectElement).value).toBe("eth0");
    expect((within(dialog).getByLabelText("To interface") as HTMLSelectElement).value).toBe("Gi0/1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(useWorkspaceStore.getState().draft?.topology.links).toHaveLength(0);

    act(() => graphHarness.connectionIntent?.("pc-1", "switch-1"));
    dialog = screen.getByRole("dialog", { name: "Configure connection" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    expect(useWorkspaceStore.getState().draft?.topology.links).toEqual([
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
    ]);
    expect(screen.queryByRole("dialog", { name: "Configure connection" })).toBeNull();

    act(() => graphHarness.connectionIntent?.("pc-1", "switch-1"));
    expect(screen.getByText("All interfaces on PC1 are already connected.")).toBeTruthy();
  });

  it("starts a device-first connection from the context menu", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 240, clientY: 220 });
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "Network Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add L2 Switch" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 520, clientY: 260 });

    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Connect…" }));
    expect(screen.getByText("Select the device to connect")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Select SW1" }));
    expect(screen.getByRole("dialog", { name: "Configure connection" })).toBeTruthy();
  });

  it("keeps running links selectable and label-editable while reconnect stays locked", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const linkButton = screen.getAllByRole("button", { name: /^Select link / })[0]!;
    const linkId = linkButton.getAttribute("aria-label")!.replace("Select link ", "");

    fireEvent.contextMenu(linkButton);
    expect((screen.getByRole("menuitem", { name: "Reconnect…" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit link label…" }));
    // The label is edited inline on the canvas, never in a modal window.
    expect(screen.queryByRole("dialog")).toBeNull();
    const labelEditor = await screen.findByRole("textbox", { name: "Editing link label" });
    await userEvent.type(labelEditor, "Campus trunk");
    fireEvent.keyDown(labelEditor, { key: "Enter" });
    expect(useWorkspaceStore.getState().draft?.diagram?.linkLabels)
      .toContainEqual(expect.objectContaining({ linkId, text: "Campus trunk" }));

    fireEvent.contextMenu(linkButton);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Orthogonal route" }));
    expect(useWorkspaceStore.getState().draft?.diagram?.linkStyles)
      .toContainEqual(expect.objectContaining({ linkId, route: "orthogonal" }));
  });

  it("reconnects an existing stopped link without changing its domain ID", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Stop Lab" }));
    const confirmation = screen.queryByRole("dialog", { name: "Stop this lab?" });
    if (confirmation) {
      await userEvent.click(within(confirmation).getByRole("button", { name: "Stop Lab" }));
    }
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));

    const linkButton = screen.getAllByRole("button", { name: /^Select link / })[0]!;
    const linkId = linkButton.getAttribute("aria-label")!.replace("Select link ", "");
    fireEvent.contextMenu(linkButton);
    const reconnect = screen.getByRole("menuitem", { name: "Reconnect…" }) as HTMLButtonElement;
    expect(reconnect.disabled).toBe(false);
    await userEvent.click(reconnect);
    const dialog = screen.getByRole("dialog", { name: "Reconnect link" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Reconnect" }));
    expect(useWorkspaceStore.getState().draft?.topology.links.find((link) => link.id === linkId)?.id).toBe(linkId);
  });

  it("pastes plain text into the topology canvas but not into form fields", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    const canvas = screen.getByRole("region", { name: "Topology canvas" });
    fireEvent.paste(canvas, {
      clipboardData: { items: [], getData: (type: string) => type === "text/plain" ? "Pasted subnet note" : "" },
    });
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations)
      .toContainEqual(expect.objectContaining({ type: "text", content: "Pasted subnet note" }));

    const count = useWorkspaceStore.getState().draft?.diagram?.annotations.length;
    fireEvent.paste(screen.getByLabelText("Text color"), {
      clipboardData: { items: [], getData: () => "Must remain in the field" },
    });
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations).toHaveLength(count!);
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
    for (const label of ["New lab", "Open lab", "Save lab", "Undo", "Redo", "Select tool", "Add link", "Delete selected", "Zoom in", "Zoom out", "Fit topology"]) {
      expect(within(actions).getByRole("button", { name: label })).toBeTruthy();
    }
    expect(within(actions).getByRole("button", { name: /Packet execution mode: Auto/ })).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: "Run until idle" })).toBeNull();
    expect(within(actions).queryByRole("button", { name: "Advance one step" })).toBeNull();
  });

  it("keeps topology editing distinct from Auto and Step execution modes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const edit = screen.getByRole("button", { name: "Edit Topology" });
    expect(edit.getAttribute("aria-pressed")).toBe("false");
    expect(useWorkspaceStore.getState().executionMode).toBe("auto");
    expect(screen.queryByText("Realtime")).toBeNull();
    expect(screen.queryByText("Simulation Mode")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /Packet execution mode: Auto/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Packet Execution" }), "step");
    await waitFor(() => expect(useWorkspaceStore.getState().executionMode).toBe("step"));
    expect(screen.getByRole("dialog", { name: "Step mode" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(window.localStorage.getItem("simulatornet.stepModeExplained")).toBe("true");
    await userEvent.click(edit);
    expect(useWorkspaceStore.getState().mode).toBe("edit");
    expect(useWorkspaceStore.getState().executionMode).toBe("step");
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
    for (const tab of ["Interfaces", "Routing", "ACL", "NAT", "CLI", "Runtime"]) {
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

  it("queues a terminal operation in Step and delivers its final output after Run All", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");

    await userEvent.click(screen.getByRole("button", { name: /Packet execution mode: Auto/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Packet Execution" }), "step");
    await userEvent.click(await screen.findByRole("button", { name: "Got it" }));
    await waitFor(() => expect(useWorkspaceStore.getState().executionMode).toBe("step"));

    act(() => useWorkspaceStore.getState().setDockTab("terminal"));
    await waitFor(() => expect(useWorkspaceStore.getState().dockTab).toBe("terminal"));
    await type(terminal, "ping 192.168.20.10");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("Operation queued in Step mode."));
    expect(terminal.output).toContain("Open Packet Trace and use Step or Run All.");
    expect(useWorkspaceStore.getState().snapshot?.queuedEvents).toBeGreaterThan(0);
    expect(terminal.output).not.toContain("Success rate is 100 percent");

    act(() => useWorkspaceStore.getState().setDockTab("packet-trace"));
    await waitFor(() => expect(useWorkspaceStore.getState().dockTab).toBe("packet-trace"));
    await userEvent.click(screen.getByRole("button", { name: "Step" }));
    expect(client.requestTypes).toContain("STEP_NEXT_EVENT");
    expect(useWorkspaceStore.getState().snapshot?.queuedEvents).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Run All" }));
    await waitFor(() => expect(terminal.output).toContain("Success rate is 100 percent"));
    expect(useWorkspaceStore.getState().snapshot?.queuedEvents).toBe(0);
  });

  it("explains Auto and Step as deterministic virtual-time modes", async () => {
    await loadDemo(new RuntimeClient());
    await openMenu("Help");
    await userEvent.click(screen.getByRole("menuitem", { name: "Packet Execution Modes" }));
    const dialog = screen.getByRole("dialog", { name: "Packet execution modes" });
    expect(within(dialog).getByRole("heading", { name: "Auto" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Step" })).toBeTruthy();
    expect(within(dialog).getByText(/deterministic virtual time/i)).toBeTruthy();
    expect(within(dialog).getByText(/do not use real wall-clock time/i)).toBeTruthy();
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
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(false);
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Show Inspector" }));
    expect(useWorkspaceStore.getState().inspectorOpen).toBe(true);
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

  it("disables Apply Topology when there are no pending changes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Lab");
    expect((screen.getByRole("menuitem", { name: "Apply Topology" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers Auto/Step and deterministic queue controls from the Simulation menu", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Simulation");
    expect(screen.getByRole("menuitem", { name: "Step Next Event" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /^Run All Queued Events/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Clear Event List" })).toBeTruthy();
    await userEvent.click(screen.getByRole("menuitem", { name: "Execution Mode" }));
    expect(screen.getByRole("menuitemradio", { name: "Auto" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Step" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Realtime" })).toBeNull();
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
    for (const label of ["PC", "Server", "Laptop", "Smartphone"]) {
      expect(screen.getByRole("button", { name: `Add ${label}` })).toBeTruthy();
    }
    await userEvent.click(screen.getByRole("tab", { name: "Wireless Devices" }));
    for (const label of ["Access Point", "Wireless Router"]) {
      expect(screen.getByRole("button", { name: `Add ${label}` })).toBeTruthy();
    }
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

describe("M10.2.2c lab power lifecycle and topology lock", () => {
  it("opens a loaded lab running with the topology locked", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(useWorkspaceStore.getState().powerState).toBe("running");
    expect(screen.getByRole("button", { name: "Stop Lab" })).toBeTruthy();
    expect(screen.getByLabelText("Topology connectivity locked")).toBeTruthy();
  });

  it("opens a new lab stopped with the topology unlocked", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));
    expect(screen.getByRole("button", { name: "Start Lab" })).toBeTruthy();
    expect(screen.getByLabelText("Topology connectivity unlocked")).toBeTruthy();
  });

  it("starts a stopped lab into the running state", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));
    await userEvent.click(screen.getByRole("button", { name: "Start Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("running"));
    expect(client.requestTypes).toContain("REBUILD_LAB");
  });

  it("stops a running lab without transient state and unlocks editing", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));
    await userEvent.click(screen.getByRole("button", { name: "Start Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("running"));
    // A freshly started empty lab has no transient runtime, so Stop needs no confirmation.
    await userEvent.click(screen.getByRole("button", { name: "Stop Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));
    expect(useWorkspaceStore.getState().mode).toBe("edit");
    const before = useWorkspaceStore.getState().draft?.topology.nodes.length ?? 0;
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    expect(useWorkspaceStore.getState().draft?.topology.nodes.length).toBe(before + 1);
  });

  it("confirms before stopping a lab that has transient runtime state", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "ping 192.168.20.10");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect((useWorkspaceStore.getState().snapshot?.virtualTime ?? 0)).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole("button", { name: "Stop Lab" }));
    expect(screen.getByRole("dialog", { name: "Stop this lab?" })).toBeTruthy();
    expect(useWorkspaceStore.getState().powerState).toBe("running");
    await userEvent.click(within(screen.getByRole("dialog", { name: "Stop this lab?" })).getByRole("button", { name: "Stop Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("stopped"));
  });

  it("rejects keyboard delete while the lab is running", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    const before = useWorkspaceStore.getState().draft?.topology.nodes.length ?? 0;
    fireEvent.keyDown(window, { key: "Delete" });
    expect(useWorkspaceStore.getState().draft?.topology.nodes.length).toBe(before);
  });

  it("keeps the CLI available while the lab runs and locks the topology", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    expect(await screen.findByLabelText("PC1 CLI")).toBeTruthy();
    expect(useWorkspaceStore.getState().powerState).toBe("running");
  });

  it("exposes Start and Stop in the Lab menu with correct enabled state", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openMenu("Lab");
    expect((screen.getByRole("menuitem", { name: "Start Lab" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Stop Lab" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("rejects a redundant start through the toolbar affordance", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    // Running: the Start control is not offered; only Stop is.
    expect(screen.queryByRole("button", { name: "Start Lab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop Lab" })).toBeTruthy();
  });
});

describe("M10.2.3c change-impact and rebuild semantics", () => {
  it("moves a running device without rebuilding or clearing runtime trace", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await submitTerminal(terminal, "ping 192.168.20.10");
    await waitFor(() => expect(useWorkspaceStore.getState().traces.length).toBeGreaterThan(0));
    const traceCount = useWorkspaceStore.getState().traces.length;
    const rebuildCount = client.requestTypes.filter((type) => type === "REBUILD_LAB").length;

    await act(async () => graphHarness.nodeMoved?.("pc-1", { x: 515, y: 125 }));

    const state = useWorkspaceStore.getState();
    expect(state.draft?.topology.nodes.find((node) => node.id === "pc-1")?.position).toEqual({ x: 515, y: 125 });
    expect(state.powerState).toBe("running");
    expect(state.unsaved).toBe(true);
    expect(state.pendingTopologyChanges).toBe(false);
    expect(state.traces).toHaveLength(traceCount);
    expect(client.requestTypes.filter((type) => type === "REBUILD_LAB")).toHaveLength(rebuildCount);
    expect(screen.queryByText("Pending topology changes")).toBeNull();
  });

  it("allows diagram notes while running but keeps connectivity controls locked", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 280, clientY: 160 });
    const editor = await screen.findByRole("textbox", { name: "Editing topology text" });
    await userEvent.type(editor, "Core note");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(useWorkspaceStore.getState().draft?.diagram?.annotations).toHaveLength(1);
    expect(useWorkspaceStore.getState()).toMatchObject({
      powerState: "running",
      unsaved: true,
      pendingTopologyChanges: false,
    });
    expect(screen.getAllByRole("button", { name: "Add link" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("auto-applies a structural draft when Start Lab is pressed", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Start Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().powerState).toBe("running"));

    expect(screen.queryByRole("dialog", { name: "Apply topology changes?" })).toBeNull();
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(false);
    expect(useWorkspaceStore.getState().snapshot?.nodes.map((node) => node.id)).toContain("pc-1");
  });
});

describe("M10.3.2c unified terminal workspace", () => {
  async function choosePresentation(label: "Dock at Bottom" | "Float" | "Maximize") {
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }));
  }

  it("ignores presentation shortcuts when no laboratory is open", () => {
    render(<App client={new RuntimeClient()} />);
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true });
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, altKey: true });
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalVisible: false,
      terminalPresentationMode: "docked",
      terminalTabs: [],
    });
  });

  it("moves one xterm through Dock, Float and Maximize while preserving input and search", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "ping 192.168.");
    const search = screen.getByLabelText("PC1 terminal search") as HTMLInputElement;
    await userEvent.type(search, "ping");
    const fitsBefore = fitHarness.calls;

    await choosePresentation("Float");
    expect(useWorkspaceStore.getState().terminalPresentationMode).toBe("floating");
    expect(xtermHarness.instances).toHaveLength(1);
    expect(xtermHarness.instances[0]).toBe(terminal);
    expect(search.value).toBe("ping");

    await choosePresentation("Maximize");
    expect(useWorkspaceStore.getState().terminalPresentationMode).toBe("maximized");
    expect(xtermHarness.instances).toHaveLength(1);

    await choosePresentation("Dock at Bottom");
    expect(useWorkspaceStore.getState().terminalPresentationMode).toBe("docked");
    expect(xtermHarness.instances).toHaveLength(1);
    expect(terminal.disposed).toBe(false);
    expect(terminal.output).toContain("ping 192.168.");
    expect(fitHarness.calls).toBeGreaterThan(fitsBefore);
  });

  it("hides the terminal window without closing tabs or the worker session", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Hide Terminal" }));

    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalVisible: false,
      terminalTabs: ["pc-1"],
    });
    expect(terminal.disposed).toBe(false);
    expect(client.requestTypes).not.toContain("CLOSE_CLI_SESSION");

    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /^Show Terminal/ }));
    expect(useWorkspaceStore.getState().terminalVisible).toBe(true);
    expect(xtermHarness.instances).toHaveLength(1);
  });

  it("shares multiple tabs, supports keyboard cycling, and closes tabs to the right", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    await openDeviceTerminal("Select SW1");
    expect(xtermHarness.instances).toHaveLength(2);
    expect(useWorkspaceStore.getState().activeTerminalDeviceId).toBe("switch-1");

    fireEvent.keyDown(screen.getByLabelText("SW1 terminal"), { key: "PageUp", ctrlKey: true });
    expect(useWorkspaceStore.getState().activeTerminalDeviceId).toBe("pc-1");

    const pcTab = screen.getByRole("tab", { name: /PC1 terminal/ });
    fireEvent.contextMenu(pcTab, { clientX: 40, clientY: 40 });
    await userEvent.click(screen.getByRole("menuitem", { name: "Close Tabs to the Right" }));
    expect(useWorkspaceStore.getState()).toMatchObject({
      terminalTabs: ["pc-1"],
      activeTerminalDeviceId: "pc-1",
    });
    await waitFor(() => expect(xtermHarness.instances[1]?.disposed).toBe(true));
    expect(xtermHarness.instances[0]?.disposed).toBe(false);
  });

  it("uses Device Window as a launcher instead of mounting another xterm", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    expect(xtermHarness.instances).toHaveLength(1);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Select PC1" }));
    const dialog = await screen.findByRole("dialog", { name: "PC1 device window" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Terminal" }));
    expect(within(dialog).getByRole("button", { name: "Open in Terminal Workspace" })).toBeTruthy();
    expect(within(dialog).queryByLabelText("PC1 terminal")).toBeNull();
    expect(xtermHarness.instances).toHaveLength(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Open in Terminal Workspace" }));
    expect(screen.queryByRole("dialog", { name: "PC1 device window" })).toBeNull();
    expect(xtermHarness.instances).toHaveLength(1);
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);
  });

  it("restores a maximized terminal with Escape without closing its session", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await choosePresentation("Float");
    await choosePresentation("Maximize");

    fireEvent.keyDown(screen.getByLabelText("PC1 terminal"), { key: "Escape" });
    expect(useWorkspaceStore.getState().terminalPresentationMode).toBe("floating");
    expect(terminal.disposed).toBe(false);
  });

  it("only intercepts Ctrl/Cmd+W while focus is inside the terminal", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select PC1");
    fireEvent.keyDown(window, { key: "w", ctrlKey: true });
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);

    fireEvent.keyDown(screen.getByLabelText("PC1 terminal"), { key: "w", ctrlKey: true });
    expect(useWorkspaceStore.getState().terminalTabs).toEqual([]);
  });

  it("keeps terminal instances across theme and device icon profile changes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await chooseTheme("Light");
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Device Icon Style" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Minimal Network" }));
    expect(xtermHarness.instances).toHaveLength(1);
    expect(xtermHarness.instances[0]).toBe(terminal);
    expect(terminal.disposed).toBe(false);
  });
});

describe("M10.3.2d professional diagram workspace", () => {
  async function openEmptyLab() {
    render(<App client={new RuntimeClient()} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
  }

  it("exposes one explicit Select, Hand, drawing, Image, and Connection toolbar", async () => {
    await openEmptyLab();
    const toolbar = screen.getByRole("toolbar", { name: "Diagram tools" });
    for (const name of ["Select", "Hand", "Text", "Rectangle", "Ellipse", "Line", "Arrow", "Image", "Connection"]) {
      expect(within(toolbar).getByRole("button", { name })).toBeTruthy();
    }
    await userEvent.click(within(toolbar).getByRole("button", { name: "Hand" }));
    expect(within(toolbar).getByRole("button", { name: "Hand" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("creates a rectangle by drag and returns to Select", async () => {
    await openEmptyLab();
    await userEvent.click(screen.getByRole("button", { name: "Rectangle" }));
    await act(async () => { graphHarness.panePointerDown?.({ x: 100, y: 120 }, { shift: false, alt: false }); });
    await act(async () => { graphHarness.panePointerMove?.({ x: 280, y: 220 }); });
    await act(async () => { graphHarness.panePointerUp?.({ x: 280, y: 220 }, { shift: false, alt: false }); });
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations[0]).toMatchObject({
      type: "rectangle",
      position: { x: 100, y: 120 },
      width: 180,
      height: 100,
    });
    expect(screen.getByRole("button", { name: "Select" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("opens immediate multiline text editing and persists plain text", async () => {
    await openEmptyLab();
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 160, clientY: 180 });
    const editor = await screen.findByRole("textbox", { name: "Editing topology text" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.type(editor, "Loopback 10.0.0.1{enter}Management");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations[0]).toMatchObject({
      type: "text",
      content: "Loopback 10.0.0.1\nManagement",
    });
  });

  it("supports Shift multi-selection, alignment, duplication, and deletion", async () => {
    await openEmptyLab();
    for (const [start, end] of [
      [{ x: 20, y: 20 }, { x: 120, y: 80 }],
      [{ x: 200, y: 80 }, { x: 300, y: 140 }],
    ] as const) {
      await userEvent.click(screen.getByRole("button", { name: "Rectangle" }));
      await act(async () => { graphHarness.panePointerDown?.(start, { shift: false, alt: false }); });
      await act(async () => { graphHarness.panePointerUp?.(end, { shift: false, alt: false }); });
    }
    await act(async () => { graphHarness.selectAnnotation?.("annotation-1", false); });
    await act(async () => { graphHarness.selectAnnotation?.("annotation-2", true); });
    await userEvent.click(screen.getByRole("button", { name: "Align left edges" }));
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations.map((annotation) =>
      "position" in annotation ? annotation.position.x : 0)).toEqual([20, 20]);
    await userEvent.click(screen.getByRole("button", { name: "Duplicate annotation" }));
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations).toHaveLength(4);
    await userEvent.click(screen.getByRole("button", { name: "Delete annotation" }));
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations).toHaveLength(2);
  });

  it("persists local snapping preferences without mutating the LabDocument", async () => {
    await openEmptyLab();
    const before = JSON.stringify(useWorkspaceStore.getState().draft);
    await userEvent.click(screen.getByRole("checkbox", { name: "Grid snap" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Guides" }));
    expect(window.localStorage.getItem("simulatornet.diagram.snapToGrid")).toBe("false");
    expect(window.localStorage.getItem("simulatornet.diagram.smartGuides")).toBe("false");
    expect(JSON.stringify(useWorkspaceStore.getState().draft)).toBe(before);
  });
});

describe("M10.3.3c cable-only connection presentation", () => {
  const cableHandle = (hostname: string) => screen.queryByRole("button", { name: `Connect ${hostname} to another device` });

  async function stoppedLabWithTwoDevices() {
    render(<App client={new RuntimeClient()} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "Network Devices" }));
    await userEvent.click(screen.getByRole("button", { name: "Add L2 Switch" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 520, clientY: 260 });
  }

  function deviceIds(): [string, string] {
    const nodes = useWorkspaceStore.getState().draft?.topology.nodes ?? [];
    return [nodes[0]!.id, nodes[1]!.id];
  }

  it("1. shows exactly one cable handle per device and no port controls", async () => {
    await stoppedLabWithTwoDevices();
    expect(screen.getAllByRole("button", { name: /to another device$/ })).toHaveLength(2);
    expect(cableHandle("PC1")).toBeTruthy();
    expect(cableHandle("PC1")?.getAttribute("title")).toBe("Connect");
    expect(cableHandle("PC1")?.getAttribute("data-connection-handle")).toBe("true");
    // No per-interface control is offered anywhere on a device.
    expect(screen.queryByRole("button", { name: /^Connect .* eth0/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Connect .* Gi0/ })).toBeNull();
  });

  it("2. hides the cable handle in Hand/Pan mode and while drawing annotations", async () => {
    await stoppedLabWithTwoDevices();
    await userEvent.click(screen.getByRole("button", { name: "Hand" }));
    expect(cableHandle("PC1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Rectangle" }));
    expect(cableHandle("PC1")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(cableHandle("PC1")).toBeTruthy();
  });

  it("3. hides the cable handle while inline text editing is open", async () => {
    await stoppedLabWithTwoDevices();
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: 200, clientY: 160 });
    const editor = await screen.findByRole("textbox", { name: "Editing topology text" });
    expect(cableHandle("PC1")).toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(cableHandle("PC1")).toBeTruthy());
  });

  it("4. removes the cable handle while the lab is running and restores it after Stop", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(useWorkspaceStore.getState().powerState).toBe("running");
    expect(cableHandle("PC1")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Add link" }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Stop Lab" }));
    const confirmation = screen.queryByRole("dialog", { name: "Stop this lab?" });
    if (confirmation) await userEvent.click(within(confirmation).getByRole("button", { name: "Stop Lab" }));
    await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("edit"));
    await waitFor(() => expect(cableHandle("PC1")).toBeTruthy());
  });

  it("5. opens the interface modal from the cable handle and creates one exact link", async () => {
    await stoppedLabWithTwoDevices();
    const [pcId, switchId] = deviceIds();
    await act(async () => { graphHarness.connectionIntent?.(pcId, switchId); });
    const dialog = await screen.findByRole("dialog", { name: "Configure connection" });
    expect(within(dialog).getByLabelText("From interface")).toBeTruthy();
    expect(within(dialog).getByLabelText("To interface")).toBeTruthy();
    await userEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(useWorkspaceStore.getState().draft?.topology.links).toEqual([
      { id: "link-1", a: { node: pcId, iface: "eth0" }, b: { node: switchId, iface: "Gi0/1" } },
    ]);
  });

  it("6. disables Connect and explains why when a device has no free interface", async () => {
    await stoppedLabWithTwoDevices();
    const [pcId, switchId] = deviceIds();
    await act(async () => { graphHarness.connectionIntent?.(pcId, switchId); });
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Configure connection" }))
      .getByRole("button", { name: "Connect" }));
    expect(useWorkspaceStore.getState().draft?.topology.links).toHaveLength(1);

    // PC1's single interface is now occupied.
    await act(async () => { graphHarness.connectionIntent?.(pcId, switchId); });
    const dialog = await screen.findByRole("dialog", { name: "Configure connection" });
    expect(dialog.textContent).toContain("All interfaces on PC1 are already connected.");
    expect((within(dialog).getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("From interface") as HTMLSelectElement).disabled).toBe(true);
  });

  it("7. creates no link when the interface modal is cancelled", async () => {
    await stoppedLabWithTwoDevices();
    const [pcId, switchId] = deviceIds();
    await act(async () => { graphHarness.connectionIntent?.(pcId, switchId); });
    const dialog = await screen.findByRole("dialog", { name: "Configure connection" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(useWorkspaceStore.getState().draft?.topology.links).toEqual([]);
  });
});

describe("M10.3.3b inline diagram text editing", () => {
  const TEXT_EDITOR = { name: "Editing topology text" } as const;

  /** jsdom has no DataTransfer; the editor only ever reads `text/plain`. */
  function clipboardStub(plain: string, html?: string) {
    return {
      getData: (type: string) => type === "text/plain" ? plain : type === "text/html" ? html ?? "" : "",
      types: html ? ["text/plain", "text/html"] : ["text/plain"],
      items: [],
      files: [],
    };
  }

  async function openEmptyLab() {
    render(<App client={new RuntimeClient()} />);
    await userEvent.click(await screen.findByRole("button", { name: "New Lab" }));
  }

  async function createTextAt(x = 160, y = 180) {
    await userEvent.click(screen.getByRole("button", { name: "Text" }));
    fireEvent.click(screen.getByTestId("topology-graph"), { clientX: x, clientY: y });
    return screen.findByRole("textbox", TEXT_EDITOR) as Promise<HTMLTextAreaElement>;
  }

  async function createCommittedText(content: string) {
    const editor = await createTextAt();
    await userEvent.type(editor, content);
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole("textbox", TEXT_EDITOR)).toBeNull());
  }

  function annotations() {
    return useWorkspaceStore.getState().draft?.diagram?.annotations ?? [];
  }

  it("1. opens an inline editor on the canvas, never a modal dialog", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor.closest(".dialog-backdrop")).toBeNull();
    expect(editor.closest(".topology-panel")).toBeTruthy();
    expect(editor.closest("[role='dialog']")).toBeNull();
  });

  it("2. gives the inline editor focus immediately", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    await waitFor(() => expect(window.document.activeElement).toBe(editor));
  });

  it("3. accepts multiline Enter and commits with Ctrl+Enter", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    await userEvent.type(editor, "Core{enter}Distribution{enter}Access");
    expect(editor.value).toBe("Core\nDistribution\nAccess");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(annotations()[0]).toMatchObject({ type: "text", content: "Core\nDistribution\nAccess" });
  });

  it("4. opens existing text on double-click with the text selected", async () => {
    await openEmptyLab();
    await createCommittedText("Campus core");
    await act(async () => { graphHarness.editAnnotation?.("annotation-1"); });
    const editor = await screen.findByRole("textbox", TEXT_EDITOR) as HTMLTextAreaElement;
    expect(editor.value).toBe("Campus core");
    await waitFor(() => expect(editor.selectionStart).toBe(0));
    expect(editor.selectionEnd).toBe("Campus core".length);
  });

  it("5. cancels an edit with Escape and restores the previous text", async () => {
    await openEmptyLab();
    await createCommittedText("Original");
    await act(async () => { graphHarness.editAnnotation?.("annotation-1"); });
    const editor = await screen.findByRole("textbox", TEXT_EDITOR);
    await userEvent.clear(editor);
    await userEvent.type(editor, "Discarded");
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", TEXT_EDITOR)).toBeNull());
    expect(annotations()[0]).toMatchObject({ content: "Original" });
  });

  it("6. removes a new empty annotation and leaves no history entry", async () => {
    await openEmptyLab();
    const historyBefore = useWorkspaceStore.getState().past.length;
    const editor = await createTextAt();
    fireEvent.keyDown(editor, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox", TEXT_EDITOR)).toBeNull());
    expect(annotations()).toHaveLength(0);
    expect(useWorkspaceStore.getState().past.length).toBe(historyBefore);

    const blurred = await createTextAt();
    fireEvent.blur(blurred);
    await waitFor(() => expect(screen.queryByRole("textbox", TEXT_EDITOR)).toBeNull());
    expect(annotations()).toHaveLength(0);
    expect(useWorkspaceStore.getState().past.length).toBe(historyBefore);
  });

  it("7. commits on blur and keeps an existing annotation that became empty", async () => {
    await openEmptyLab();
    await createCommittedText("Blur commit");
    await act(async () => { graphHarness.editAnnotation?.("annotation-1"); });
    const editor = await screen.findByRole("textbox", TEXT_EDITOR);
    await userEvent.clear(editor);
    fireEvent.blur(editor);
    await waitFor(() => expect(screen.queryByRole("textbox", TEXT_EDITOR)).toBeNull());
    expect(annotations()).toHaveLength(1);
    expect(annotations()[0]).toMatchObject({ type: "text", content: "" });
  });

  it("8. treats one edit session as a single undo step", async () => {
    await openEmptyLab();
    await createCommittedText("First version");
    await act(async () => { graphHarness.editAnnotation?.("annotation-1"); });
    const editor = await screen.findByRole("textbox", TEXT_EDITOR);
    await userEvent.clear(editor);
    await userEvent.type(editor, "Second version");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(annotations()[0]).toMatchObject({ content: "Second version" });

    act(() => useWorkspaceStore.getState().undo());
    expect(annotations()[0]).toMatchObject({ content: "First version" });
    act(() => useWorkspaceStore.getState().redo());
    expect(annotations()[0]).toMatchObject({ content: "Second version" });
    // Creating the text was also exactly one step.
    act(() => useWorkspaceStore.getState().undo());
    act(() => useWorkspaceStore.getState().undo());
    expect(annotations()).toHaveLength(0);
  });

  it("9. pastes plain text only and never clipboard HTML", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    const transfer = clipboardStub("VLAN 10\r\nVLAN 20", "<b onclick='alert(1)'>VLAN 10</b>");
    fireEvent.paste(editor, { clipboardData: transfer });
    await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe("VLAN 10\nVLAN 20"));
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(annotations()[0]).toMatchObject({ content: "VLAN 10\nVLAN 20" });
    expect(JSON.stringify(annotations())).not.toContain("<b");
  });

  it("10. bounds the stored text length", async () => {
    await openEmptyLab();
    const editor = await createTextAt() as HTMLTextAreaElement;
    expect(editor.maxLength).toBe(4_096);
    fireEvent.paste(editor, { clipboardData: clipboardStub("x".repeat(5_000)) });
    await waitFor(() => expect(editor.value.length).toBe(4_096));
  });

  it("11. applies contextual styles without closing the editor", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    await userEvent.type(editor, "Styled note");
    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    await userEvent.click(screen.getByRole("button", { name: "Align right" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Size" }), { target: { value: "24" } });
    // Still inline, still holding the typed text.
    expect((screen.getByRole("textbox", TEXT_EDITOR) as HTMLTextAreaElement).value).toBe("Styled note");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", TEXT_EDITOR), { key: "Enter", ctrlKey: true });
    expect(annotations()[0]).toMatchObject({
      type: "text",
      content: "Styled note",
      bold: true,
      alignment: "right",
      fontSize: 24,
    });
  });

  it("12. grows automatically while typing and stays bounded", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    const overlay = editor.parentElement as HTMLElement;
    const initialHeight = Number.parseFloat(overlay.style.height);
    await userEvent.type(editor, "one{enter}two{enter}three{enter}four");
    const grownHeight = Number.parseFloat(overlay.style.height);
    expect(grownHeight).toBeGreaterThan(initialHeight);
    expect(grownHeight).toBeLessThanOrEqual(2_000);
  });

  it("13. follows the canvas pan and zoom transform while open", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    const overlay = editor.parentElement as HTMLElement;
    const initialFontSize = Number.parseFloat(overlay.querySelector("textarea")!.style.fontSize);
    await act(async () => { graphHarness.viewportChanged?.({ scale: 2, translateX: 40, translateY: 25 }); });
    const zoomedFontSize = Number.parseFloat(overlay.querySelector("textarea")!.style.fontSize);
    expect(zoomedFontSize).toBeCloseTo(initialFontSize * 2, 4);
    expect(Number.parseFloat(overlay.style.width)).toBeGreaterThan(0);
  });

  it("14. ignores global Delete and workspace shortcuts while editing", async () => {
    await openEmptyLab();
    await userEvent.click(screen.getByRole("button", { name: "Add Device" }));
    await userEvent.click(screen.getByRole("tab", { name: "End Devices" }));
    await placeDevice("PC");
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    const editor = await createTextAt();
    await userEvent.type(editor, "Note");
    fireEvent.keyDown(editor, { key: "Delete", bubbles: true });
    fireEvent.keyDown(editor, { key: "f", bubbles: true });
    expect(useWorkspaceStore.getState().draft?.topology.nodes).toHaveLength(1);
    expect((screen.getByRole("textbox", TEXT_EDITOR) as HTMLTextAreaElement).value).toBe("Note");
  });

  it("15. edits text while the lab runs without a rebuild or trace reset", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const traces = useWorkspaceStore.getState().traces.length;
    const requestsBefore = client.requestTypes.length;
    const editor = await createTextAt(300, 200);
    await userEvent.type(editor, "Running note");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    expect(annotations()).toHaveLength(1);
    expect(useWorkspaceStore.getState()).toMatchObject({ powerState: "running", pendingTopologyChanges: false });
    expect(useWorkspaceStore.getState().traces.length).toBe(traces);
    expect(client.requestTypes.slice(requestsBefore)).not.toContain("REBUILD_LAB");
  });

  it("16. edits a diagram line label inline", async () => {
    await openEmptyLab();
    await userEvent.click(screen.getByRole("button", { name: "Line" }));
    await act(async () => { graphHarness.panePointerDown?.({ x: 40, y: 40 }, { shift: false, alt: false }); });
    await act(async () => { graphHarness.panePointerUp?.({ x: 240, y: 120 }, { shift: false, alt: false }); });
    await act(async () => { graphHarness.editAnnotation?.("annotation-1"); });
    const editor = await screen.findByRole("textbox", { name: "Editing diagram line label" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.type(editor, "Uplink");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(annotations()[0]).toMatchObject({ type: "line", label: "Uplink" });
  });

  it("17. removes a link label when the inline editor is emptied", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const linkId = screen.getAllByRole("button", { name: /^Select link / })[0]!
      .getAttribute("aria-label")!.replace("Select link ", "");
    await act(async () => { graphHarness.editLinkLabel?.(linkId); });
    const editor = await screen.findByRole("textbox", { name: "Editing link label" });
    await userEvent.type(editor, "Trunk");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(useWorkspaceStore.getState().draft?.diagram?.linkLabels)
      .toContainEqual(expect.objectContaining({ linkId, text: "Trunk" }));

    await act(async () => { graphHarness.editLinkLabel?.(linkId); });
    const again = await screen.findByRole("textbox", { name: "Editing link label" });
    await userEvent.clear(again);
    fireEvent.keyDown(again, { key: "Enter" });
    expect(useWorkspaceStore.getState().draft?.diagram?.linkLabels ?? [])
      .not.toContainEqual(expect.objectContaining({ linkId }));
    // Connectivity is untouched by a presentation label edit.
    expect(useWorkspaceStore.getState().draft?.topology.links.some((link) => link.id === linkId)).toBe(true);
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(false);
  });

  it("18. keeps exported and re-imported text and styles intact", async () => {
    await openEmptyLab();
    const editor = await createTextAt();
    await userEvent.type(editor, "Exported{enter}note");
    await userEvent.click(screen.getByRole("button", { name: "Italic" }));
    fireEvent.keyDown(screen.getByRole("textbox", TEXT_EDITOR), { key: "Enter", ctrlKey: true });
    const exported = JSON.parse(stringifyLabDocument(
      canonicalizeLabDocument(useWorkspaceStore.getState().draft!),
    )) as { diagram?: { annotations: Array<Record<string, unknown>> } };
    expect(exported.diagram?.annotations[0]).toMatchObject({
      type: "text",
      content: "Exported\nnote",
      italic: true,
    });
  });
});

describe("M10.4.1a native terminal paste", () => {
  /** Dispatch the browser paste event the terminal container listens for. */
  async function paste(hostname: string, text: string) {
    await act(async () => {
      fireEvent.paste(screen.getByLabelText(`${hostname} terminal`), {
        clipboardData: { getData: (type: string) => type === "text/plain" ? text : "" },
      });
    });
    await act(async () => { await Promise.resolve(); });
  }

  async function openContextMenu(hostname: string) {
    fireEvent.contextMenu(screen.getByLabelText(`${hostname} terminal`));
    return screen.findByRole("menu", { name: `${hostname} terminal actions` });
  }

  function executions(client: RuntimeClient): number {
    return client.requestTypes.filter((type) => type === "EXECUTE_CLI").length;
  }

  /** Give R1 a local-user console login plus an enable secret. */
  async function configureConsoleLogin() {
    const { withConsoleAccess } = await import("../features/lab/document");
    const { createPasswordVerifier } = await import("@sim/console-auth");
    const draft = useWorkspaceStore.getState().draft!;
    const [password, secret] = await Promise.all([
      createPasswordVerifier("cisco123", 1_000),
      createPasswordVerifier("enable123", 1_000),
    ]);
    act(() => useWorkspaceStore.getState().applyDraft(withConsoleAccess(draft, "router-1", {
      mode: "local-user",
      users: [{ id: "console-user-1", username: "admin", passwordVerifier: password, privilegeLevel: 1, enabled: true }],
      enableSecretVerifier: secret,
      maximumAttempts: 3,
      credentialResetRequired: false,
    }), "configuration"));
  }

  it("1/4. Ctrl+V inserts a single line at the cursor without executing it", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "ping .10");
    await act(async () => { terminal.emit("\x1b[D"); terminal.emit("\x1b[D"); terminal.emit("\x1b[D"); });
    const before = executions(client);
    terminal.output = "";

    await paste("PC1", "192.168.20");

    expect(terminal.output).toContain("ping 192.168.20.10");
    expect(executions(client)).toBe(before);
    expect(screen.queryByRole("dialog", { name: /Paste/ })).toBeNull();

    // Editing keys and Enter still drive the same buffer after a paste.
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(screen.getByTestId("terminal-transcript").textContent)
      .toContain("Success rate is 100 percent"));
  });

  it("2. Cmd+V reaches the same paste path and never triggers a global shortcut", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    const host = screen.getByLabelText("PC1 terminal");
    const fitBefore = useWorkspaceStore.getState().fitRequest;
    terminal.output = "";

    fireEvent.keyDown(host, { key: "v", metaKey: true });
    await paste("PC1", "ipconfig");

    expect(terminal.output).toContain("ipconfig");
    expect(useWorkspaceStore.getState().fitRequest).toBe(fitBefore);
    expect(useWorkspaceStore.getState().draft?.id).toBe("demo-router-on-a-stick");
  });

  it("3. Shift+Insert pastes through the Clipboard API when no paste event follows", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    clipboardText = "arp -a";
    terminal.output = "";

    fireEvent.keyDown(screen.getByLabelText("PC1 terminal"), { key: "Insert", shiftKey: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });

    expect(terminal.output).toContain("arp -a");
    expect(executions(client)).toBeGreaterThan(0);
  });

  it("5. a single line ending with a newline executes without a confirmation", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    terminal.output = "";

    await paste("PC1", "ipconfig\n");

    expect(screen.queryByRole("dialog", { name: /Paste/ })).toBeNull();
    await waitFor(() => expect(terminal.output).toContain("IPv4 Address"));
  });

  it("6/7. a multi-line paste asks first, and Cancel changes nothing", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select SW1");
    const before = executions(client);

    await paste("SW1", "enable\nconfigure terminal\nvlan 30\nname Guest\nend\nshow vlan brief\n");

    const dialog = await screen.findByRole("dialog", { name: "Paste 6 commands into SW1" });
    // A compact popover over the terminal, not a generic workspace modal.
    expect(document.querySelector(".dialog-backdrop")).toBeNull();
    expect(within(dialog).getByText("configure terminal", { exact: false })).toBeTruthy();
    expect(executions(client)).toBe(before);

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: /Paste/ })).toBeNull();
    expect(executions(client)).toBe(before);
    expect(terminal.output).not.toContain("SW1(config)#");
  });

  it("8/9/10/14. confirming runs the lines in order, changing modes and history", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select SW1");
    terminal.output = "";

    await paste("SW1", "enable\nconfigure terminal\nvlan 30\nname Guest\n\nend\nshow vlan brief\n");
    const dialog = await screen.findByRole("dialog", { name: "Paste 7 commands into SW1" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Paste Commands" }));

    await waitFor(() => expect(terminal.output).toContain("Guest"));
    // CLI modes changed naturally between pasted commands.
    expect(terminal.output).toContain("SW1(config)#");
    expect(terminal.output).toContain("SW1(config-vlan)#");
    // Order is preserved and the blank line behaved like a plain Enter.
    expect(terminal.output.indexOf("SW1(config)#")).toBeLessThan(terminal.output.indexOf("SW1(config-vlan)#"));
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);

    // History received each pasted command as its own entry.
    terminal.output = "";
    await act(async () => { terminal.emit("\x1b[A"); });
    expect(terminal.output).toContain("show vlan brief");
    terminal.output = "";
    await act(async () => { terminal.emit("\x1b[A"); });
    expect(terminal.output).toContain("end");
  });

  it("merges a bulk paste into the half-typed input line at the caret", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select SW1");
    // Half-typed line with the caret parked before " brief".
    await type(terminal, "show vlan brief");
    for (let index = 0; index < 6; index++) await act(async () => { terminal.emit("\x1b[D"); });
    terminal.output = "";

    await paste("SW1", "\nenable\nshow mac address-table\n");
    const dialog = await screen.findByRole("dialog", { name: "Paste 3 commands into SW1" });
    // The typed head joins the first pasted line; the caret tail trails behind.
    expect(dialog.querySelector("pre")?.textContent).toBe("show vlan\nenable\nshow mac address-table\n brief");
    await userEvent.click(within(dialog).getByRole("button", { name: "Paste Commands" }));

    await waitFor(() => expect(terminal.output).toContain("SW1# show mac address-table"));
    expect(terminal.output).toContain("SW1> show vlan");
    // The untouched tail is redrawn into the buffer, not executed.
    await waitFor(() => expect(terminal.output).toContain("SW1#  brief"));
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("13. leaves a final line without a newline in the input buffer", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select SW1");

    await paste("SW1", "enable\nconfigure terminal\nvlan 40\nname Lab");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));

    await waitFor(() => expect(terminal.output).toContain("SW1(config-vlan)#"));
    expect(terminal.output).toContain("name Lab");
    const before = executions(client);

    // It is only executed once the user presses Enter.
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(executions(client)).toBeGreaterThan(before));
  });

  it("15/16/22/23/24/25. pauses at Username and never echoes or records a pasted password", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await configureConsoleLogin();
    const terminal = await openDeviceTerminal("Select R1");
    await waitFor(() => expect(terminal.output).toContain("Username:"));
    const before = executions(client);

    // 15. An unauthenticated console stops the sequence before its first line.
    await paste("R1", "admin\ncisco123\nshow ip route\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));
    await waitFor(() => expect(terminal.output).toContain("Pasted command sequence paused for interactive input."));
    expect(executions(client)).toBe(before);
    expect(terminal.output).not.toContain("cisco123");

    // 16. Answering the username moves the queue on to the password prompt,
    // where it stops again instead of submitting the next line as a secret.
    await type(terminal, "admin");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("Password:"));
    terminal.output = "";
    await userEvent.click(screen.getByRole("button", { name: "Continue Paste" }));
    await waitFor(() => expect(terminal.output).toContain("Pasted command sequence paused for interactive input."));
    expect(executions(client)).toBe(before);
    expect(terminal.output).not.toContain("cisco123");

    // 22. A single-line credential paste is accepted but never echoed.
    await userEvent.click(screen.getByRole("button", { name: "Cancel Remaining" }));
    terminal.output = "";
    await paste("R1", "cisco123");
    expect(terminal.output).not.toContain("cisco123");

    // 25. A multi-line paste is refused outright at a credential prompt.
    await paste("R1", "cisco123\nmore");
    expect(terminal.output).toContain("multi-line paste cannot be used for a password");

    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("R1>"));
    // 23/24. Not in history, not in the transcript, not in Problems.
    terminal.output = "";
    await act(async () => { terminal.emit("\x1b[A"); });
    expect(terminal.output).not.toContain("cisco123");
    expect(screen.getByTestId("terminal-transcript").textContent).not.toContain("cisco123");
    expect(useWorkspaceStore.getState().problems.map((problem) => problem.message).join(" ")).not.toContain("cisco123");
  });

  it("17. pauses when a pasted command reaches the enable secret prompt", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await configureConsoleLogin();
    const terminal = await openDeviceTerminal("Select R1");
    await waitFor(() => expect(terminal.output).toContain("Username:"));
    await type(terminal, "admin");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("Password:"));
    await type(terminal, "cisco123");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("R1>"));
    terminal.output = "";

    await paste("R1", "enable\nshow running-config\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));

    await waitFor(() => expect(terminal.output).toContain("Pasted command sequence paused for interactive input."));
    expect(terminal.output).toContain("Password:");
    expect(terminal.output).not.toContain("Building configuration");
  });

  it("18/20. pauses at an interactive ping target and continues the rest afterwards", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select R1");
    terminal.output = "";

    await paste("R1", "ping\nshow ip route\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));
    await waitFor(() => expect(terminal.output).toContain("Pasted command sequence paused for interactive input."));
    expect(terminal.output).not.toContain("Gateway of last resort");
    expect(document.querySelector(".terminal-paste-run")?.textContent).toContain("1 command remaining");

    // Answering the prompt and continuing runs only the remaining line.
    await type(terminal, "192.168.10.1");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(terminal.output).toContain("Success rate"));
    await userEvent.click(screen.getByRole("button", { name: "Continue Paste" }));
    await waitFor(() => expect(terminal.output).toContain("192.168.20.0"));
    expect(screen.queryByRole("button", { name: "Continue Paste" })).toBeNull();
  });

  it("19. pauses when paged --More-- output takes over the keyboard", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select R1");
    terminal.output = "";

    await paste("R1", "show ?\nshow ip route\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));

    await waitFor(() => expect(terminal.output).toContain("--More--"));
    await waitFor(() => expect(terminal.output).toContain("Pasted command sequence paused for interactive input."));
    expect(terminal.output).not.toContain("Gateway of last resort");
  });

  it("21. Cancel Remaining drops the rest of the sequence", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select R1");

    await paste("R1", "ping\nshow ip route\nshow version\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel Remaining" })).not.toBeNull());

    await userEvent.click(screen.getByRole("button", { name: "Cancel Remaining" }));
    expect(screen.queryByRole("button", { name: "Continue Paste" })).toBeNull();
    const after = executions(client);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(executions(client)).toBe(after);
    expect(terminal.output).not.toContain("Gateway of last resort");
  });

  it("26/27/28/29. sanitizes control sequences and refuses NUL or oversized clipboards", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    terminal.output = "";

    await paste("PC1", "\x1b]52;c;cGF5bG9hZA==\x07\x1b]0;pwned\x07\x1b[31mipconfig\x1b[0m");
    expect(terminal.output).toContain("ipconfig");
    expect(terminal.output).not.toContain("52;c");
    expect(terminal.output).not.toContain("pwned");

    terminal.output = "";
    await paste("PC1", "ipconfig\u0000/all");
    expect(terminal.output).toContain("binary or NUL data");

    terminal.output = "";
    await paste("PC1", "a".repeat(100_001));
    expect(terminal.output).toContain("Paste is too large.");

    terminal.output = "";
    await paste("PC1", "arp -a\n".repeat(1_001));
    expect(terminal.output).toContain("lines");
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("30/31/32/33. offers Copy, Paste, Select All, Clear, Search and Close Tab", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "arp -a");
    await act(async () => { terminal.emit("\r"); });

    // 32. Copy is disabled without a selection and copies the selection with one.
    let menu = await openContextMenu("PC1");
    expect((within(menu).getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
    for (const label of ["Copy", "Paste", "Select All", "Clear Terminal", "Search", "Close Tab"]) {
      expect(within(menu).getByRole("menuitem", { name: label })).toBeTruthy();
    }
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Select All" }));
    expect(terminal.selectAllCalls).toBe(1);

    terminal.selection = "PC1 output";
    menu = await openContextMenu("PC1");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("PC1 output");

    // 30. Context-menu Paste reads the clipboard after an explicit user action.
    clipboardText = "ipconfig /all";
    terminal.output = "";
    menu = await openContextMenu("PC1");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
    await waitFor(() => expect(terminal.output).toContain("ipconfig /all"));

    // 31. A denied clipboard shows the documented recovery message.
    clipboardReadDenied = true;
    terminal.output = "";
    menu = await openContextMenu("PC1");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Paste" }));
    await waitFor(() => expect(terminal.output).toContain("Clipboard access was not granted."));
    expect(terminal.output).toContain("Use Ctrl+V to paste into the terminal.");

    // 33. Clear Terminal keeps the CLI session, history and tab.
    clipboardReadDenied = false;
    const clears = terminal.clears;
    menu = await openContextMenu("PC1");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Clear Terminal" }));
    expect(terminal.clears).toBeGreaterThan(clears);
    expect(client.requestTypes).not.toContain("CLOSE_CLI_SESSION");
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);
    terminal.output = "";
    await act(async () => { terminal.emit("\x1b[A"); });
    expect(terminal.output).toContain("arp -a");
  });

  it("34/35. keeps pasted input and the caret across Dock, Float and Maximize", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await paste("PC1", "ping 192.168.20.");
    await act(async () => { terminal.emit("\x1b[D"); });

    act(() => useWorkspaceStore.getState().setTerminalPresentationMode("floating"));
    act(() => useWorkspaceStore.getState().setTerminalPresentationMode("maximized"));
    act(() => useWorkspaceStore.getState().restoreTerminalPresentation());

    expect(xtermHarness.instances).toHaveLength(1);
    expect(terminal.disposed).toBe(false);
    expect(terminal.output).toContain("ping 192.168.20.");

    // The caret survived: a character lands before the final '.'.
    terminal.output = "";
    await type(terminal, "9");
    expect(terminal.output).toContain("ping 192.168.209.");
  });

  it("36/37. device deletion clears only that session's pending paste", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const router = await openDeviceTerminal("Select R1");
    await openDeviceTerminal("Select SW1");

    act(() => useWorkspaceStore.getState().setActiveTerminal("router-1"));
    await paste("R1", "ping\nshow ip route\n");
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue Paste" })).not.toBeNull());

    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Select SW1" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["router-1"]);
    await waitFor(() => expect(xtermHarness.instances[1]?.disposed).toBe(true));
    expect(router.disposed).toBe(false);
    // The surviving session keeps its paused sequence.
    expect(screen.getByRole("button", { name: "Continue Paste" })).toBeTruthy();
    expect(useWorkspaceStore.getState().problems).toHaveLength(0);
  });

  it("38/39. terminal paste never reaches global shortcuts or the diagram canvas", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    const host = screen.getByLabelText("PC1 terminal");
    const nodes = useWorkspaceStore.getState().draft?.topology.nodes.length ?? 0;
    const fitBefore = useWorkspaceStore.getState().fitRequest;

    await paste("PC1", "show interface description");
    fireEvent.keyDown(host, { key: "f" });
    fireEvent.keyDown(host, { key: "Delete" });

    expect(useWorkspaceStore.getState().fitRequest).toBe(fitBefore);
    expect(useWorkspaceStore.getState().draft?.topology.nodes.length).toBe(nodes);
    // No topology text or image annotation was created by a terminal paste.
    expect(useWorkspaceStore.getState().draft?.diagram?.annotations ?? []).toHaveLength(0);
    expect(terminal.output).toContain("show interface description");
  });

  it("renders the bulk paste preview as plain text and offers the local preference", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await openDeviceTerminal("Select SW1");

    await paste("SW1", "<img src=x onerror=alert(1)>\nshow vlan brief\n");
    const dialog = await screen.findByRole("dialog", { name: "Paste 2 commands into SW1" });
    const preview = dialog.querySelector("pre");
    expect(preview?.textContent).toBe("<img src=x onerror=alert(1)>\nshow vlan brief");
    expect(dialog.querySelector("img")).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    const toggle = screen.getByRole("menuitemradio", { name: "Confirm Multi-line Paste" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(toggle);
    expect(window.localStorage.getItem("simulatornet.confirmMultilinePaste")).toBe("false");

    // With the confirmation disabled a bulk paste runs immediately.
    await paste("SW1", "enable\nconfigure terminal\nvlan 55\n");
    expect(screen.queryByRole("dialog", { name: /Paste/ })).toBeNull();
    await waitFor(() => expect(xtermHarness.instances[0]?.output).toContain("SW1(config-vlan)#"));
    // The preference is local only and never enters the document.
    expect(JSON.stringify(useWorkspaceStore.getState().draft)).not.toContain("confirmMultilinePaste");
  });
});

describe("M10.4.1b collapsible bottom panel", () => {
  // The panel and the strip are lazily loaded, so presence is awaited and
  // absence is checked synchronously right after the state change.
  const findPanel = () => screen.findByLabelText("Workspace bottom panel");
  const findStrip = () => screen.findByLabelText("Workspace bottom panel, minimized");
  const queryPanel = () => screen.queryByLabelText("Workspace bottom panel");
  const queryStrip = () => screen.queryByLabelText("Workspace bottom panel, minimized");

  async function chooseBottomPanel(label: "Show" | "Minimize" | "Hide") {
    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Bottom Panel" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${label}`) }));
  }

  it("1/2. defaults to an expanded panel with visible tab content", async () => {
    await loadDemo(new RuntimeClient());
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("expanded");
    const dock = await findPanel();
    expect(queryStrip()).toBeNull();
    expect(within(dock).getByRole("tab", { name: /Terminal/ })).toBeTruthy();
  });

  it("3/4/5/6. Minimize leaves only the strip and Hide removes the panel entirely", async () => {
    await loadDemo(new RuntimeClient());
    await findPanel();

    await chooseBottomPanel("Minimize");
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("minimized");
    expect(queryPanel()).toBeNull();
    // Only the compact strip remains: the tabs are there, the content is not.
    const bar = await findStrip();
    for (const label of ["Terminal", "Events", "Packet trace", "Problems"]) {
      expect(within(bar).getByRole("tab", { name: new RegExp(label) })).toBeTruthy();
    }
    expect(document.querySelector(".dock-terminal-layer")).toBeNull();
    expect(document.querySelector("#bottom-dock")).toBeNull();

    await chooseBottomPanel("Hide");
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("hidden");
    expect(queryPanel()).toBeNull();
    expect(queryStrip()).toBeNull();
    // 9/10. Nothing is left behind: no resizer, no stale row.
    expect(document.querySelector(".resize-handle--horizontal")).toBeNull();
    // The registered panel set stays stable, but the collapsed panel has no
    // content or separator and therefore reserves no visible row.
    expect(document.querySelector(`[data-panel="${WORKSPACE_BOTTOM_PANEL_ID}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-panel="${WORKSPACE_BOTTOM_PANEL_ID}"]`)?.textContent).toBe("");
    expect(document.querySelector(".workspace-resizable")?.childElementCount).toBe(2);
  });

  it("keeps the registered panel set stable across Inspector and rapid dock transitions", async () => {
    await loadDemo(new RuntimeClient());
    const group = screen.getByTestId(WORKSPACE_PANEL_GROUP_ID);
    const panelIds = () => [...group.querySelectorAll("[data-panel]")]
      .map((panel) => panel.getAttribute("data-panel"));

    expect(panelIds()).toEqual(["workspace-main", WORKSPACE_BOTTOM_PANEL_ID]);
    expect(group.querySelector(`[data-separator="${WORKSPACE_BOTTOM_SEPARATOR_ID}"]`)).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(panelIds()).toEqual(["workspace-main", WORKSPACE_BOTTOM_PANEL_ID]);

    await chooseBottomPanel("Minimize");
    await chooseBottomPanel("Hide");
    await chooseBottomPanel("Show");
    expect(panelIds()).toEqual(["workspace-main", WORKSPACE_BOTTOM_PANEL_ID]);
    expect(screen.queryByText("The workspace could not be rendered")).toBeNull();
  });

  it("11/12/13/14/15/16/17. Hide and Minimize never close a terminal session", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "arp -a");
    await act(async () => { terminal.emit("\r"); });
    await type(terminal, "ping 192.168.");
    const scrollback = terminal.output;

    await chooseBottomPanel("Minimize");
    expect(terminal.disposed).toBe(false);
    await chooseBottomPanel("Hide");
    expect(terminal.disposed).toBe(false);
    expect(client.requestTypes).not.toContain("CLOSE_CLI_SESSION");
    expect(useWorkspaceStore.getState().terminalTabs).toEqual(["pc-1"]);

    await chooseBottomPanel("Show");
    expect(xtermHarness.instances).toHaveLength(1);
    // Scrollback, the partial input line and history all survived.
    expect(terminal.output.startsWith(scrollback)).toBe(true);
    expect(terminal.output).toContain("ping 192.168.");
    terminal.output = "";
    await act(async () => { terminal.emit("\x1b[A"); });
    expect(terminal.output).toContain("arp -a");
  });

  it("16. a pending paste survives Hide and Show", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select R1");
    await act(async () => {
      fireEvent.paste(screen.getByLabelText("R1 terminal"), {
        clipboardData: { getData: () => "ping\nshow ip route\n" },
      });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Paste Commands" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue Paste" })).not.toBeNull());

    await chooseBottomPanel("Hide");
    await chooseBottomPanel("Show");
    expect(terminal.disposed).toBe(false);
    expect(screen.getByRole("button", { name: "Continue Paste" })).toBeTruthy();
  });

  it("18/19. fits xterm only once the panel has a measurable size again", async () => {
    await loadDemo(new RuntimeClient());
    const terminal = await openDeviceTerminal("Select PC1");
    await chooseBottomPanel("Hide");
    const fitsWhileHidden = fitHarness.calls;

    // Nothing measures a 0x0 container while the panel is gone.
    window.dispatchEvent(new Event("resize"));
    expect(fitHarness.calls).toBe(fitsWhileHidden);

    await chooseBottomPanel("Show");
    expect(fitHarness.calls).toBeGreaterThan(fitsWhileHidden);
    // One prompt, not a duplicate, after the round trip.
    expect(terminal.output.match(/C:\\>/g)?.length).toBe(1);
  });

  it("20/21/22/23. events keep accumulating while collapsed and update the badges", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await chooseBottomPanel("Minimize");

    await type(terminal, "ping 192.168.20.10");
    await act(async () => { terminal.emit("\r"); });
    await waitFor(() => expect(useWorkspaceStore.getState().traces.length).toBeGreaterThan(0));

    const traces = useWorkspaceStore.getState().traces.length;
    const eventsTab = within(await findStrip()).getByRole("tab", { name: /Events/ });
    expect(eventsTab.textContent).toContain(String(traces));
  });

  it("24/25. a hidden panel still surfaces problems and opens the right tab", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await chooseBottomPanel("Hide");
    act(() => useWorkspaceStore.getState().setError("Runtime failure detected", "worker"));

    const status = screen.getByRole("button", { name: /Show bottom panel: Problems, 1 reported/ });
    expect(status.className).toContain("has-problems");
    // The panel was not force-expanded by the error itself.
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("hidden");

    await userEvent.click(status);
    expect(useWorkspaceStore.getState()).toMatchObject({ bottomPanelState: "expanded", dockTab: "problems" });
    expect(within(await findPanel()).getByText("Runtime failure detected")).toBeTruthy();
  });

  it("26. Ctrl/Cmd+J toggles the panel open and closed", async () => {
    await loadDemo(new RuntimeClient());
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("hidden");
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("expanded");

    // A minimized panel opens rather than cycling through minimize again.
    await chooseBottomPanel("Minimize");
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("expanded");
  });

  it("27. Ctrl/Cmd+` restores a docked terminal behind a hidden panel", async () => {
    await loadDemo(new RuntimeClient());
    await openDeviceTerminal("Select PC1");
    await chooseBottomPanel("Hide");

    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true });
    expect(useWorkspaceStore.getState()).toMatchObject({
      bottomPanelState: "expanded",
      dockTab: "terminal",
      terminalVisible: true,
    });
  });

  it("28/29. a floating or maximized terminal is unaffected by the panel state", async () => {
    await loadDemo(new RuntimeClient());
    const terminal = await openDeviceTerminal("Select PC1");
    act(() => useWorkspaceStore.getState().setTerminalPresentationMode("floating"));

    await chooseBottomPanel("Hide");
    const shell = document.querySelector(".terminal-presentation");
    expect(shell?.getAttribute("data-terminal-on-screen")).toBe("true");
    expect(shell?.className).toContain("is-visible");
    expect(terminal.disposed).toBe(false);

    act(() => useWorkspaceStore.getState().setTerminalPresentationMode("maximized"));
    expect(useWorkspaceStore.getState().bottomPanelState).toBe("hidden");
    expect(document.querySelector(".terminal-presentation")?.getAttribute("data-terminal-on-screen")).toBe("true");
  });

  it("30. Dock at Bottom expands the panel onto the Terminal tab", async () => {
    await loadDemo(new RuntimeClient());
    await openDeviceTerminal("Select PC1");
    act(() => useWorkspaceStore.getState().setTerminalPresentationMode("floating"));
    await chooseBottomPanel("Hide");

    await openMenu("View");
    await userEvent.click(screen.getByRole("menuitem", { name: "Terminal" }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /^Dock at Bottom/ }));

    expect(useWorkspaceStore.getState()).toMatchObject({
      bottomPanelState: "expanded",
      dockTab: "terminal",
      terminalPresentationMode: "docked",
    });
    expect(xtermHarness.instances).toHaveLength(1);
  });

  it("7/31/32. the height and state persist locally and never enter the document", async () => {
    await loadDemo(new RuntimeClient());
    act(() => useWorkspaceStore.getState().setBottomPanelExpandedHeight(310, 1_000));
    await chooseBottomPanel("Minimize");
    await chooseBottomPanel("Show");

    expect(useWorkspaceStore.getState().bottomPanelExpandedHeight).toBe(310);
    expect(window.localStorage.getItem("simulatornet.bottomPanelExpandedHeight")).toBe("310");
    expect(window.localStorage.getItem("simulatornet.bottomPanelState")).toBe("expanded");

    const exported = stringifyLabDocument(canonicalizeLabDocument(useWorkspaceStore.getState().draft!));
    expect(exported).not.toContain("bottomPanel");
    expect(exported).not.toContain("ExpandedHeight");
    expect(exported).not.toContain("simulatornet.");
  });

  it("8. clamps a restored height that no longer fits the viewport", async () => {
    await loadDemo(new RuntimeClient());
    act(() => useWorkspaceStore.getState().setBottomPanelExpandedHeight(900, 720));
    // 48% of a 720px workspace keeps the canvas in the majority.
    expect(useWorkspaceStore.getState().bottomPanelExpandedHeight).toBe(345);
  });

  it("33/34/35/36/37. toggling the panel leaves dialogs, links and runtime untouched", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: /Packet execution mode: Auto/ }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Packet Execution" }), "step");
    await userEvent.click(await screen.findByRole("button", { name: "Got it" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Select PC1" }));
    await screen.findByRole("dialog", { name: "PC1 device window" });

    const links = useWorkspaceStore.getState().draft?.topology.links.length;
    const requests = client.requestTypes.length;

    await chooseBottomPanel("Hide");
    await chooseBottomPanel("Show");

    // The device window stayed open, the topology was not rebuilt and the
    // Auto/Step selection survived.
    expect(screen.getByRole("dialog", { name: "PC1 device window" })).toBeTruthy();
    expect(useWorkspaceStore.getState().draft?.topology.links.length).toBe(links);
    expect(useWorkspaceStore.getState().executionMode).toBe("step");
    expect(client.requestTypes.slice(requests)).not.toContain("REBUILD_LAB");
    expect(useWorkspaceStore.getState().pendingTopologyChanges).toBe(false);
  });

  it("38/39/40. stays usable at 1280x720, 1440x900 and 1920x1080", async () => {
    for (const height of [720, 900, 1080]) {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
      act(() => useWorkspaceStore.getState().setBottomPanelExpandedHeight(600, height));
      const stored = useWorkspaceStore.getState().bottomPanelExpandedHeight;
      expect(stored).toBeGreaterThanOrEqual(180);
      expect(stored).toBeLessThan(height / 2);
    }
  });
});
