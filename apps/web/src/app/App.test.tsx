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
import { App } from "./App";
import type { SimulatorClient } from "./simulator-client";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    clear() {}
    getSelection() { return ""; }
    onData() { return { dispose() {} }; }
    dispose() {}
  },
}));
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
    MiniMap: () => null,
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

beforeEach(() => {
  compactViewport = false;
  useWorkspaceStore.getState().reset();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    matches: compactViewport,
    media: "(max-width: 999px)",
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
  await userEvent.click(screen.getByRole("button", { name: "Load demo lab" }));
  await waitFor(() => expect(useWorkspaceStore.getState().snapshot?.labId).toBe("demo-router-on-a-stick"));
}

async function enterEditMode() {
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await waitFor(() => expect(useWorkspaceStore.getState().mode).toBe("edit"));
}

describe("M6 simulator workspace", () => {
  it("renders the professional app shell", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    expect(screen.getByRole("banner", { name: "Simulation toolbar" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Topology tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load demo lab" })).toBeTruthy();
    expect(document.querySelector(".app-shell")?.getAttribute("data-workspace-mode")).toBe("simulate");
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
    await userEvent.click(screen.getByLabelText("Export lab JSON"));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
  });

  it("does not trigger global shortcuts while typing in terminal", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Open CLI/ }));
    const input = await screen.findByLabelText("CLI command");
    const before = client.requestTypes.filter((type) => type === "SERIALIZE_LAB").length;
    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
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
