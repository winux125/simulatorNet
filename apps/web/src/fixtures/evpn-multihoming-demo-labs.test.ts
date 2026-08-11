import { renderDeviceConfiguration } from "@sim/device-config";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  EVPN_FAST_FAILOVER_DEMO,
  EVPN_MULTIHOMING_DEMO_LABS,
  EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO,
} from "./evpn-multihoming-demo-labs";
import { DEMO_LABS } from "./m10-demo-labs";

const ESI = "0000:0000:0000:0000:0001";
const VLAN = 10;
const VNI = 10_010;

function leafOf(document: typeof EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO, id: string) {
  const lab = buildLabFromDocument(document);
  lab.engine.runUntilIdle();
  const device = lab.getLayer3Switch(id);
  if (!device) throw new Error(`${id} is not an L3 Switch`);
  return device;
}

describe("M10.16 EVPN multihoming demo labs", () => {
  it("are canonical, valid schema-v1 labs and explicitly loadable", () => {
    for (const document of EVPN_MULTIHOMING_DEMO_LABS) {
      expect(parseLabDocument(document).schemaVersion).toBe(1);
      const canonical = canonicalizeLabDocument(document);
      expect(canonicalizeLabDocument(canonical)).toEqual(canonical);
      expect(DEMO_LABS.some((entry) => entry.id === document.id)).toBe(true);
      for (const heading of ["Objective:", "Topology:", "Required CLI:", "Troubleshooting:"]) {
        expect(document.instructions, `${document.id} should document ${heading}`).toContain(heading);
      }
      expect(document.expectedOutcome).toBeTruthy();
    }
  });

  it("serializes a converged fabric back to configuration only", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO));
    lab.engine.runUntilIdle();
    // Serializing a *converged* engine is the real test: by now the peers, the
    // DF result and the Type 1/4 routes all exist, and none of them may appear.
    const serialized = serializeLabDocument(lab, {
      id: EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO.id,
      title: EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO.title,
    });
    const leaf1 = serialized.configurations.leaf1!;
    if (leaf1.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(leaf1.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    const text = JSON.stringify(serialized);
    for (const forbidden of ["designatedForwarder", "backupVteps", "per-es", "per-evi", "candidates"]) {
      expect(text, `expected '${forbidden}' never to be serialized`).not.toContain(forbidden);
    }
  });

  it("renders and re-reads the segment through the running configuration", () => {
    const canonical = canonicalizeLabDocument(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO);
    const text = renderDeviceConfiguration(canonical.configurations.leaf1!);
    expect(text).toContain("evpn ethernet-segment ES-CE1");
    expect(text).toContain(` identifier ${ESI}`);
    expect(text).toContain(" redundancy-mode single-active");
    expect(text).toContain(" ethernet-segment ES-CE1");
  });

  it("persists the Ethernet Segment as configuration and nothing else", () => {
    const canonical = canonicalizeLabDocument(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO);
    for (const id of ["leaf1", "leaf2"]) {
      const config = canonical.configurations[id];
      expect(config?.kind).toBe("l3-switch");
      expect(config && "evpn" in config ? config.evpn?.ethernetSegments : undefined).toEqual([{
        id: "ES-CE1",
        esi: ESI,
        redundancyMode: "single-active",
        interfaces: ["Gi0/1"],
      }]);
    }
    // The remote leaf shares no CE, so it declares no segment at all.
    const remote = canonical.configurations.leaf3;
    expect(remote && "evpn" in remote ? remote.evpn?.ethernetSegments : undefined).toBeUndefined();
    // Nothing runtime is ever written: no peer, no DF, no A-D route, no path.
    const serialized = JSON.stringify(canonical);
    for (const forbidden of ["designatedForwarder", "backupVteps", "ethernetSegmentPeers", "per-evi"]) {
      expect(serialized, `expected '${forbidden}' never to be persisted`).not.toContain(forbidden);
    }
  });

  it("elects one Designated Forwarder and one standby leaf when built", () => {
    const leaf1 = leafOf(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO, "leaf1");
    const leaf2 = leafOf(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO, "leaf2");
    expect(leaf1.designatedForwarderStates()).toEqual([expect.objectContaining({
      esi: ESI,
      vlanId: VLAN,
      designatedForwarder: "10.255.0.1",
      localRole: "df",
    })]);
    expect(leaf2.designatedForwarderStates()[0]).toMatchObject({ localRole: "non-df" });
  });

  it("carries the same topology in both demos so the failover lab needs no rebuild", () => {
    expect(EVPN_FAST_FAILOVER_DEMO.topology).toEqual(EVPN_SINGLE_ACTIVE_MULTIHOMING_DEMO.topology);
    expect(EVPN_FAST_FAILOVER_DEMO.instructions).toMatch(/shutdown/);
    expect(EVPN_FAST_FAILOVER_DEMO.instructions).toMatch(/Troubleshooting/);
  });

  it("moves remote forwarding to the backup leaf when the DF attachment fails", () => {
    const lab = buildLabFromDocument(EVPN_FAST_FAILOVER_DEMO);
    lab.engine.runUntilIdle();
    const hostA = lab.getPc("host-a")!;
    const leaf1 = lab.getLayer3Switch("leaf1")!;
    const leaf3 = lab.getLayer3Switch("leaf3")!;

    hostA.ping("192.168.10.20", 1);
    lab.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);
    const before = leaf3.remoteMacEntries().find((row) => row.vni === VNI && row.ethernetSegmentId === ESI);
    expect(before).toMatchObject({ remoteVtep: "10.255.0.1", backupVteps: ["10.255.0.2"] });

    leaf1.interfaces.get("Gi0/1")!.shutdown();
    lab.engine.runUntilIdle();
    const after = leaf3.remoteMacEntries().find((row) => row.vni === VNI && row.ethernetSegmentId === ESI);
    expect(after?.remoteVtep).toBe("10.255.0.2");

    hostA.ping("192.168.10.20", 2);
    lab.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);
  });
});
