import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { createSimulationWorkerRuntime, type SimWorkerRequest, type VxlanEvpnView } from "../src";

/**
 * M10.16 — the multihoming worker contract.
 *
 * Only the shape of the view is tested here: every request answers with plain
 * JSON, and the tables it carries are runtime. The election itself belongs to
 * sim-core and is not re-run through the worker.
 */

const ESI = "0000:0000:0000:0000:0001";

const MULTIHOMING_REQUESTS = [
  "GET_EVPN_ETHERNET_SEGMENTS",
  "GET_EVPN_ES_PEERS",
  "GET_EVPN_DF_STATE",
  "GET_EVPN_AD_ROUTES",
  "GET_EVPN_ES_ROUTES",
  "GET_EVPN_MULTIHOMING_PATHS",
] as const;

/**
 * Two leaves sharing one CE, a spine reflector and a remote leaf. `10 mod 2`
 * puts the numerically lowest VTEP — LEAF1 — in the Designated Forwarder role.
 */
function multihomedDocument(): LabDocument {
  const leaf = (id: string, name: string, loopback: string, uplink: string, segment: boolean) => ({
    kind: "l3-switch" as const,
    hostname: name,
    vlans: [{ id: 10, name: "TENANT-A" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access" as const, accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "routed" as const, ipv4: { address: uplink, prefixLength: 30 } },
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: loopback, prefixLength: 32 } }],
    ospf: {
      processId: 1,
      routerId: loopback,
      networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
      passiveInterfaces: ["Loopback0"],
      interfaces: [{ interfaceId: "Gi0/2", networkType: "point-to-point" as const }],
    },
    bgp: {
      localAs: 65_000,
      routerId: loopback,
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
    nve: {
      id: "nve1" as const,
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" as const } }],
    },
    evpn: {
      vnis: [{
        vni: 10_010,
        routeDistinguisher: "65000:10010",
        importRouteTargets: ["65000:10010"],
        exportRouteTargets: ["65000:10010"],
      }],
      ...(segment
        ? { ethernetSegments: [{ id: "ES-CE1", esi: ESI, redundancyMode: "single-active" as const, interfaces: ["Gi0/1"] }] }
        : {}),
    },
  });
  return {
    schemaVersion: 1,
    id: "evpn-multihoming-worker",
    title: "EVPN multihoming worker contract",
    simulation: { seed: 11_163 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "ce", kind: "l2-switch", name: "CE", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "leaf2", kind: "l3-switch", name: "LEAF2", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "spine", kind: "router", name: "SPINE", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [
        { id: "ce-leaf1", a: { node: "ce", iface: "Gi0/1" }, b: { node: "leaf1", iface: "Gi0/1" } },
        { id: "ce-leaf2", a: { node: "ce", iface: "Gi0/2" }, b: { node: "leaf2", iface: "Gi0/1" } },
        { id: "leaf1-spine", a: { node: "leaf1", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/0" } },
        { id: "leaf2-spine", a: { node: "leaf2", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/1" } },
      ],
    },
    configurations: {
      ce: {
        kind: "l2-switch",
        hostname: "CE",
        vlans: [{ id: 10, name: "TENANT-A" }],
        interfaces: ["Gi0/1", "Gi0/2"].map((id) => ({
          id, shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1,
        })),
      },
      leaf1: leaf("leaf1", "LEAF1", "10.255.0.1", "192.0.2.1", true),
      leaf2: leaf("leaf2", "LEAF2", "10.255.0.2", "192.0.2.5", true),
      spine: {
        kind: "router",
        hostname: "SPINE",
        interfaces: [
          { id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } },
          { id: "Gi0/1", routed: true, shutdown: false, ipv4: { address: "192.0.2.6", prefixLength: 30 } },
        ],
        subinterfaces: [],
        staticRoutes: [],
        dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
        ospf: {
          processId: 1,
          routerId: "10.255.0.9",
          networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 as const }],
          passiveInterfaces: ["Loopback0"],
          interfaces: [
            { interfaceId: "Gi0/0", networkType: "point-to-point" as const },
            { interfaceId: "Gi0/1", networkType: "point-to-point" as const },
          ],
        },
        bgp: {
          localAs: 65_000,
          routerId: "10.255.0.9",
          clusterId: "10.255.0.9",
          networks: [],
          vrfAddressFamilies: [],
          neighbors: ["10.255.0.1", "10.255.0.2"].map((address) => ({
            address,
            remoteAs: 65_000,
            updateSource: "Loopback0",
            evpnActivated: true,
            sendCommunityExtended: true,
            routeReflectorClient: true,
          })),
        },
      },
    },
  } as unknown as LabDocument;
}

function open() {
  const runtime = createSimulationWorkerRuntime(() => undefined);
  let id = 0;
  const request = <Type extends SimWorkerRequest["type"]>(
    input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
  ) => {
    const response = runtime.handleRequest({ ...input, requestId: `mh-${++id}` } as SimWorkerRequest);
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload;
  };
  request({ type: "INITIALIZE_LAB", document: canonicalizeLabDocument(multihomedDocument()) } as never);
  return { request };
}

describe("EVPN multihoming worker requests", () => {
  it("answers every multihoming inspection with one plain-JSON view", () => {
    const { request } = open();
    for (const type of MULTIHOMING_REQUESTS) {
      const view = request({ type, deviceId: "leaf1" } as never) as VxlanEvpnView;
      expect(view.deviceId).toBe("leaf1");
      expect(Array.isArray(view.ethernetSegments)).toBe(true);
      expect(Array.isArray(view.ethernetSegmentPeers)).toBe(true);
      expect(Array.isArray(view.designatedForwarders)).toBe(true);
      expect(Array.isArray(view.multihomingPaths)).toBe(true);
      // Plain JSON only: no Map, Set, class instance or engine object.
      expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    }
    // A device that is not a VTEP is refused rather than answered emptily.
    expect(() => request({ type: "GET_EVPN_DF_STATE", deviceId: "spine" } as never))
      .toThrow(/not a VXLAN tunnel endpoint/);
  });

  it("exposes the segment, the elected forwarder and the standby leaf", () => {
    const { request } = open();
    const leaf1 = request({ type: "GET_EVPN_ETHERNET_SEGMENTS", deviceId: "leaf1" } as never) as VxlanEvpnView;
    expect(leaf1.ethernetSegments).toEqual([expect.objectContaining({
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
      up: true,
    })]);
    expect(leaf1.designatedForwarders).toEqual([expect.objectContaining({
      esi: ESI,
      vlanId: 10,
      designatedForwarder: "10.255.0.1",
      localRole: "df",
    })]);
    const leaf2 = request({ type: "GET_EVPN_DF_STATE", deviceId: "leaf2" } as never) as VxlanEvpnView;
    expect(leaf2.designatedForwarders[0]).toMatchObject({ localRole: "non-df" });
    // Both leaves see one another on the shared segment.
    expect(leaf1.ethernetSegmentPeers.map((peer) => peer.vtep).sort())
      .toEqual(["10.255.0.1", "10.255.0.2"]);
  });
});
