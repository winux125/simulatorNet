// @vitest-environment jsdom

import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type LabUiNode,
  type SimWorkerEvent,
  type SimWorkerPayloadByType,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import { HostIpConfigurationPanel } from "./HostIpConfigurationPanel";

const document: LabDocument = {
  schemaVersion: 1,
  id: "host-form",
  title: "Host form",
  simulation: { seed: 12 },
  topology: {
    schemaVersion: 1,
    nodes: [{ id: "pc-1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] }],
    links: [],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false },
  },
};

const node: LabUiNode = {
  id: "pc-1",
  type: "pc",
  hostname: "PC1",
  position: { x: 0, y: 0 },
  status: "down",
  interfaces: [{ id: "eth0", adminUp: true, operationalUp: false }],
};

class RuntimeClient implements SimulatorClient {
  readonly types: string[] = [];
  private readonly runtime = createSimulationWorkerRuntime();
  private id = 0;
  constructor() {
    this.runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "init", document });
  }
  async request<Type extends SimWorkerRequest["type"]>(input: SimWorkerRequestInputOf<Type>): Promise<SimWorkerPayloadByType[Type]> {
    this.types.push(input.type);
    const response = this.runtime.handleRequest({ ...input, requestId: `ui-${++this.id}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }
  onEvent(_listener: (event: SimWorkerEvent) => void): () => void { return () => undefined; }
}

afterEach(cleanup);

describe("HostIpConfigurationPanel", () => {
  it("applies field-validated static configuration through typed worker requests", async () => {
    const client = new RuntimeClient();
    const changed = vi.fn();
    render(<HostIpConfigurationPanel client={client} document={document} node={node} powerState="running" runtimeAvailable onConfigurationChanged={changed} onError={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText("IPv4 Address"), { target: { value: "192.168.10.10" } });
    fireEvent.change(screen.getByLabelText("Subnet Mask"), { target: { value: "255.255.255.0" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(client.types).toContain("SET_HOST_STATIC_CONFIGURATION");
    expect(changed.mock.calls[0]?.[0].configurations["pc-1"]).toMatchObject({
      ipv4: { address: "192.168.10.10", prefixLength: 24 },
    });
  });

  it("shows stopped DHCP guidance and enables Renew only while running", async () => {
    const client = new RuntimeClient();
    const { rerender } = render(<HostIpConfigurationPanel client={client} document={document} node={node} powerState="stopped" runtimeAvailable onConfigurationChanged={vi.fn()} onError={vi.fn()} />);
    await userEvent.click(await screen.findByLabelText("DHCP"));
    expect(screen.getByText("DHCP will start when the lab is started.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Renew" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<HostIpConfigurationPanel client={client} document={document} node={node} powerState="running" runtimeAvailable onConfigurationChanged={vi.fn()} onError={vi.fn()} />);
    expect((screen.getByRole("button", { name: "Renew" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("configures a draft-only PC without sending a stale worker request", async () => {
    const client = new RuntimeClient();
    const changed = vi.fn();
    render(<HostIpConfigurationPanel
      client={client}
      document={document}
      node={node}
      powerState="stopped"
      runtimeAvailable={false}
      onConfigurationChanged={changed}
      onError={vi.fn()}
    />);
    fireEvent.change(await screen.findByLabelText("IPv4 Address"), { target: { value: "192.168.10.20" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(changed.mock.calls[0]?.[0].configurations["pc-1"]).toMatchObject({
      ipv4: { address: "192.168.10.20", prefixLength: 24 },
      dhcpEnabled: false,
    });
    expect(changed.mock.calls[0]?.[1]).toBe(false);
    expect(client.types).toEqual([]);
  });
});
