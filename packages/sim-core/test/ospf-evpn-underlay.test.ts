import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  Layer3Switch,
  macFromIndex,
  Pc,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";

/**
 * M10.17.1 — the fabric the convergence gap was found on.
 *
 * `ospf-convergence.test.ts` owns the protocol regression and deliberately
 * uses no EVPN at all. This is the integration guard on top of it: five leaves
 * and one spine, an OSPF area 0 underlay instead of static routes, and the
 * ordinary M10.14–M10.17 EVPN control plane above it. It exists because an
 * underlay hole is invisible in the EVPN tables — a Type 3 route can look
 * perfectly good while the VTEP it names has no route — so only the data plane
 * shows the fabric is broken.
 *
 * It re-runs the M10.17 behaviour rather than re-implementing any of it.
 */

const AS = 65_000;
const VNI = 10_010;
const VLAN = 10;
const SPINE_ID = "10.255.0.9";
const LEAF_COUNT = 5;

function vtep(leafIndex: number): string {
  return `10.255.0.${leafIndex + 1}`;
}

interface Fabric {
  readonly engine: SimulationEngine;
  readonly spine: Router;
  readonly leaves: readonly Layer3Switch[];
  readonly hosts: readonly Pc[];
}

/**
 *   Host1 — Leaf1 ┐
 *   Host2 — Leaf2 ┤
 *   Host3 — Leaf3 ├── Spine (underlay + EVPN route reflector)
 *   Host4 — Leaf4 ┤
 *   Host5 — Leaf5 ┘
 *
 * Every leaf is a VTEP on `10.255.0.<n>/32`, reachable only through OSPF.
 */
function buildFabric(): Fabric {
  const engine = createSimulationEngine({ seed: 10_171 });
  const spine = engine.add(new Router("spine", "Spine"));
  spine.getOrCreateLoopback(0);
  spine.setInterfaceIp("Loopback0", SPINE_ID, 32);

  const leaves: Layer3Switch[] = [];
  const hosts: Pc[] = [];
  for (let index = 0; index < LEAF_COUNT; index++) {
    const number = index + 1;
    const leaf = engine.add(new Layer3Switch(`leaf${number}`, `Leaf${number}`));
    leaf.addInterface("Gi0/1", macFromIndex(100 + number * 10));
    leaf.addInterface("Gi0/2", macFromIndex(101 + number * 10));
    const host = engine.add(new Pc(`host${number}`, `Host${number}`));
    host.addInterface("eth0", macFromIndex(200 + number));
    host.configure({ ip: `10.10.10.${10 + number}`, mask: 24 });
    engine.connect(`host${number}`, "eth0", `leaf${number}`, "Gi0/1");

    spine.addInterface(`Gi0/${index}`, macFromIndex(1 + index));
    spine.configureInterface(`Gi0/${index}`, { ip: `192.0.2.${index * 4 + 2}`, mask: 30 });
    engine.connect("spine", `Gi0/${index}`, `leaf${number}`, "Gi0/2");

    leaf.defineVlan(VLAN);
    leaf.setAccess("Gi0/1", VLAN);
    leaf.setIpRouting(true);
    leaf.getOrCreateLoopback(0);
    leaf.setInterfaceIp("Loopback0", vtep(index), 32);
    leaf.configureRoutedInterface("Gi0/2", `192.0.2.${index * 4 + 1}`, 30);
    leaves.push(leaf);
    hosts.push(host);
  }

  for (const device of [spine, ...leaves]) {
    device.ospf.createProcess(1);
    device.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    device.ospf.setPassiveInterface("Loopback0", true);
  }

  const toSpine = {
    address: SPINE_ID,
    remoteAs: AS,
    updateSource: "Loopback0",
    evpnActivated: true,
    sendCommunityExtended: true,
  };
  for (const [index, leaf] of leaves.entries()) {
    leaf.bgp.configure({ localAs: AS, routerId: vtep(index), neighbors: [toSpine], networks: [] });
    leaf.defineEvpnVni({
      vni: VNI,
      routeDistinguisher: `${AS}:${VNI}`,
      importRouteTargets: [`${AS}:${VNI}`],
      exportRouteTargets: [`${AS}:${VNI}`],
    });
    leaf.configureNve({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      adminUp: true,
      members: [{ vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" } }],
    });
  }
  spine.bgp.configure({
    localAs: AS,
    routerId: SPINE_ID,
    clusterId: SPINE_ID,
    neighbors: leaves.map((_, index) => ({
      address: vtep(index),
      remoteAs: AS,
      updateSource: "Loopback0",
      evpnActivated: true,
      sendCommunityExtended: true,
      routeReflectorClient: true,
    })),
    networks: [],
  });
  engine.runUntilIdle();
  return { engine, spine, leaves, hosts };
}

function hasUnderlayRoute(device: Layer3Switch, loopback: string): boolean {
  return device.routingTable().some((row) => row.kind === "ospf" && row.network === loopback);
}

describe("EVPN fabric on an OSPF underlay", () => {
  it("makes every VTEP loopback mutually reachable through OSPF alone", () => {
    const { leaves } = buildFabric();

    const missing: string[] = [];
    for (const [index, leaf] of leaves.entries()) {
      for (const [other] of leaves.entries()) {
        if (index === other) continue;
        if (!hasUnderlayRoute(leaf, vtep(other))) missing.push(`leaf${index + 1} lacks ${vtep(other)}`);
      }
    }
    expect(missing).toEqual([]);
    // The fifth leaf is the one the M10.17 report lost: it is both the last to
    // reach Full and the one whose Router LSA the flooding bound used to drop.
    expect(hasUnderlayRoute(leaves[0]!, vtep(4))).toBe(true);
    expect(hasUnderlayRoute(leaves[4]!, vtep(0))).toBe(true);
  });

  it("keeps every Type 3 route usable and carries tenant traffic end to end", () => {
    const { engine, leaves, hosts } = buildFabric();
    const leaf1 = leaves[0]!;
    const leaf5 = leaves[4]!;

    expect(leaf1.evpnRoutes().filter((route) => route.type === 3).map((route) => route.originatingVtep))
      .toEqual([vtep(0), vtep(1), vtep(2), vtep(3), vtep(4)]);
    // A Type 3 route is only usable while its VTEP resolves in the underlay.
    for (const leaf of [leaf1, leaf5]) {
      expect(leaf.vxlanPeerSummaries().every((peer) => peer.reachable)).toBe(true);
      expect(leaf.vxlanPeerSummaries()).toHaveLength(LEAF_COUNT - 1);
    }

    hosts[0]!.ping("10.10.10.15", 1);
    engine.runUntilIdle();

    expect(hosts[0]!.pingResults[0]?.success).toBe(true);
    expect(leaf5.remoteMacEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ vni: VNI, mac: macFromIndex(201), remoteVtep: vtep(0), source: "bgp-evpn" }),
    ]));
  });
});
