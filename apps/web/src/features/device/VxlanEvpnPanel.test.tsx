// @vitest-environment jsdom

import type { DeviceType } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import {
  createSimulationWorkerRuntime,
  type SimWorkerEvent,
  type SimWorkerPayloadByType,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import { BGP_EVPN_STRETCH_DEMO } from "../../fixtures/vxlan-evpn-demo-labs";
import { getDeviceWindowDefinition } from "./device-window-registry";
import { VxlanEvpnPanel, VXLAN_SECTIONS, vxlanSupportedFor } from "./VxlanEvpnPanel";

afterEach(cleanup);

/** The same in-process worker runtime the app uses, so the overlay is real. */
class RuntimeClient implements SimulatorClient {
  private readonly runtime = createSimulationWorkerRuntime(() => undefined);
  private nextId = 1;

  async request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    const response = this.runtime.handleRequest({ ...input, requestId: `vxlan-${this.nextId++}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(_listener: (event: SimWorkerEvent) => void): () => void {
    return () => undefined;
  }
}

async function openPanel(deviceId = "leaf1", deviceType: DeviceType = "l3-switch") {
  const client = new RuntimeClient();
  await client.request({ type: "INITIALIZE_LAB", document: canonicalizeLabDocument(BGP_EVPN_STRETCH_DEMO) });
  const errors: string[] = [];
  render(<VxlanEvpnPanel
    client={client}
    deviceId={deviceId}
    deviceType={deviceType}
    onError={(message) => errors.push(message)}
  />);
  await waitFor(() => expect(screen.queryByText("Loading VXLAN…")).toBeNull());
  return { errors };
}

describe("VxlanEvpnPanel", () => {
  it("keeps the selected section as local UI state while showing real overlay data", async () => {
    await openPanel();
    // Opens on NVE, which reports the logical interface and its source.
    expect(screen.getByRole("heading", { name: "NVE Interface" })).toBeTruthy();
    const nveRow = screen.getByRole("row", { name: /nve1/ });
    expect(within(nveRow).getByText("Loopback0")).toBeTruthy();
    expect(within(nveRow).getByText("10.255.0.1")).toBeTruthy();
    expect(within(nveRow).getAllByText("up").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("tab", { name: "EVPN Type 3" }));
    expect(screen.getByRole("heading", { name: /Inclusive Multicast/ })).toBeTruthy();
    // Membership arrived through the control plane, stamped by the reflector.
    expect(screen.getAllByText("20020").length).toBeGreaterThan(0);
    expect(screen.getAllByText("65000:20020").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("tab", { name: "Peers" }));
    expect(screen.getByText("BGP EVPN Type 3")).toBeTruthy();
    expect(screen.getByText("10.255.0.2")).toBeTruthy();

    // Every section is reachable and none of them is a top-level tab.
    for (const entry of VXLAN_SECTIONS) {
      expect(screen.getByRole("tab", { name: entry.label })).toBeTruthy();
    }
  });

  it("shows the routed sections as structured tables, with honest empty states", async () => {
    // This demo bridges only, so the routed halves must say so rather than
    // rendering an empty table with no explanation.
    await openPanel();
    await userEvent.click(screen.getByRole("tab", { name: "L3VNI" }));
    expect(screen.getByRole("heading", { name: /Routed Transit Segments/ })).toBeTruthy();
    expect(screen.getByText("No L3VNI is associated with a VRF.")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "Anycast Gateway" }));
    expect(screen.getByText("No SVI runs in anycast-gateway mode.")).toBeTruthy();
    expect(screen.getByText("not configured")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "EVPN Type 5" }));
    expect(screen.getByText("No Type 5 prefix is present.")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "VRF Routes" }));
    expect(screen.getByText("No tenant VRF carries a route.")).toBeTruthy();

    await userEvent.click(screen.getByRole("tab", { name: "Routed Overlay" }));
    expect(screen.getByRole("heading", { name: "Routed Overlay Status" })).toBeTruthy();
    expect(screen.getByText("No L3VNI is associated with a VRF on this VTEP.")).toBeTruthy();
  });

  it("offers the VTEP surface only where the capability exists", () => {
    expect(vxlanSupportedFor("l3-switch")).toBe(true);
    for (const type of ["router", "l2-switch", "firewall", "pc"] as const) {
      expect(vxlanSupportedFor(type)).toBe(false);
    }
    // The section is registered on the L3 Switch alone, between VLANs and
    // Routing, and it never becomes a new top-level device-window tab.
    const leaf = getDeviceWindowDefinition("l3-switch");
    const ids = leaf.configSections.map((section) => section.id);
    expect(ids).toContain("vxlan-evpn-config");
    expect(ids.indexOf("vxlan-evpn-config")).toBeGreaterThan(ids.indexOf("vlans-config"));
    expect(ids.indexOf("vxlan-evpn-config")).toBeLessThan(ids.indexOf("bgp-config"));
    expect(leaf.monitorSections.filter((section) => section.group === "VXLAN & EVPN")).toHaveLength(10);
    expect(leaf.mainTabs.map((tab) => tab.id)).toEqual(["physical", "config", "cli", "monitor", "attributes"]);
    expect(getDeviceWindowDefinition("router").configSections.map((section) => section.id))
      .not.toContain("vxlan-evpn-config");
  });
});
