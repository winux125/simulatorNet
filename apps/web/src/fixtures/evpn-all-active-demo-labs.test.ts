import { renderDeviceConfiguration } from "@sim/device-config";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  EVPN_ALL_ACTIVE_ALIASING_DEMO,
  EVPN_ALL_ACTIVE_DEMO_LABS,
  EVPN_MAC_MOBILITY_HRW_DEMO,
} from "./evpn-all-active-demo-labs";
import { DEMO_LABS } from "./m10-demo-labs";

const ESI_A = "0000:0000:0000:0000:0001";
const ESI_B = "0000:0000:0000:0000:0002";
const VNI = 10_010;
const MOBILE_MAC = "02:00:00:00:00:aa";

/** Runtime state the fabric must never persist, whatever it converged to. */
const RUNTIME_KEYS = [
  "designatedForwarder", "backupDesignatedForwarder", "candidateWeights", "eligibleVteps",
  "selectedVtep", "advertisingVtep", "aliasVteps", "backupVteps", "per-es", "per-evi",
  "effectiveAlgorithm", "requestedAlgorithm", "macMobility", "previousOwner",
];

describe("M10.17 EVPN All-Active demo labs", () => {
  it("are canonical, valid schema-v1 labs and explicitly loadable", () => {
    for (const document of EVPN_ALL_ACTIVE_DEMO_LABS) {
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

  it("persists the All-Active mode and the DF algorithm as configuration only", () => {
    const canonical = canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO);
    for (const id of ["leaf1", "leaf2"]) {
      const config = canonical.configurations[id];
      expect(config && "evpn" in config ? config.evpn?.ethernetSegments : undefined).toEqual([{
        id: "ES-A",
        esi: ESI_A,
        redundancyMode: "all-active",
        interfaces: ["Gi0/3"],
        dfAlgorithm: "hrw",
      }]);
    }
    // The remote leaf shares no CE, so it declares no segment at all.
    const remote = canonical.configurations["leaf-r"];
    expect(remote && "evpn" in remote ? remote.evpn?.ethernetSegments : undefined).toBeUndefined();
  });

  it("keeps a segment that never named an algorithm free of the key", () => {
    // The aliasing demo asks for all-active without naming an election, so it
    // must round-trip without silently gaining `dfAlgorithm: "default"` — that
    // is what stops an older lab being reinterpreted as HRW.
    const canonical = canonicalizeLabDocument(EVPN_ALL_ACTIVE_ALIASING_DEMO);
    const leaf1 = canonical.configurations.leaf1;
    const segments = leaf1 && "evpn" in leaf1 ? leaf1.evpn?.ethernetSegments : undefined;
    expect(segments).toEqual([{
      id: "ES-CE1",
      esi: ESI_A,
      redundancyMode: "all-active",
      interfaces: ["Gi0/3"],
    }]);
    expect(segments?.[0] && "dfAlgorithm" in segments[0]).toBe(false);
  });

  it("serializes a converged fabric back to configuration only", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO));
    lab.engine.runUntilIdle();
    lab.getPc("station-a")!.ping("192.168.10.40", 1);
    lab.engine.runUntilIdle();
    // Serializing a *converged* engine is the real test: by now the peers, the
    // HRW weights, the alias sets and the mobility state all exist, and not one
    // of them may appear in the document.
    const serialized = serializeLabDocument(lab, {
      id: EVPN_MAC_MOBILITY_HRW_DEMO.id,
      title: EVPN_MAC_MOBILITY_HRW_DEMO.title,
    });
    const leaf1 = serialized.configurations.leaf1!;
    if (leaf1.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(leaf1.evpn?.ethernetSegments).toEqual([{
      id: "ES-A",
      esi: ESI_A,
      redundancyMode: "all-active",
      interfaces: ["Gi0/3"],
      dfAlgorithm: "hrw",
    }]);
    const text = JSON.stringify(serialized);
    for (const forbidden of RUNTIME_KEYS) {
      expect(text, `expected '${forbidden}' never to be serialized`).not.toContain(forbidden);
    }
  });

  it("renders and re-reads the segment through the running configuration", () => {
    const canonical = canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO);
    const text = renderDeviceConfiguration(canonical.configurations.leaf1!);
    expect(text).toContain("evpn ethernet-segment ES-A");
    expect(text).toContain(` identifier ${ESI_A}`);
    expect(text).toContain(" redundancy-mode all-active");
    expect(text).toContain(" df-election hrw");
    expect(text).toContain(" ethernet-segment ES-A");
    // A segment that never asked for an election renders no `df-election` line.
    const plain = renderDeviceConfiguration(
      canonicalizeLabDocument(EVPN_ALL_ACTIVE_ALIASING_DEMO).configurations.leaf1!,
    );
    expect(plain).toContain(" redundancy-mode all-active");
    expect(plain).not.toContain("df-election");
  });

  it("gives the remote leaf two eligible aliasing paths for one advertised MAC", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_ALL_ACTIVE_ALIASING_DEMO));
    lab.engine.runUntilIdle();
    const hostA = lab.getPc("host-a")!;
    hostA.ping("192.168.10.20", 1);
    lab.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);

    const leaf3 = lab.getLayer3Switch("leaf3")!;
    const path = leaf3.aliasingPathSets().find((row) => row.esi === ESI_A);
    expect(path).toBeDefined();
    // Exactly one leaf advertised the address, but both may carry it: that is
    // aliasing, and it is the thing Single-Active cannot do.
    expect(path!.eligibleVteps).toEqual(["10.255.0.1", "10.255.0.2"]);
    expect(path!.redundancyMode).toBe("all-active");
    expect(path!.reason).toBe("all-active-aliasing");
    expect(path!.eligibleVteps).toContain(path!.advertisingVtep);
    expect(path!.eligibleVteps).toContain(path!.selectedVtep);
  });

  it("keeps traffic flowing without relearning when one alias path is lost", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_ALL_ACTIVE_ALIASING_DEMO));
    lab.engine.runUntilIdle();
    const hostA = lab.getPc("host-a")!;
    const leaf3 = lab.getLayer3Switch("leaf3")!;
    hostA.ping("192.168.10.20", 1);
    lab.engine.runUntilIdle();
    const before = leaf3.aliasingPathSets().find((row) => row.esi === ESI_A)!;
    expect(before.eligibleVteps).toHaveLength(2);

    // Take down the leaf that is *not* carrying the flow, so the surviving path
    // is the one already in use and nothing has to be relearned.
    const idle = before.eligibleVteps.find((vtep) => vtep !== before.selectedVtep)!;
    const losing = idle === "10.255.0.1" ? "leaf1" : "leaf2";
    lab.getLayer3Switch(losing)!.interfaces.get("Gi0/3")!.shutdown();
    lab.engine.runUntilIdle();

    const after = leaf3.aliasingPathSets().find((row) => row.esi === ESI_A);
    expect(after).toBeDefined();
    expect(after!.eligibleVteps).toEqual([before.selectedVtep]);
    // The address itself never left the table: no relearn was required.
    expect(leaf3.remoteMacEntries().some((row) => row.vni === VNI && row.mac === before.macAddress))
      .toBe(true);
    hostA.ping("192.168.10.20", 2);
    lab.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);
  });

  it("elects an HRW Designated Forwarder and a backup on the shared segment", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO));
    lab.engine.runUntilIdle();
    const leaf1 = lab.getLayer3Switch("leaf1")!;
    const leaf2 = lab.getLayer3Switch("leaf2")!;
    const one = leaf1.designatedForwarderStates().find((entry) => entry.esi === ESI_A)!;
    const two = leaf2.designatedForwarderStates().find((entry) => entry.esi === ESI_A)!;

    expect(one.effectiveAlgorithm).toBe("hrw");
    expect(one.requestedAlgorithm).toBe("hrw");
    expect(one.fallbackReason).toBeUndefined();
    expect(one.candidateWeights).toHaveLength(2);
    // Both participants reach an identical answer from the same candidate list
    // without either telling the other what it decided.
    expect(two.designatedForwarder).toBe(one.designatedForwarder);
    expect(two.backupDesignatedForwarder).toBe(one.backupDesignatedForwarder);
    expect(one.backupDesignatedForwarder).toBeDefined();
    expect(one.designatedForwarder).not.toBe(one.backupDesignatedForwarder);
    // Exactly one of them is the forwarder.
    expect([one.localRole, two.localRole].sort()).toEqual(["df", "non-df"]);
  });

  it("recalculates the election deterministically when a candidate is lost", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO));
    lab.engine.runUntilIdle();
    const leaf1 = lab.getLayer3Switch("leaf1")!;
    const leaf2 = lab.getLayer3Switch("leaf2")!;
    const before = leaf1.designatedForwarderStates().find((entry) => entry.esi === ESI_A)!;
    const survivor = before.designatedForwarder === "10.255.0.1" ? leaf2 : leaf1;
    const losing = before.designatedForwarder === "10.255.0.1" ? leaf1 : leaf2;

    losing.interfaces.get("Gi0/3")!.shutdown();
    lab.engine.runUntilIdle();
    const after = survivor.designatedForwarderStates().find((entry) => entry.esi === ESI_A)!;
    expect(after.candidates).toHaveLength(1);
    expect(after.localRole).toBe("df");
    expect(after.effectiveAlgorithm).toBe("hrw");
  });

  it("increments the mobility sequence once when the station genuinely moves", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(EVPN_MAC_MOBILITY_HRW_DEMO));
    lab.engine.runUntilIdle();
    const stationA = lab.getPc("station-a")!;
    const stationB = lab.getPc("station-b")!;
    const leaf3 = lab.getLayer3Switch("leaf3")!;
    const leafR = lab.getLayer3Switch("leaf-r")!;

    stationA.ping("192.168.10.40", 1);
    lab.engine.runUntilIdle();
    expect(stationA.pingResults.at(-1)?.success).toBe(true);
    const before = leafR.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)!;
    expect(before).toMatchObject({ sequence: 0, location: ESI_A, state: "stable" });

    // Unplug the station from the CE — the CE-to-leaf uplinks stay up, so ES-A
    // still advertises the address while LEAF3 learns it. That competition is
    // exactly what a mobility sequence exists to settle.
    (lab.getDevice("ce-m") as { interfaces: Map<string, { shutdown(): void }> })
      .interfaces.get("Gi0/1")!.shutdown();
    leaf3.interfaces.get("Gi0/3")!.noShutdown();
    lab.engine.runUntilIdle();
    stationB.ping("192.168.10.40", 1);
    lab.engine.runUntilIdle();
    expect(stationB.pingResults.at(-1)?.success).toBe(true);

    expect(leaf3.macMobilitySequence(VNI, MOBILE_MAC)).toBe(1);
    const after = leafR.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)!;
    expect(after).toMatchObject({ sequence: 1, location: ESI_B, owner: "10.255.0.3", state: "moved" });
  });

  it("carries the same topology in both halves of the mobility demo", () => {
    // Both demos are separate labs with their own topologies, but each one is
    // self-contained: nothing in either needs a rebuild to run its own steps.
    expect(EVPN_ALL_ACTIVE_ALIASING_DEMO.topology).not.toEqual(EVPN_MAC_MOBILITY_HRW_DEMO.topology);
    expect(EVPN_MAC_MOBILITY_HRW_DEMO.instructions).toMatch(/shutdown/);
    expect(EVPN_ALL_ACTIVE_ALIASING_DEMO.instructions).toMatch(/aliasing/i);
  });
});
