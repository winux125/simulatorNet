// @vitest-environment jsdom

import type {
  SimWorkerEvent,
  SimWorkerPayloadByType,
  SimWorkerRequest,
  SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { createSimulationWorkerRuntime } from "@sim/sim-worker";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { SimulatorClient } from "./simulator-client";
import { useWorkspaceStore } from "../state/workspace-store";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    onData() { return { dispose() {} }; }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    ReactFlow: ({ nodes, nodeTypes }: { nodes: Array<Record<string, unknown>>; nodeTypes: Record<string, React.ComponentType<Record<string, unknown>>> }) => React.createElement(
      "div",
      { "data-testid": "react-flow" },
      nodes.map((node) => {
        const Component = nodeTypes[String(node.type)];
        return Component ? React.createElement(Component, { key: String(node.id), ...node }) : null;
      }),
    ),
    Handle: () => React.createElement("span"),
    Position: { Left: "left", Right: "right" },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

class RuntimeClient implements SimulatorClient {
  readonly requestTypes: string[] = [];
  private readonly listeners = new Set<(event: SimWorkerEvent) => void>();
  private readonly runtime = createSimulationWorkerRuntime((message) => {
    if (message.type !== "REQUEST_SUCCEEDED" && message.type !== "REQUEST_FAILED") {
      for (const listener of this.listeners) listener(message);
    }
  });
  private nextId = 1;

  async request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    this.requestTypes.push(input.type);
    const response = this.runtime.handleRequest({ ...input, requestId: `test-${this.nextId++}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(listener: (event: SimWorkerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

beforeEach(() => {
  useWorkspaceStore.getState().reset();
  Object.defineProperty(window, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  } });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => cleanup());

async function loadDemo(client: RuntimeClient) {
  render(<App client={client} />);
  await userEvent.click(screen.getByRole("button", { name: "Load demo" }));
  await screen.findByText(/Worker: ready/i);
}

describe("browser simulator application", () => {
  it("selects a topology node and opens its terminal", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    expect(screen.getByText(/PC1 · pc-1/)).toBeTruthy();
    expect((screen.getByLabelText("CLI command") as HTMLInputElement).disabled).toBe(false);
  });

  it("submits a terminal command through the worker", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Select PC1" }));
    await userEvent.type(screen.getByLabelText("CLI command"), "ping 192.168.20.10");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByTestId("terminal-transcript").textContent).toContain("Success rate is 100 percent"));
    expect(client.requestTypes).toContain("EXECUTE_CLI");
  });

  it("shows a readable error for invalid imported JSON", async () => {
    const client = new RuntimeClient();
    render(<App client={client} />);
    const file = new File(["not-json"], "broken.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => "not-json" });
    fireEvent.change(screen.getByLabelText("Load JSON"), { target: { files: [file] } });
    expect((await screen.findByRole("alert")).textContent).toContain("not valid JSON");
  });

  it("serializes and downloads the canonical document", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Save JSON" }));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled());
    expect(client.requestTypes).toContain("SERIALIZE_LAB");
  });

  it("warns before Apply/Rebuild resets runtime state", async () => {
    const client = new RuntimeClient();
    await loadDemo(client);
    await userEvent.click(screen.getByRole("button", { name: "Add PC" }));
    await userEvent.click(screen.getByRole("button", { name: /Apply \/ Rebuild/ }));
    const dialog = screen.getByRole("dialog", { name: "Apply topology changes?" });
    expect(dialog.textContent).toContain("resets runtime state");
    expect(screen.getByRole("button", { name: "Apply and rebuild" })).toBeTruthy();
  });
});
