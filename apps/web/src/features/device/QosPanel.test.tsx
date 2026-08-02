// @vitest-environment jsdom

import type { DeviceType, LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import {
  createSimulationWorkerRuntime,
  type LabUiNode,
  type SimWorkerEvent,
  type SimWorkerPayloadByType,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import { DSCP_CLASSIFICATION_DEMO } from "../../fixtures/qos-demo-labs";
import { DeviceWindow } from "./DeviceWindow";
import { QosPanel, QOS_SECTIONS, qosCapabilitiesFor } from "./QosPanel";

afterEach(cleanup);

/** The same in-process worker runtime the app uses, so QoS state is real. */
class RuntimeClient implements SimulatorClient {
  private readonly runtime = createSimulationWorkerRuntime(() => undefined);
  private nextId = 1;

  async request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    const response = this.runtime.handleRequest({ ...input, requestId: `qos-${this.nextId++}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(_listener: (event: SimWorkerEvent) => void): () => void {
    return () => undefined;
  }
}

async function openPanel(deviceId = "router", deviceType: DeviceType = "router") {
  const client = new RuntimeClient();
  const document = canonicalizeLabDocument(DSCP_CLASSIFICATION_DEMO);
  await client.request({ type: "INITIALIZE_LAB", document });
  const errors: string[] = [];
  const changed = vi.fn<(document: LabDocument, runtimeSynchronized: boolean) => void>();
  render(<QosPanel
    client={client}
    deviceId={deviceId}
    deviceType={deviceType}
    interfaces={[{ id: "Gi0/2", adminUp: true, operationalUp: true }]}
    onConfigurationChanged={changed}
    onError={(message) => errors.push(message)}
  />);
  await screen.findByRole("tablist", { name: "QoS sections" });
  return { client, changed, errors };
}

const section = (name: string) => screen.getByRole("tab", { name });

describe("consolidated QoS panel", () => {
  it("groups QoS below Config instead of adding top-level tabs", async () => {
    const client = new RuntimeClient();
    const document = canonicalizeLabDocument(DSCP_CLASSIFICATION_DEMO);
    const ready = await client.request({ type: "INITIALIZE_LAB", document });
    const node = ready.nodes.find((candidate) => candidate.id === "router") as LabUiNode;
    render(<DeviceWindow
      client={client}
      document={document}
      node={node}
      powerState="running"
      runtimeAvailable
      onOpenTerminal={() => undefined}
      onConfigurationChanged={() => undefined}
      onError={() => undefined}
      onClose={() => undefined}
    />);
    const tabs = within(screen.getByRole("tablist", { name: /R1 sections/ })).getAllByRole("tab");
    const labels = tabs.map((tab) => tab.textContent);
    expect(labels).toEqual(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
    expect(labels.filter((label) => label?.includes("QoS"))).toEqual([]);
    await userEvent.click(screen.getByRole("tab", { name: "Config" }));
    expect(within(screen.getByRole("navigation", { name: "Configuration sections" })).getByRole("button", { name: "QoS" })).toBeTruthy();
    for (const removed of ["QoS Class Maps", "QoS Policy Maps", "QoS Interface Policies", "QoS Queues", "QoS Counters"]) {
      expect(labels).not.toContain(removed);
    }
  });

  it("reaches every secondary section from the single tab", async () => {
    await openPanel();
    for (const entry of QOS_SECTIONS) {
      await userEvent.click(section(entry.label));
      expect(screen.getByRole("tabpanel", { name: `QoS ${entry.label}` })).toBeTruthy();
    }
  });

  it("shares one component across Router, L3 Switch and Firewall", () => {
    expect(qosCapabilitiesFor("router")).toBeDefined();
    expect(qosCapabilitiesFor("l3-switch")).toBeDefined();
    expect(qosCapabilitiesFor("firewall")).toBeDefined();
    // No policy engine, so no QoS surface at all.
    expect(qosCapabilitiesFor("l2-switch")).toBeUndefined();
    expect(qosCapabilitiesFor("wireless-router")).toBeUndefined();
    expect(qosCapabilitiesFor("pc")).toBeUndefined();
  });

  it("hides controls the device kind does not support", async () => {
    await openPanel("router", "router");
    await userEvent.click(section("Interfaces"));
    expect(screen.getByText(/802\.1Q subinterfaces/)).toBeTruthy();
    expect(screen.queryByText(/switched virtual interfaces/)).toBeNull();
    cleanup();

    await openPanel("router", "l3-switch");
    await userEvent.click(section("Interfaces"));
    expect(screen.getByText(/switched virtual interfaces/)).toBeTruthy();
    expect(screen.queryByText(/802\.1Q subinterfaces/)).toBeNull();
    // Zone policy is named only where it actually runs.
    await userEvent.click(section("Overview"));
    expect(screen.queryByText(/zone policy and/)).toBeNull();
    cleanup();

    await openPanel("router", "firewall");
    expect(screen.getByText(/zone policy and/)).toBeTruthy();
  });

  it("saves a class map from Classification and shows it back", async () => {
    const { changed } = await openPanel();
    await userEvent.click(section("Classification"));
    const editor = screen.getByLabelText("Class maps JSON") as HTMLTextAreaElement;
    expect(editor.value).toContain("REALTIME");

    await userEvent.clear(editor);
    await userEvent.paste(JSON.stringify([{ id: "LAB-CLASS", matchType: "match-any", matches: [{ kind: "any" }] }]));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(changed).toHaveBeenCalled());
    const [document, runtimeSynchronized] = changed.mock.calls.at(-1)!;
    expect(runtimeSynchronized).toBe(true);
    const configuration = document.configurations.router;
    expect(configuration && "qos" in configuration ? configuration.qos?.classMaps : undefined)
      .toEqual([{ id: "LAB-CLASS", matchType: "match-any", matches: [{ kind: "any" }] }]);
    await waitFor(() => expect((screen.getByLabelText("Class maps JSON") as HTMLTextAreaElement).value)
      .toContain("LAB-CLASS"));
  });

  it("shows runtime queues and counters, and clearing them keeps the configuration", async () => {
    const { changed } = await openPanel();
    await userEvent.click(section("Queues & Counters"));
    const panel = screen.getByRole("tabpanel", { name: "QoS Queues & Counters" });
    expect(panel.textContent).toContain("Gi0/2");
    expect(panel.textContent).toContain("class-default");

    await userEvent.click(screen.getByRole("button", { name: "Clear Runtime Counters" }));
    // Clearing counters is runtime only: it never writes the document.
    expect(changed).not.toHaveBeenCalled();
    await userEvent.click(section("Policies"));
    await waitFor(() => expect((screen.getByLabelText("Policy maps JSON") as HTMLTextAreaElement).value)
      .toContain("EDGE-MARK"));
    await userEvent.click(section("Classification"));
    expect((screen.getByLabelText("Class maps JSON") as HTMLTextAreaElement).value).toContain("REALTIME");
  });

  it("opens an interface row detail inside the same tab, not a nested window", async () => {
    await openPanel();
    await userEvent.click(section("Interfaces"));
    const panel = screen.getByRole("tabpanel", { name: "QoS Interfaces" });
    expect(within(panel).getByRole("cell", { name: "EDGE-MARK" })).toBeTruthy();
    await userEvent.click(within(panel).getByRole("button", { name: "Gi0/2" }));
    const detail = within(panel).getByLabelText("Gi0/2 QoS detail");
    expect(detail.textContent).toContain("Output policy");
    // The detail lives inside the QoS tab panel; no second dialog is opened.
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("keeps the secondary navigation reachable instead of truncating it", async () => {
    await openPanel();
    const nav = screen.getByRole("tablist", { name: "QoS sections" });
    // Every section name is rendered in full; the strip scrolls when narrow.
    expect(within(nav).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(QOS_SECTIONS.map((entry) => entry.label));
    expect(nav.className).toContain("qos-panel__nav");
  });
});
