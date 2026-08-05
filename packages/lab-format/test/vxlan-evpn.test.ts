import type { LabDocument, Layer3SwitchDeviceConfig } from "@sim/contracts";
import { canonicalizeLabDocument, parseLabDocument, validateLabSemantics } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

function baseDocument(): LabDocument {
  return {
    schemaVersion: 1,
    id: "vxlan-semantics",
    title: "VXLAN semantics",
    simulation: { seed: 11_143 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
      ],
      links: [],
    },
    configurations: {
      leaf1: {
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
        acls: [],
        aclBindings: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
        nve: {
          id: "nve1",
          sourceInterfaceId: "Loopback0",
          shutdown: false,
          members: [{ vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: ["10.255.0.2"] } }],
        },
      } as Layer3SwitchDeviceConfig,
    },
  } as unknown as LabDocument;
}

/** Apply a targeted edit to the one L3 Switch and revalidate. */
function withLeaf(mutate: (config: Layer3SwitchDeviceConfig) => void): LabDocument {
  const document = baseDocument();
  const leaf = document.configurations.leaf1 as Layer3SwitchDeviceConfig;
  mutate(leaf);
  return document;
}

describe("VXLAN and EVPN semantic validation", () => {
  it("accepts a valid VTEP and canonicalizes its members, peers and route targets", () => {
    const document = withLeaf((leaf) => {
      leaf.nve!.members = [
        { vni: 10_020, vlanId: 20, replication: { type: "static", peerAddresses: ["10.255.0.4", "10.255.0.2", "10.255.0.2"] } },
        { vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: ["10.255.0.3"] } },
      ];
      leaf.vlans = [{ id: 10, name: "TENANT-A" }, { id: 20, name: "TENANT-B" }];
      leaf.evpn = {
        vnis: [{
          vni: 10_010,
          routeDistinguisher: "65000:10010",
          importRouteTargets: ["65000:10011", "65000:10010", "65000:10010"],
          exportRouteTargets: ["65000:10010"],
        }],
      };
    });
    expect(() => validateLabSemantics(canonicalizeLabDocument(document))).not.toThrow();

    const canonical = canonicalizeLabDocument(document).configurations.leaf1 as Layer3SwitchDeviceConfig;
    // Members order by VNI, peers by address, route targets deduplicate and
    // sort — so an identical overlay always serializes to identical bytes.
    expect(canonical.nve!.members.map((member) => member.vni)).toEqual([10_010, 10_020]);
    expect(canonical.nve!.members[1]!.replication).toEqual({
      type: "static",
      peerAddresses: ["10.255.0.2", "10.255.0.4"],
    });
    expect(canonical.evpn!.vnis[0]!.importRouteTargets).toEqual(["65000:10010", "65000:10011"]);
  });

  it("rejects every unsafe VTEP configuration with a typed code", () => {
    const cases: ReadonlyArray<[string, string, (config: Layer3SwitchDeviceConfig) => void]> = [
      ["a source that is not a Loopback", "invalid-nve-source", (leaf) => { leaf.nve!.sourceInterfaceId = "Gi0/2"; }],
      ["a source Loopback that does not exist", "invalid-nve-source", (leaf) => { leaf.nve!.sourceInterfaceId = "Loopback9"; }],
      ["a VLAN that is not in the database", "unknown-vni-vlan", (leaf) => { leaf.nve!.members[0]!.vlanId = 99; }],
      ["one VLAN mapped to two VNIs", "duplicate-vlan-vni-mapping", (leaf) => {
        leaf.nve!.members = [
          { vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: [] } },
          { vni: 10_011, vlanId: 10, replication: { type: "static", peerAddresses: [] } },
        ];
      }],
      ["this switch's own address as a remote peer", "local-vtep-peer", (leaf) => {
        leaf.nve!.members[0]!.replication = { type: "static", peerAddresses: ["10.255.0.1"] };
      }],
      ["BGP EVPN replication with no evpn block", "evpn-vni-not-defined", (leaf) => {
        leaf.nve!.members[0]!.replication = { type: "bgp-evpn" };
      }],
      ["BGP EVPN replication with no activated neighbor", "evpn-address-family-inactive", (leaf) => {
        leaf.nve!.members[0]!.replication = { type: "bgp-evpn" };
        leaf.evpn = {
          vnis: [{ vni: 10_010, routeDistinguisher: "65000:10010", importRouteTargets: ["65000:10010"], exportRouteTargets: ["65000:10010"] }],
        };
      }],
      ["an EVPN neighbor without send-community extended", "evpn-extended-community-required", (leaf) => {
        leaf.nve!.members[0]!.replication = { type: "bgp-evpn" };
        leaf.evpn = {
          vnis: [{ vni: 10_010, routeDistinguisher: "65000:10010", importRouteTargets: ["65000:10010"], exportRouteTargets: ["65000:10010"] }],
        };
        leaf.bgp = {
          localAs: 65_000,
          neighbors: [{ address: "10.255.0.2", remoteAs: 65_000, evpnActivated: true }],
          networks: [],
          vrfAddressFamilies: [],
        };
      }],
      ["an EVPN VNI with no route target at all", "evpn-vni-without-route-target", (leaf) => {
        leaf.evpn = {
          vnis: [{ vni: 10_010, routeDistinguisher: "65000:10010", importRouteTargets: [], exportRouteTargets: [] }],
        };
      }],
    ];
    for (const [label, code, mutate] of cases) {
      // Validate the raw document: canonicalization parses, and parsing already
      // validates, so an unsafe document never reaches a canonical form.
      let thrown: unknown;
      try { validateLabSemantics(withLeaf(mutate)); } catch (error) { thrown = error; }
      expect(thrown, `expected ${label} to be rejected`).toMatchObject({ code });
    }
  });

  it("opens a pre-M10.14 lab unchanged, with no overlay block and no migration", () => {
    const document = withLeaf((leaf) => { delete leaf.nve; });
    const parsed = parseLabDocument(document);
    expect(parsed.schemaVersion).toBe(1);
    const canonical = canonicalizeLabDocument(document).configurations.leaf1 as Layer3SwitchDeviceConfig;
    expect(canonical.nve).toBeUndefined();
    expect(canonical.evpn).toBeUndefined();
    expect(() => validateLabSemantics(canonicalizeLabDocument(document))).not.toThrow();
  });
});
