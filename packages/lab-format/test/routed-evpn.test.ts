import type { LabDocument, Layer3SwitchDeviceConfig } from "@sim/contracts";
import { canonicalizeLabDocument, parseLabDocument, validateLabSemantics } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

/**
 * M10.15.1 — semantic validation of the routed overlay.
 *
 * A distributed anycast gateway is deliberately *not* a duplicate: every leaf
 * presenting the same tenant gateway IP and MAC is the whole point, so only an
 * incomplete configuration is rejected.
 */

const ANYCAST_MAC = "02:00:00:ff:00:01";

function baseDocument(): LabDocument {
  return {
    schemaVersion: 1,
    id: "routed-evpn-semantics",
    title: "Routed EVPN semantics",
    simulation: { seed: 11_151 },
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
        vlans: [{ id: 10, name: "TENANT-A-WEB" }],
        interfaces: [
          { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
          { id: "Gi0/2", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 30 } },
        ],
        svis: [
          { vlanId: 10, ipAddress: "10.10.10.1", prefixLength: 24, adminUp: true, vrfId: "TENANT-A", anycastGateway: true },
        ],
        vrfs: [{
          id: "TENANT-A",
          name: "TENANT-A",
          routeDistinguisher: "65000:50001",
          importRouteTargets: ["65000:50001"],
          exportRouteTargets: ["65000:50001"],
          staticRoutes: [],
          advertiseEvpn: true,
        }],
        staticRoutes: [],
        ipRoutingEnabled: true,
        acls: [],
        aclBindings: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
        nve: {
          id: "nve1",
          sourceInterfaceId: "Loopback0",
          shutdown: false,
          members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
          vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
        },
        evpn: {
          vnis: [{
            vni: 10_010,
            routeDistinguisher: "65000:10010",
            importRouteTargets: ["65000:10010"],
            exportRouteTargets: ["65000:10010"],
          }],
          anycastGatewayMac: ANYCAST_MAC,
        },
        bgp: {
          localAs: 65_000,
          routerId: "10.255.0.1",
          networks: [],
          vrfAddressFamilies: [],
          neighbors: [{
            address: "10.255.0.9",
            remoteAs: 65_000,
            updateSource: "Loopback0",
            evpnActivated: true,
            sendCommunityExtended: true,
          }],
        },
      } as unknown as Layer3SwitchDeviceConfig,
    },
  } as unknown as LabDocument;
}

function withLeaf(mutate: (config: Layer3SwitchDeviceConfig) => void): LabDocument {
  const document = baseDocument();
  mutate(document.configurations.leaf1 as Layer3SwitchDeviceConfig);
  return document;
}

describe("routed EVPN semantic validation", () => {
  it("accepts a complete anycast gateway, tenant VRF and L3VNI", () => {
    expect(() => validateLabSemantics(canonicalizeLabDocument(baseDocument()))).not.toThrow();
  });

  it("never treats a distributed gateway shared by two leaves as a duplicate", () => {
    const document = baseDocument();
    document.topology.nodes.push({
      id: "leaf2", kind: "l3-switch", name: "LEAF2", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
    } as never);
    // The very same gateway address and the very same fabric MAC, on purpose.
    const leaf2 = JSON.parse(JSON.stringify(document.configurations.leaf1)) as Layer3SwitchDeviceConfig;
    leaf2.hostname = "LEAF2";
    (leaf2 as { loopbacks?: unknown }).loopbacks = [
      { id: 0, shutdown: false, ipv4: { address: "10.255.0.2", prefixLength: 32 } },
    ];
    (leaf2.interfaces[1] as { ipv4?: unknown }).ipv4 = { address: "192.0.2.5", prefixLength: 30 };
    document.configurations.leaf2 = leaf2;
    expect(() => validateLabSemantics(canonicalizeLabDocument(document))).not.toThrow();
  });

  it("rejects every incomplete routed-EVPN configuration with a typed code", () => {
    const cases: ReadonlyArray<[string, string, (config: Layer3SwitchDeviceConfig) => void]> = [
      ["an anycast SVI with no fabric MAC", "anycast-gateway-mac-missing", (leaf) => {
        delete leaf.evpn!.anycastGatewayMac;
      }],
      ["an anycast SVI with no address to answer for", "anycast-gateway-without-address", (leaf) => {
        delete leaf.svis[0]!.ipAddress;
        delete leaf.svis[0]!.prefixLength;
      }],
      ["an SVI in a VRF that does not exist", "unknown-vrf", (leaf) => {
        leaf.svis[0]!.vrfId = "TENANT-Z";
      }],
      ["an L3VNI naming a VRF that does not exist", "unknown-vrf", (leaf) => {
        leaf.nve!.vrfMembers = [{ vni: 50_001, vrfId: "TENANT-Z" }];
      }],
      ["one VRF with two L3VNIs", "duplicate-vrf-l3vni", (leaf) => {
        leaf.nve!.vrfMembers = [
          { vni: 50_001, vrfId: "TENANT-A" },
          { vni: 50_002, vrfId: "TENANT-A" },
        ];
      }],
      ["one L3VNI mapped twice", "duplicate-l3vni", (leaf) => {
        leaf.vrfs!.push({
          id: "TENANT-B",
          name: "TENANT-B",
          routeDistinguisher: "65000:50002",
          importRouteTargets: ["65000:50002"],
          exportRouteTargets: ["65000:50002"],
          staticRoutes: [],
        });
        leaf.nve!.vrfMembers = [
          { vni: 50_001, vrfId: "TENANT-A" },
          { vni: 50_001, vrfId: "TENANT-B" },
        ];
      }],
      ["a VNI that is both bridged and routed", "vni-bridged-and-routed", (leaf) => {
        leaf.nve!.vrfMembers = [{ vni: 10_010, vrfId: "TENANT-A" }];
      }],
      ["advertise l2vpn evpn with no L3VNI", "advertise-evpn-without-l3vni", (leaf) => {
        delete leaf.nve!.vrfMembers;
      }],
      ["advertise l2vpn evpn with no export route target", "advertise-evpn-without-route-target", (leaf) => {
        leaf.vrfs![0]!.exportRouteTargets = [];
      }],
      ["advertise l2vpn evpn with no EVPN address family", "evpn-address-family-inactive", (leaf) => {
        leaf.nve!.members = [];
        leaf.bgp!.neighbors[0]!.evpnActivated = false;
      }],
      ["two VRFs sharing one route distinguisher", "duplicate-id", (leaf) => {
        leaf.vrfs!.push({
          id: "TENANT-B",
          name: "TENANT-B",
          routeDistinguisher: "65000:50001",
          importRouteTargets: ["65000:50002"],
          exportRouteTargets: ["65000:50002"],
          staticRoutes: [],
        });
      }],
      ["a VRF static route whose next hop no SVI reaches", "unreachable-vrf-next-hop", (leaf) => {
        leaf.vrfs![0]!.staticRoutes = [{ network: "172.16.9.0", prefixLength: 24, nextHop: "192.168.44.9" }];
      }],
      ["an IPv6 address family on an L3 Switch tenant", "vrf-ipv6-unsupported", (leaf) => {
        leaf.vrfs![0]!.addressFamilyIpv6 = true;
      }],
    ];
    for (const [label, code, mutate] of cases) {
      let thrown: unknown;
      try { validateLabSemantics(withLeaf(mutate)); } catch (error) { thrown = error; }
      expect(thrown, `expected ${label} to be rejected`).toMatchObject({ code });
    }
  });

  it("bounds the number of L3VNIs a VTEP may carry", () => {
    const document = withLeaf((leaf) => {
      leaf.vrfs = [];
      leaf.nve!.vrfMembers = [];
      for (let index = 0; index < 65; index++) {
        leaf.vrfs.push({
          id: `T${index}`,
          name: `T${index}`,
          routeDistinguisher: `65000:${60_000 + index}`,
          importRouteTargets: [`65000:${60_000 + index}`],
          exportRouteTargets: [`65000:${60_000 + index}`],
          staticRoutes: [],
        });
        leaf.nve!.vrfMembers.push({ vni: 60_000 + index, vrfId: `T${index}` });
      }
      leaf.svis = [];
      delete leaf.evpn!.anycastGatewayMac;
    });
    let thrown: unknown;
    try { validateLabSemantics(document); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ code: "too-many-l3vnis" });
  });

  it("opens a pre-M10.15 lab unchanged: no VRF, no L3VNI, no fabric MAC", () => {
    const document = withLeaf((leaf) => {
      delete leaf.vrfs;
      delete leaf.nve!.vrfMembers;
      delete leaf.evpn!.anycastGatewayMac;
      leaf.svis = [];
    });
    expect(parseLabDocument(document).schemaVersion).toBe(1);
    const canonical = canonicalizeLabDocument(document).configurations.leaf1 as Layer3SwitchDeviceConfig;
    expect(canonical.vrfs).toBeUndefined();
    expect(canonical.nve!.vrfMembers).toBeUndefined();
    expect(canonical.evpn!.anycastGatewayMac).toBeUndefined();
    expect(() => validateLabSemantics(canonicalizeLabDocument(document))).not.toThrow();
  });
});
