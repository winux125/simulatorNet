import type { LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import {
  connectionInterfaceInventory,
  naturalInterfaceCompare,
} from "../topology/DeviceConnectionDialog";
import { addDraftDevice, withDeviceHardwareProfile } from "./document";

function emptyLab(): LabDocument {
  return {
    schemaVersion: 1,
    id: "hardware",
    title: "Hardware profiles",
    simulation: { seed: 9 },
    topology: { schemaVersion: 1, nodes: [], links: [] },
    configurations: {},
  };
}

describe("switch hardware profiles", () => {
  it("creates standard switch inventories through the add-device workflow", () => {
    const l2 = addDraftDevice(emptyLab(), "l2-switch", { x: 1, y: 2 }, "access-24");
    const l3 = addDraftDevice(l2, "l3-switch", { x: 3, y: 4 }, "multilayer-48");
    expect(l2.topology.nodes[0]).toMatchObject({ hardwareProfileId: "access-24" });
    expect(l2.topology.nodes[0]?.interfaces).toHaveLength(26);
    expect(l3.topology.nodes[1]).toMatchObject({ hardwareProfileId: "multilayer-48" });
    expect(l3.topology.nodes[1]?.interfaces).toHaveLength(52);
  });

  it("expands a chassis and rejects shrinking while removed ports are occupied", () => {
    const compact = addDraftDevice(emptyLab(), "l2-switch", undefined, "compact-8");
    const expanded = withDeviceHardwareProfile(compact, "switch-1", "access-24");
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    expect(expanded.document.topology.nodes[0]?.interfaces).toHaveLength(26);
    const pc = addDraftDevice(expanded.document, "pc");
    const linked: LabDocument = {
      ...pc,
      topology: {
        ...pc.topology,
        links: [{ id: "link-1", a: { node: "switch-1", iface: "Fa0/20" }, b: { node: "pc-1", iface: "eth0" } }],
      },
    };
    expect(withDeviceHardwareProfile(linked, "switch-1", "compact-8")).toEqual({
      ok: false,
      message: "Disconnect Fa0/20 before selecting a smaller hardware profile.",
    });
  });

  it("sorts interface names naturally and reports occupied peers", () => {
    expect(["Gi0/10", "Gi0/2", "Fa0/24", "Fa0/3"].sort(naturalInterfaceCompare)).toEqual([
      "Fa0/3", "Fa0/24", "Gi0/2", "Gi0/10",
    ]);
    const switchLab = addDraftDevice(emptyLab(), "l2-switch", undefined, "access-24");
    const withPc = addDraftDevice(switchLab, "pc");
    const linked: LabDocument = {
      ...withPc,
      topology: {
        ...withPc.topology,
        links: [{ id: "link-1", a: { node: "switch-1", iface: "Fa0/2" }, b: { node: "pc-1", iface: "eth0" } }],
      },
    };
    const inventory = connectionInterfaceInventory(linked, "switch-1");
    expect(inventory).toHaveLength(26);
    expect(inventory.find((entry) => entry.id === "Fa0/2")).toEqual({
      id: "Fa0/2",
      occupied: true,
      peer: "PC1 eth0",
    });
  });
});
