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
    // A Port-channel is bindable since M10.17, but only one this device has.
    expect(validate(segmented(["Port-channel1"]))).toThrow(/is not a switchport on this device/);
    // A segment on a VLAN that maps to no VNI transports nothing.
    expect(validate(leafConfig({ nve: undefined }))).toThrow(/maps to no VNI/);
    // The valid configuration still passes, so none of the above is over-broad.
    expect(validate(leafConfig())).not.toThrow();
  });

  it("binds a segment to a logical Port-channel and builds it", () => {
    // M10.17: the bundle survives a configuration round-trip, so it can finally
    // be named as an attachment. The members are not — the bundle is.
    const bundled = leafConfig({
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      ],
      etherChannels: [{
        channelId: 1,
        mode: "active",
        members: ["Gi0/1", "Gi0/2"],
        switchport: { mode: "access", accessVlan: 10, nativeVlan: 1 },
      }],
      evpn: {
        ...leafConfig().evpn!,
        ethernetSegments: [{
          id: "ES-CE1",
          esi: ESI,
          redundancyMode: "single-active",
          interfaces: ["Port-channel1"],
        }],
      },
    });
    expect(() => validateLabSemantics(canonicalizeLabDocument(labWith(bundled)))).not.toThrow();
    const leaf = buildLabFromDocument(canonicalizeLabDocument(labWith(bundled))).getDevice("leaf1") as Layer3Switch;
    expect(leaf.ethernetSegmentConfigurations()[0]?.interfaces).toEqual(["Port-channel1"]);
    // The member is not an attachment of its own: the bundle already is one.
    expect(leaf.ethernetSegmentIdOf("Gi0/1")).toBe(ESI);
    expect(() => validateLabSemantics(canonicalizeLabDocument(labWith(leafConfig({
      ...bundled,
      evpn: {
        ...bundled.evpn!,
        ethernetSegments: [{ id: "ES-CE1", esi: ESI, redundancyMode: "single-active", interfaces: ["Gi0/1"] }],
      },
    }))))).toThrow(/belongs to Port-channel1/);
  });

  it("accepts a trunk Port-channel and still refuses a trunk access port", () => {
    // A CE-facing bundle is normally VLAN-aware, and the election is already
    // per `<ESI, VLAN>`. A bare physical port stays the access port M10.16
    // defined, so the widening is exactly one attachment kind.
    const trunked = (mode: "access" | "trunk") => leafConfig({
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode, accessVlan: 10, nativeVlan: 10 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      ],
      etherChannels: mode === "trunk"
        ? [{
            channelId: 1,
            mode: "on" as const,
            members: ["Gi0/1"],
            switchport: { mode: "trunk" as const, accessVlan: 1, nativeVlan: 10, allowedVlans: [10] },
          }]
        : undefined,
      evpn: {
        ...leafConfig().evpn!,
        ethernetSegments: [{
          id: "ES-CE1",
          esi: ESI,
          redundancyMode: "single-active",
          interfaces: [mode === "trunk" ? "Port-channel1" : "Gi0/1"],
        }],
      },
    });
    expect(() => validateLabSemantics(canonicalizeLabDocument(labWith(trunked("trunk"))))).not.toThrow();
    const trunkPort = leafConfig({
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "trunk", accessVlan: 10, nativeVlan: 10 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      ],
    });
    expect(() => validateLabSemantics(canonicalizeLabDocument(labWith(trunkPort))))
      .toThrow(/must be an access switchport/);
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
