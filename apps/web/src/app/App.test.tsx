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
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  function MockReactFlow(props: Record<string, unknown>) {
    const nodes = props.nodes as Array<Record<string, unknown>>;
    const edges = props.edges as Array<Record<string, unknown>>;
    const nodeTypes = props.nodeTypes as Record<string, React.ComponentType<Record<string, unknown>>>;
    React.useEffect(() => {
      (props.onInit as ((instance: unknown) => void) | undefined)?.({
        fitView: vi.fn(),
        screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      });
    }, []);
    return React.createElement("div", { "data-testid": "react-flow" }, [
      ...nodes.map((node) => {
        const Component = nodeTypes[String(node.type)];
        return Component ? React.createElement(Component, { key: String(node.id), ...node }) : null;
      }),
      ...edges.map((edge) => React.createElement("button", {
        key: String(edge.id),
        type: "button",
        "aria-label": `Select link ${String(edge.id)}`,
        onClick: (event: React.MouseEvent) => (props.onEdgeClick as ((event: React.MouseEvent, edge: unknown) => void))(event, edge),
        onContextMenu: (event: React.MouseEvent) => (props.onEdgeContextMenu as ((event: React.MouseEvent, edge: unknown) => void))(event, edge),
      }, String(edge.label ?? edge.id))),
    ]);
  }
  return {
    ReactFlow: MockReactFlow,
    Handle: () => React.createElement("span"),
    Position: { Left: "left", Right: "right" },
    BackgroundVariant: { Dots: "dots" },
    Background: () => null,
    Controls: () => null,
  };
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
let prefersDark = true;

beforeEach(() => {
  compactViewport = false;
  prefersDark = true;
  xtermHarness.instances.length = 0;
  window.localStorage.clear();
  useWorkspaceStore.getState().reset();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({
    matches: query.includes("max-width") ? compactViewport : query.includes("prefers-color-scheme: dark") ? prefersDark : false,
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
  await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe("demo-router-on-a-stick"));
}

async function enterEditMode() {
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("edit"));
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
    expect(screen.getByRole("navigation", { name: "Topology tools" })).toBeTruthy();
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
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    await openMenu("File");
    await userEvent.click(screen.getByRole("menuitem", { name: "Close Lab" }));
    expect(screen.getByRole("dialog", { name: "Close laboratory?" })).toBeTruthy();
    expect(useWorkspaceStore.getState().draft).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Discard & Close" }));
    expect(await screen.findByRole("heading", { name: "SimulatorNet" })).toBeTruthy();
  });

  it("does not render a React Flow minimap", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    expect(document.querySelector(".react-flow__minimap")).toBeNull();
  });

  it("defaults to System theme and switches Dark, Light and System immediately", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const control = screen.getByLabelText("Color theme") as HTMLSelectElement;
    expect(control.value).toBe("system");
    expect(document.documentElement.dataset.themePreference).toBe("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    await userEvent.selectOptions(control, "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    await userEvent.selectOptions(control, "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    prefersDark = false;
    await userEvent.selectOptions(control, "system");
    expect(document.documentElement.dataset.themePreference).toBe("system");
  });

  it("persists the selected theme in localStorage", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    await userEvent.selectOptions(screen.getByLabelText("Color theme"), "light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    cleanup();
    render(<App client={new RuntimeClient()} />);
    expect((screen.getByLabelText("Color theme") as HTMLSelectElement).value).toBe("light");
  });

  it("keeps topology and terminal mounted in dark and light themes", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
    expect(await screen.findByLabelText("PC1 CLI")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Color theme"), "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(screen.getByTestId("react-flow")).toBeTruthy();
    expect(screen.getByLabelText("PC1 CLI")).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Color theme"), "dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("activates tool rail actions", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    expect(screen.getByRole("complementary", { name: "Device library" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add device" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("filters the device library", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await userEvent.type(screen.getByLabelText("Filter devices"), "router");
    expect(screen.getByRole("button", { name: "Add Router" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add PC" })).toBeNull();
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

  it("transitions between Edit and Simulate through rebuild", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("simulate"));
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
    expect(client.requestTypes).toContain("REBUILD_LAB");
  });

  it("shows pending topology changes and rebuild action", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await enterEditMode();
    await userEvent.click(screen.getByRole("button", { name: "Add device" }));
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
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

  it("Ctrl+L clears the visible buffer but keeps the session open", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    const terminal = await openDeviceTerminal("Select PC1");
    await type(terminal, "arp");
    await act(async () => { terminal.emit("\x0c"); });
    expect(terminal.clears).toBeGreaterThanOrEqual(1);
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
    await userEvent.click(screen.getByRole("menuitemradio", { name: "Edit Mode" }));
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
