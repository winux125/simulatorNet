import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { createSimulationWorkerRuntime, type SimWorkerRequest, type VxlanEvpnView } from "../src";

/**
 * M10.15.1 — the routed-EVPN worker contract.
 *
 * Every request answers with plain JSON: no Map, no Set, no class instance and
 * no engine object ever crosses the worker boundary. The tables themselves are
 * runtime and never reach a `LabDocument`.
 */

const ANYCAST_MAC = "02:00:00:ff:00:01";

function routedLeafDocument(): LabDocument {
  return {
    schemaVersion: 1,
    id: "routed-evpn-worker",
    title: "Routed EVPN worker contract",
    simulation: { seed: 11_152 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "host-a", kind: "pc", name: "HOST-A", interfaces: [{ id: "eth0" }] },
        { id: "leaf1", kind: "l3-switch", name: "LEAF1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "spine", kind: "router", name: "SPINE", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [
        // The tenant SVI is up only while its VLAN has a live member port, so
        // the host is what makes the gateway operational.
        { id: "host-a-leaf1", a: { node: "host-a", iface: "eth0" }, b: { node: "leaf1", iface: "Gi0/1" } },
        { id: "leaf1-spine", a: { node: "leaf1", iface: "Gi0/2" }, b: { node: "spine", iface: "Gi0/0" } },
      ],
    },
    configurations: {
      "host-a": {
        kind: "pc",
        hostname: "HOST-A",
        interfaces: [],
        ipv4: { address: "10.10.10.10", prefixLength: 24, defaultGateway: "10.10.10.1" },
        dhcpEnabled: false,
      },
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
        staticRoutes: [{ network: "10.255.0.9", prefixLength: 32, nextHop: "192.0.2.2" }],
        ipRoutingEnabled: true,
        acls: [],
        aclBindings: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
        nve: {
          id: "nve1",
          sourceInterfaceId: "Loopback0",
          shutdown: false,
          members: [],
          vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
        },
        evpn: { vnis: [], anycastGatewayMac: ANYCAST_MAC },
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
      },
      spine: {
        kind: "router",
        hostname: "SPINE",
        interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "192.0.2.2", prefixLength: 30 } }],
        subinterfaces: [],
        staticRoutes: [{ network: "10.255.0.1", prefixLength: 32, nextHop: "192.0.2.1" }],
        dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
        loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.9", prefixLength: 32 } }],
        bgp: {
          localAs: 65_000,
          routerId: "10.255.0.9",
          clusterId: "10.255.0.9",
          networks: [],
          vrfAddressFamilies: [],
          neighbors: [{
            address: "10.255.0.1",
            remoteAs: 65_000,
            updateSource: "Loopback0",
            evpnActivated: true,
            sendCommunityExtended: true,
            routeReflectorClient: true,
          }],
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
    const response = runtime.handleRequest({ ...input, requestId: `routed-${++id}` } as SimWorkerRequest);
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload;
  };
  request({ type: "INITIALIZE_LAB", document: canonicalizeLabDocument(routedLeafDocument()) } as never);
  return { runtime, request };
}

const ROUTED_REQUESTS = [
  "GET_EVPN_ANYCAST_GATEWAYS",
  "GET_EVPN_L3VNIS",
  "GET_EVPN_TYPE5_ROUTES",
  "GET_EVPN_VRF_ROUTES",
  "GET_EVPN_ROUTED_OVERLAY_STATUS",
] as const;

describe("routed EVPN worker requests", () => {
  it("answers every routed inspection with one plain-JSON view", () => {
    const { request } = open();
    for (const type of ROUTED_REQUESTS) {
      const view = request({ type, deviceId: "leaf1" } as never) as VxlanEvpnView;
      expect(view.deviceId).toBe("leaf1");
      // Structured cloning is the real worker boundary: a Map, a Set or a class
      // instance would not survive it, and JSON round-tripping proves it does.
      expect(JSON.parse(JSON.stringify(view))).toEqual(view);
      expect(JSON.stringify(view)).not.toMatch(/\[object |"__proto__"/u);
    }
  });

  it("reports the distributed gateway, its fabric MAC and the SVI it lives on", () => {
    const { request } = open();
    const view = request({ type: "GET_EVPN_ANYCAST_GATEWAYS", deviceId: "leaf1" } as never) as VxlanEvpnView;
    expect(view.fabricAnycastGatewayMac).toBe(ANYCAST_MAC);
    expect(view.anycastGateways).toEqual([{
      vlanId: 10,
      interfaceId: "Vlan10",
      macAddress: ANYCAST_MAC,
      ipAddress: "10.10.10.1",
      prefixLength: 24,
      vrfId: "TENANT-A",
      adminUp: true,
      up: true,
    }]);
  });

  it("reports the L3VNI with its tenant RD, route targets and origination policy", () => {
    const { request } = open();
    const view = request({ type: "GET_EVPN_L3VNIS", deviceId: "leaf1" } as never) as VxlanEvpnView;
    expect(view.l3Vnis).toEqual([expect.objectContaining({
      vni: 50_001,
      vrfId: "TENANT-A",
      up: true,
      routeDistinguisher: "65000:50001",
      importRouteTargets: ["65000:50001"],
      exportRouteTargets: ["65000:50001"],
      advertiseEvpn: true,
    })]);
    // The tenant's connected SVI prefix is originated as a Type 5 route.
    expect(view.l3Vnis[0]!.originatedPrefixCount).toBeGreaterThan(0);
    const type5 = view.evpnRoutes.filter((route) => route.type === 5);
    expect(type5.map((route) => `${route.network}/${route.prefixLength}`)).toContain("10.10.10.0/24");
  });

  it("reports the tenant VRF table and a derived routed-overlay status", () => {
    const { request } = open();
    const view = request({ type: "GET_EVPN_VRF_ROUTES", deviceId: "leaf1" } as never) as VxlanEvpnView;
    expect(view.vrfRoutes).toEqual([expect.objectContaining({
      vrfId: "TENANT-A",
      network: "10.10.10.0",
      prefixLength: 24,
      source: "connected",
    })]);
    expect(view.routedOverlay).toEqual(expect.objectContaining({
      l3VniCount: 1,
      operationalL3VniCount: 1,
      anycastGatewayCount: 1,
      importedPrefixCount: 0,
    }));
    expect(view.routedOverlay.reasons).toEqual([]);
  });

  it("clears routed runtime and restarts one L3VNI without touching configuration", () => {
    const { request } = open();
    const cleared = request({ type: "CLEAR_EVPN_ROUTED_RUNTIME", deviceId: "leaf1" } as never) as VxlanEvpnView;
    // Configuration survives: the L3VNI, its VRF and the gateway are untouched.
    expect(cleared.l3Vnis.map((entry) => entry.vni)).toEqual([50_001]);
    expect(cleared.fabricAnycastGatewayMac).toBe(ANYCAST_MAC);

    const restarted = request({ type: "RESTART_EVPN_L3VNI", deviceId: "leaf1", vni: 50_001 } as never) as VxlanEvpnView;
    expect(restarted.l3Vnis[0]).toEqual(expect.objectContaining({ vni: 50_001, up: true, advertiseEvpn: true }));
  });

  it("refuses to restart a VNI that is not an L3VNI, and a device that is not a VTEP", () => {
    const { runtime } = open();
    const bad = runtime.handleRequest({ type: "RESTART_EVPN_L3VNI", requestId: "x1", deviceId: "leaf1", vni: 99_999 });
    expect(bad.type).toBe("REQUEST_FAILED");
    const notAVtep = runtime.handleRequest({ type: "GET_EVPN_L3VNIS", requestId: "x2", deviceId: "spine" });
    expect(notAVtep.type).toBe("REQUEST_FAILED");
  });
});
