// @vitest-environment jsdom

import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import {
  createSimulationWorkerRuntime,
  type SimWorkerEvent,
  type SimWorkerPayloadByType,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import { DEMO_LAB } from "../../fixtures/demo-lab";
import { ConfigurationPanel } from "./ConfigurationPanel";

afterEach(cleanup);

/** The real in-process worker runtime, so every projection is genuine. */
class RuntimeClient implements SimulatorClient {
  private readonly runtime = createSimulationWorkerRuntime(() => undefined);
  private nextId = 1;

  async request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    const response = this.runtime.handleRequest({ ...input, requestId: `cfg-${this.nextId++}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(_listener: (event: SimWorkerEvent) => void): () => void {
    return () => undefined;
  }
}

async function openPanel(deviceId: string) {
  const client = new RuntimeClient();
  await client.request({ type: "INITIALIZE_LAB", document: canonicalizeLabDocument(DEMO_LAB) });
  const errors: string[] = [];
  const changed = vi.fn<(document: LabDocument, runtimeSynchronized: boolean) => void>();
  render(<ConfigurationPanel
    client={client}
    deviceId={deviceId}
    hostname={deviceId}
    runtimeAvailable
    onConfigurationChanged={changed}
    onError={(message) => errors.push(message)}
  />);
  await screen.findByRole("tablist", { name: "Configuration sections" });
  return { client, changed, errors };
}

const section = (name: string) => screen.getByRole("tab", { name });

describe("device configuration workspace", () => {
  it("shows the rendered running configuration and never raw JSON", async () => {
    const { errors } = await openPanel("switch-1");
    const listing = await screen.findByLabelText("Running configuration");
    expect(listing.textContent).toContain("hostname SW1");
    expect(listing.textContent).not.toContain("\"kind\":");
    expect(listing.textContent).not.toContain("l2-switch");
    expect(errors).toEqual([]);
  });

  it("copies running to startup and reports the device as saved", async () => {
    const { changed } = await openPanel("switch-1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Copy Running to Startup/u }));
    await screen.findByText("Running configuration copied to startup.");
    expect(changed).toHaveBeenCalled();
    expect(screen.getByTitle("Saved").textContent).toContain("Saved");
  });

  it("compares startup with running after an unsaved change", async () => {
    await openPanel("switch-1");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Copy Running to Startup/u }));
    await screen.findByText("Running configuration copied to startup.");

    // Change only the running configuration; applying text must not write NVRAM.
    await user.click(section("Import / Paste"));
    await user.click(screen.getByLabelText("Configuration text"));
    await user.paste("hostname EDGE-SW\n");
    await user.click(screen.getByRole("button", { name: "Parse" }));
    await user.click(screen.getByRole("button", { name: /Apply to running/u }));
    await waitFor(() => expect(screen.getByLabelText("Running configuration").textContent).toContain("hostname EDGE-SW"));

    await user.click(section("Compare"));
    const diff = await screen.findByLabelText("Configuration differences");
    expect(diff.textContent).toContain("hostname SW1");
    expect(diff.textContent).toContain("hostname EDGE-SW");
    expect(screen.getByText(/unsaved change/u)).toBeDefined();
  });

  it("erases the startup configuration only after an explicit confirmation", async () => {
    await openPanel("switch-1");
    const user = userEvent.setup();
    await user.click(section("Startup Config"));
    await user.click(screen.getByRole("button", { name: /Erase/u }));
    expect(screen.getByRole("alertdialog", { name: "Erase startup-config" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Erase startup-config" }));
    await screen.findByText(/Startup configuration erased/u);
    expect((await screen.findByLabelText("Startup configuration")).textContent)
      .toContain("% startup-config is not present");
  });

  it("previews a pasted configuration before applying it and never echoes a secret", async () => {
    const { errors } = await openPanel("switch-1");
    const user = userEvent.setup();
    await user.click(section("Import / Paste"));
    const editor = screen.getByLabelText("Configuration text");
    await user.click(editor);
    await user.paste([
      "hostname PASTED-SW",
      "enable secret Cisco123",
      "router bgp 65000",
    ].join("\n"));
    await user.click(screen.getByRole("button", { name: "Parse" }));

    const report = await screen.findByText("Parse report");
    const container = report.parentElement!;
    expect(container.textContent).toContain("unsupported line(s)");
    expect(container.textContent).toContain("router bgp 65000");
    expect(container.textContent).not.toContain("Cisco123");
    expect(container.textContent).toContain("enable secret <redacted>");

    await user.click(screen.getByRole("button", { name: /Apply to running/u }));
    await waitFor(() => expect(screen.getByLabelText("Running configuration").textContent).toContain("hostname PASTED-SW"));
    expect(screen.getByLabelText("Running configuration").textContent).not.toContain("Cisco123");
    expect(errors).toEqual([]);
  });

  it("explains that a host is configured elsewhere", async () => {
    await openPanel("pc-1");
    const listing = await screen.findByLabelText("Running configuration");
    expect(listing.textContent).toContain("Desktop / IP Configuration");
    await userEvent.setup().click(section("Import / Paste"));
    expect(screen.getByText(/configured through its own/u)).toBeDefined();
  });
});
