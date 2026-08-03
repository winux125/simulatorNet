// @vitest-environment jsdom

import type { LabDocument } from "@sim/contracts";
import type { LabUiNode } from "@sim/sim-worker";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import { DeviceWindow } from "./DeviceWindow";
import { getDeviceWindowDefinition } from "./device-window-registry";

afterEach(cleanup);

describe("device window information architecture", () => {
  it.each(["router", "l2-switch", "l3-switch", "firewall"] as const)(
    "%s exposes no more than five stable main tabs",
    (type) => {
      expect(getDeviceWindowDefinition(type).mainTabs.map(({ label }) => label))
        .toEqual(["Physical", "Config", "CLI", "Monitor", "Attributes"]);
    },
  );

  it("moves legacy Router features below Config and Monitor", () => {
    const definition = getDeviceWindowDefinition("router");
    expect(definition.mainTabs.map(({ label }) => label)).not.toEqual(expect.arrayContaining([
      "ACL", "NAT", "QoS", "VPN", "AAA", "SNMP", "Sessions",
    ]));
    expect(definition.configSections.map(({ label }) => label)).toEqual(expect.arrayContaining([
      "BGP", "ACL", "NAT", "QoS", "VPN", "Console Access", "Remote Access", "AAA", "SNMP",
    ]));
    expect(definition.monitorSections.map(({ label }) => label)).toEqual(expect.arrayContaining([
      "BGP", "Sessions", "NAT Translations", "QoS Queues & Counters", "VPN Sessions",
    ]));
  });

  it("hides unsupported capability sections", () => {
    const l2 = getDeviceWindowDefinition("l2-switch").configSections.map(({ label }) => label);
    expect(l2).toEqual(expect.arrayContaining(["VLANs", "Spanning Tree", "EtherChannel"]));
    expect(l2).not.toEqual(expect.arrayContaining(["Routing", "NAT", "VPN", "QoS"]));

    const firewall = getDeviceWindowDefinition("firewall").configSections.map(({ label }) => label);
    expect(firewall).toEqual(expect.arrayContaining(["Interfaces & Zones", "Policies", "NAT", "VPN", "QoS"]));
    expect(firewall).not.toContain("VLANs");
  });

  it("keeps host and wireless device tabs concise and task-oriented", () => {
    expect(getDeviceWindowDefinition("pc").mainTabs.map(({ label }) => label))
      .toEqual(["Physical", "Config", "Desktop", "Terminal", "Attributes"]);
    expect(getDeviceWindowDefinition("server").mainTabs.map(({ label }) => label))
      .toEqual(["Physical", "Config", "Services", "Desktop", "Terminal", "Attributes"]);
    expect(getDeviceWindowDefinition("access-point").mainTabs.map(({ label }) => label))
      .toEqual(["Physical", "Config", "Wireless", "Monitor", "Attributes"]);
  });

  it("preserves the traffic generator workflow instead of showing empty generic tabs", () => {
    expect(getDeviceWindowDefinition("traffic-generator").mainTabs.map(({ label }) => label))
      .toEqual(["Flows", "Run", "Results"]);
  });

  it("renders secondary Config and Monitor navigation without recreating a CLI tab", async () => {
    const node: LabUiNode = {
      id: "router-1",
      type: "router",
      hostname: "R1",
      position: { x: 0, y: 0 },
      status: "down",
      interfaces: [
        { id: "Gi0/0", adminUp: true, operationalUp: false },
        { id: "Gi0/1", adminUp: true, operationalUp: false },
      ],
    };
    const document = {
      schemaVersion: 1,
      id: "navigation",
      title: "Navigation",
      simulation: { seed: 1 },
      topology: { schemaVersion: 1, nodes: [{ id: node.id, kind: node.type, interfaces: node.interfaces.map(({ id }) => ({ id })) }], links: [] },
      configurations: { [node.id]: { kind: "router", hostname: "R1", interfaces: [], subinterfaces: [], staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [] } },
    } as LabDocument;
    const client = { request: vi.fn(), onEvent: vi.fn(() => () => undefined) } as unknown as SimulatorClient;
    const openTerminal = vi.fn();
    render(<DeviceWindow
      client={client}
      document={document}
      node={node}
      powerState="stopped"
      runtimeAvailable={false}
      onOpenTerminal={openTerminal}
      onConfigurationChanged={() => undefined}
      onError={() => undefined}
      onClose={() => undefined}
    />);

    const main = screen.getByRole("tablist", { name: "R1 sections" });
    expect(within(main).getAllByRole("tab")).toHaveLength(5);
    await userEvent.click(within(main).getByRole("tab", { name: "Config" }));
    const config = screen.getByRole("navigation", { name: "Configuration sections" });
    await userEvent.click(within(config).getByRole("button", { name: "Console Access" }));
    expect(screen.getByText("Config · Console Access")).toBeTruthy();

    await userEvent.click(within(main).getByRole("tab", { name: "Monitor" }));
    expect(within(screen.getByRole("navigation", { name: "Monitor sections" })).getByRole("button", { name: "Sessions" })).toBeTruthy();
    await userEvent.click(within(main).getByRole("tab", { name: "CLI" }));
    expect(screen.getByText(/Start the lab to open this tool/)).toBeTruthy();
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it("changes switch hardware from Attributes only while the lab is stopped", async () => {
    const node: LabUiNode = {
      id: "switch-1",
      type: "l2-switch",
      hostname: "SW1",
      position: { x: 0, y: 0 },
      status: "down",
      interfaces: Array.from({ length: 8 }, (_, index) => ({
        id: `Gi0/${index + 1}`,
        adminUp: true,
        operationalUp: false,
      })),
    };
    const document: LabDocument = {
      schemaVersion: 1,
      id: "switch-hardware",
      title: "Switch hardware",
      simulation: { seed: 1 },
      topology: {
        schemaVersion: 1,
        nodes: [{ id: node.id, kind: node.type, hardwareProfileId: "compact-8", interfaces: node.interfaces.map(({ id }) => ({ id })) }],
        links: [],
      },
      configurations: { [node.id]: { kind: "l2-switch", hostname: "SW1", interfaces: [], vlans: [] } },
    };
    const onTopologyChanged = vi.fn();
    render(<DeviceWindow
      client={{ request: vi.fn(), onEvent: vi.fn(() => () => undefined) } as unknown as SimulatorClient}
      document={document}
      node={node}
      powerState="stopped"
      runtimeAvailable={false}
      onOpenTerminal={() => undefined}
      onConfigurationChanged={() => undefined}
      onTopologyChanged={onTopologyChanged}
      onError={() => undefined}
      onClose={() => undefined}
    />);
    await userEvent.click(screen.getByRole("tab", { name: "Attributes" }));
    await userEvent.selectOptions(screen.getByLabelText("Hardware profile"), "access-24");
    expect(onTopologyChanged).toHaveBeenCalledWith(expect.objectContaining({
      topology: expect.objectContaining({
        nodes: [expect.objectContaining({ hardwareProfileId: "access-24", interfaces: expect.any(Array) })],
      }),
    }));
    expect(onTopologyChanged.mock.calls[0]?.[0].topology.nodes[0]?.interfaces).toHaveLength(26);
  });
});
