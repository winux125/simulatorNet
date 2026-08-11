import type { LabDocument, Layer3SwitchDeviceConfig } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  validateLabSemantics,
} from "@sim/lab-format";
import { Layer3Switch } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * M10.16 persistence and semantics.
 *
 * Only the document boundary is tested here: what an Ethernet Segment stores,
 * what it must never store, and which mistakes stop a document loading at all.
 * The election and the failover are sim-core's, and are not re-run.
 */

const ESI = "0000:0000:0000:0000:0001";

function leafConfig(overrides: Partial<Layer3SwitchDeviceConfig> = {}): Layer3SwitchDeviceConfig {
  return {
    kind: "l3-switch",
    hostname: "LEAF1",
    vlans: [{ id: 10, name: "TENANT-A" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 30 } },
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
    nve: {
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: [] } }],
    },
    evpn: {
      vnis: [{
        vni: 10_010,
        routeDistinguisher: "65000:10010",
        importRouteTargets: ["65000:10010"],
        exportRouteTargets: ["65000:10010"],
      }],
      ethernetSegments: [{
        id: "ES-CE1",
        esi: ESI,
        redundancyMode: "single-active",
        interfaces: ["Gi0/1"],
      }],
    },
    ...overrides,
  } as Layer3SwitchDeviceConfig;
}

function labWith(config: Layer3SwitchDeviceConfig): LabDocument {
  return {
    schemaVersion: 1,
    id: "es-lab",
    title: "ES Lab",
    simulation: { seed: 3 },
    topology: {
      schemaVersion: 1,
      nodes: [{ id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] }],
      links: [],
    },
    configurations: { leaf1: config },
  } as unknown as LabDocument;
}

describe("EVPN Ethernet Segment persistence", () => {
  it("round-trips the segment and keeps a pre-M10.16 lab byte-identical", () => {
    const canonical = canonicalizeLabDocument(labWith(leafConfig()));
    const config = canonical.configurations.leaf1 as Layer3SwitchDeviceConfig;
    expect(config.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    expect(canonicalizeLabDocument(canonical)).toEqual(canonical);

    // A lab written before M10.16 gains no key at all.
    const legacy = leafConfig();
    const { ethernetSegments: _dropped, ...evpn } = legacy.evpn!;
    const older = canonicalizeLabDocument(labWith({ ...legacy, evpn }));
    expect(JSON.stringify(older)).not.toContain("ethernetSegments");
  });

  it("applies the segment to the engine and stores no runtime state", () => {
    const lab = buildLabFromDocument(canonicalizeLabDocument(labWith(leafConfig())));
    const leaf = lab.getDevice("leaf1") as Layer3Switch;
    expect(leaf.ethernetSegmentConfigurations()).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    // Nothing runtime crossed the boundary: no peer and no DF exist until the
    // control plane produces one.
    expect(leaf.ethernetSegmentPeers().filter((peer) => !peer.local)).toEqual([]);
  });

  it("reports the configuration mistakes that stop a document loading", () => {
    const validate = (config: Layer3SwitchDeviceConfig) =>
      () => validateLabSemantics(canonicalizeLabDocument(labWith(config)));
    const segmented = (interfaces: string[], extra: string[] = []) => leafConfig({
      evpn: {
        ...leafConfig().evpn!,
        ethernetSegments: [
          { id: "ES-A", esi: ESI, redundancyMode: "single-active", interfaces },
          ...extra.map((name) => ({
            id: "ES-B",
            esi: "0000:0000:0000:0000:0002",
            redundancyMode: "single-active" as const,
            interfaces: [name],
          })),
        ],
      },
    });

    // Two segments cannot claim one attachment.
    expect(validate(segmented(["Gi0/1"], ["Gi0/1"]))).toThrow(/already belongs to Ethernet Segment 'ES-A'/);
    // A routed core port has no CE hanging off it.
    expect(validate(segmented(["Gi0/2"]))).toThrow(/must be an access switchport/);
    // A Port-channel has no L3-Switch configuration block to bind it to.
    expect(validate(segmented(["Port-channel1"]))).toThrow(/is not an access switchport on this device/);
    // A segment on a VLAN that maps to no VNI transports nothing.
    expect(validate(leafConfig({ nve: undefined }))).toThrow(/maps to no VNI/);
    // The valid configuration still passes, so none of the above is over-broad.
    expect(validate(leafConfig())).not.toThrow();
  });

  it("loads a document whose peer disagrees, and leaves it to Problems", () => {
    // A leaf whose route targets do not match its peer's is perfectly loadable:
    // the segment simply never forms, which is a runtime diagnosis and not a
    // reason to refuse the whole lab.
    const mismatched = leafConfig({
      evpn: {
        vnis: [{
          vni: 10_010,
          routeDistinguisher: "65000:10010",
          importRouteTargets: ["65000:99999"],
          exportRouteTargets: ["65000:99999"],
        }],
        ethernetSegments: leafConfig().evpn!.ethernetSegments,
      },
    });
    expect(() => validateLabSemantics(canonicalizeLabDocument(labWith(mismatched)))).not.toThrow();
    const leaf = buildLabFromDocument(canonicalizeLabDocument(labWith(mismatched))).getDevice("leaf1") as Layer3Switch;
    expect(leaf.vxlanProblems().join("\n")).toMatch(/Ethernet Segment/);
  });
});
