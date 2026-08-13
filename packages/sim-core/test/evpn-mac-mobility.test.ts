import {
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  type EvpnVniConfiguration,
  type NveInterfaceConfiguration,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * M10.17 — MAC Mobility.
 *
 * A sequence number is how the fabric agrees where an address lives *now*. What
 * is tested here is when it moves and — just as importantly — when it must not:
 * a session reset, a re-advertisement or a second leaf of one All-Active
 * Ethernet Segment seeing the same frame are all not moves.
 */

const VNI = 10_010;
const VLAN = 10;
const AS = 65_000;
const ESI = "0000:0000:0000:0000:0001";

const LEAF1_VTEP = "10.255.0.1";
const LEAF2_VTEP = "10.255.0.2";
const LEAF3_VTEP = "10.255.0.3";
const SPINE_ID = "10.255.0.9";
/** The one address that moves. Two stations carry it, one at a time. */
const MOBILE_MAC = macFromIndex(1);

function nve(): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    adminUp: true,
    members: [{ vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" } }],
  };
}

function evpnVni(): EvpnVniConfiguration {
  return {
    vni: VNI,
    routeDistinguisher: `${AS}:${VNI}`,
    importRouteTargets: [`${AS}:${VNI}`],
    exportRouteTargets: [`${AS}:${VNI}`],
  };
}

interface MobilityFabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  leaf3: Layer3Switch;
  spine: Router;
  ce: L2Switch;
  /** Behind Leaf1, through the CE. Carries `MOBILE_MAC`. */
  stationA: Pc;
  /** Behind Leaf3, on a plain access port. Also carries `MOBILE_MAC`. */
  stationB: Pc;
  /** An ordinary single-homed host, so there is always somewhere to ping. */
  hostB: Pc;
}

/**
 *  stationA — CE ─┬── Leaf1 ──┐
 *                 └── Leaf2 ──┤
 *                             ├── Spine (RR) ── Leaf3 ─┬─ hostB
 *                             ┘                        └─ stationB
 *
 * `stationA` and `stationB` deliberately carry the *same* MAC, one behind the
 * shared Ethernet Segment and one behind an ordinary access port on Leaf3, so a
 * move between two genuinely different places can be produced by bringing one
 * link up and taking the other down — no station is ever teleported.
 */
function mobilityFabric(options: { redundancyMode?: "single-active" | "all-active" } = {}): MobilityFabric {
  const engine = createSimulationEngine({ seed: 10_170 });
  engine.enableTrace();
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const leaf3 = engine.add(new Layer3Switch("leaf3", "Leaf3"));
  const spine = engine.add(new Router("spine", "Spine"));
  const ce = engine.add(new L2Switch("ce", "CE"));
  const stationA = engine.add(new Pc("stationA", "StationA"));
  const stationB = engine.add(new Pc("stationB", "StationB"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  stationA.addInterface("eth0", MOBILE_MAC);
  stationB.addInterface("eth0", MOBILE_MAC);
  hostB.addInterface("eth0", macFromIndex(2));
  stationA.configure({ ip: "10.10.10.10", mask: 24 });
  stationB.configure({ ip: "10.10.10.10", mask: 24 });
  hostB.configure({ ip: "10.10.10.20", mask: 24 });
  for (const [index, port] of ["Gi0/1", "Gi0/2", "Gi0/3"].entries()) ce.addInterface(port, macFromIndex(10 + index));
  for (const [device, base] of [[leaf1, 100], [leaf2, 200], [leaf3, 300]] as const) {
    device.addInterface("Gi0/1", macFromIndex(base + 1));
    device.addInterface("Gi0/2", macFromIndex(base + 2));
    device.addInterface("Gi0/3", macFromIndex(base + 3));
  }
  for (const [index, port] of ["Gi0/0", "Gi0/1", "Gi0/2"].entries()) spine.addInterface(port, macFromIndex(50 + index));

  engine.connect("stationA", "eth0", "ce", "Gi0/1");
  engine.connect("ce", "Gi0/2", "leaf1", "Gi0/1");
  engine.connect("ce", "Gi0/3", "leaf2", "Gi0/1");
  engine.connect("hostB", "eth0", "leaf3", "Gi0/1");
  engine.connect("stationB", "eth0", "leaf3", "Gi0/3");
  engine.connect("leaf1", "Gi0/2", "spine", "Gi0/0");
  engine.connect("leaf2", "Gi0/2", "spine", "Gi0/1");
  engine.connect("leaf3", "Gi0/2", "spine", "Gi0/2");
  // The second station starts down: the address exists in exactly one place
  // until the test deliberately moves it.
  leaf3.interfaces.get("Gi0/3")!.shutdown();

  for (const port of ["Gi0/1", "Gi0/2", "Gi0/3"]) ce.setAccess(port, VLAN);
  for (const leaf of [leaf1, leaf2, leaf3]) {
    leaf.defineVlan(VLAN);
    leaf.setAccess("Gi0/1", VLAN);
    leaf.setAccess("Gi0/3", VLAN);
    leaf.setIpRouting(true);
    leaf.getOrCreateLoopback(0);
  }
  leaf1.configureRoutedInterface("Gi0/2", "192.0.2.1", 30);
  leaf2.configureRoutedInterface("Gi0/2", "192.0.2.5", 30);
  leaf3.configureRoutedInterface("Gi0/2", "192.0.2.9", 30);
  spine.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  spine.configureInterface("Gi0/1", { ip: "192.0.2.6", mask: 30 });
  spine.configureInterface("Gi0/2", { ip: "192.0.2.10", mask: 30 });
  leaf1.setInterfaceIp("Loopback0", LEAF1_VTEP, 32);
  leaf2.setInterfaceIp("Loopback0", LEAF2_VTEP, 32);
  leaf3.setInterfaceIp("Loopback0", LEAF3_VTEP, 32);
  spine.getOrCreateLoopback(0);
  spine.setInterfaceIp("Loopback0", SPINE_ID, 32);

  const uplinks: Record<string, string> = { leaf1: "192.0.2.2", leaf2: "192.0.2.6", leaf3: "192.0.2.10" };
  const vteps: Record<string, string> = { leaf1: LEAF1_VTEP, leaf2: LEAF2_VTEP, leaf3: LEAF3_VTEP };
  for (const leaf of [leaf1, leaf2, leaf3]) {
    for (const [id, address] of Object.entries(vteps)) {
      if (id !== leaf.id) leaf.addStaticRoute(address, 32, uplinks[leaf.id]!);
    }
    leaf.addStaticRoute(SPINE_ID, 32, uplinks[leaf.id]!);
  }
  spine.addStaticRoute(LEAF1_VTEP, 32, "192.0.2.1");
  spine.addStaticRoute(LEAF2_VTEP, 32, "192.0.2.5");
  spine.addStaticRoute(LEAF3_VTEP, 32, "192.0.2.9");

  const leafNeighbor = {
    address: SPINE_ID,
    remoteAs: AS,
    updateSource: "Loopback0",
    evpnActivated: true,
    sendCommunityExtended: true,
  };
  leaf1.bgp.configure({ localAs: AS, routerId: LEAF1_VTEP, neighbors: [leafNeighbor], networks: [] });
  leaf2.bgp.configure({ localAs: AS, routerId: LEAF2_VTEP, neighbors: [leafNeighbor], networks: [] });
  leaf3.bgp.configure({ localAs: AS, routerId: LEAF3_VTEP, neighbors: [leafNeighbor], networks: [] });
  spine.bgp.configure({
    localAs: AS,
    routerId: SPINE_ID,
    clusterId: SPINE_ID,
    neighbors: [LEAF1_VTEP, LEAF2_VTEP, LEAF3_VTEP].map((address) => ({
      address,
      remoteAs: AS,
      updateSource: "Loopback0",
      evpnActivated: true,
      sendCommunityExtended: true,
      routeReflectorClient: true,
    })),
    networks: [],
  });

  for (const leaf of [leaf1, leaf2, leaf3]) {
    leaf.defineEvpnVni(evpnVni());
    leaf.configureNve(nve());
  }
  const redundancyMode = options.redundancyMode ?? "all-active";
  for (const leaf of [leaf1, leaf2]) {
    leaf.configureEthernetSegment({ id: "ES-CE1", esi: ESI, redundancyMode, interfaces: ["Gi0/1"] });
  }
  engine.runUntilIdle();
  return { engine, leaf1, leaf2, leaf3, spine, ce, stationA, stationB, hostB };
}

/** The sequence one leaf currently believes the mobile address carries. */
function observedSequence(fabric: MobilityFabric, on: Layer3Switch): number | undefined {
  void fabric;
  return on.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)?.sequence;
}

/**
 * Move the address: the station leaves the Ethernet Segment and reappears on
 * Leaf3's own access port.
 *
 * Taking the first link down is what makes this a *move* rather than a
 * duplicate — a station cannot be in two places, and modelling it as if it
 * could would be testing something the topology does not describe.
 */
function moveToLeaf3(fabric: MobilityFabric): void {
  fabric.ce.interfaces.get("Gi0/1")!.shutdown();
  fabric.leaf3.interfaces.get("Gi0/3")!.noShutdown();
  fabric.engine.runUntilIdle();
  fabric.stationB.ping("10.10.10.20", 1);
  fabric.engine.runUntilIdle();
}

describe("EVPN MAC Mobility", () => {
  it("advertises sequence 0 on a first local advertisement", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    expect(fabric.stationA.pingResults[0]?.success).toBe(true);

    // A first advertisement carries no mobility community at all, so a
    // pre-M10.17 route and this one are the same bytes.
    const route = fabric.leaf1.evpnRoutes()
      .find((entry) => entry.type === 2 && entry.source === "local" && entry.macAddress === MOBILE_MAC);
    expect(route).toBeDefined();
    expect(route!.type === 2 ? route!.mobility : undefined).toBeUndefined();
    expect(fabric.leaf1.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);
    expect(observedSequence(fabric, fabric.leaf3)).toBe(0);
  });

  it("does not increment when a second leaf of the same All-Active segment sees the frame", () => {
    // Both leaves attach the same CE, so both learn the address locally. That
    // is aliasing, not mobility: the fabric must not start a sequence race.
    const fabric = mobilityFabric({ redundancyMode: "all-active" });
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    expect(fabric.leaf1.macAddressTable().some((row) => row.mac === MOBILE_MAC)).toBe(true);
    expect(fabric.leaf2.macAddressTable().some((row) => row.mac === MOBILE_MAC)).toBe(true);
    expect(fabric.leaf1.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);
    expect(fabric.leaf2.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);
    expect(fabric.engine.traceLog.some((entry) => entry.type === "evpn-mac-mobility-sequence-incremented"))
      .toBe(false);
  });

  it("does not increment on a re-advertisement, a relearn or an NVE restart", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    expect(fabric.leaf1.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);

    // The same station talking again on the same attachment is not a move.
    fabric.stationA.ping("10.10.10.20", 2);
    fabric.engine.runUntilIdle();
    // Nor is re-rendering the routes, nor bouncing the overlay interface.
    fabric.leaf1.restartNve();
    fabric.engine.runUntilIdle();
    fabric.stationA.ping("10.10.10.20", 3);
    fabric.engine.runUntilIdle();
    expect(fabric.leaf1.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);
    expect(fabric.engine.traceLog.some((entry) => entry.type === "evpn-mac-mobility-sequence-incremented"))
      .toBe(false);
  });

  it("increments once for a genuine move to another location", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    expect(observedSequence(fabric, fabric.leaf3)).toBe(0);

    // The address turns up behind Leaf3's own access port: a different place.
    const before = fabric.engine.traceLog.length;
    moveToLeaf3(fabric);
    const converged = fabric.engine.traceLog.slice(before);

    expect(fabric.leaf3.macMobilitySequence(VNI, MOBILE_MAC)).toBe(1);
    expect(converged.some((entry) => entry.type === "evpn-mac-mobility-detected")).toBe(true);
    expect(converged.some((entry) => entry.type === "evpn-mac-mobility-sequence-incremented")).toBe(true);
    const advertised = fabric.leaf3.evpnRoutes()
      .find((entry) => entry.type === 2 && entry.source === "local" && entry.macAddress === MOBILE_MAC);
    expect(advertised!.type === 2 ? advertised!.mobility : undefined).toEqual({ sequence: 1 });
  });

  it("prefers the highest sequence and rejects the stale advertisement", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    const before = fabric.engine.traceLog.length;
    moveToLeaf3(fabric);
    const converged = fabric.engine.traceLog.slice(before);

    // Leaf1 still advertises the old location at sequence 0 — its own port to
    // the CE never went down — and every receiver, itself included, rejects it
    // in favour of Leaf3's sequence 1 rather than oscillating.
    expect(converged.some((entry) => entry.type === "evpn-stale-mac-route-rejected")).toBe(true);
    expect(converged.some((entry) => entry.type === "evpn-mac-route-superseded")).toBe(true);
    const state = fabric.leaf2.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC);
    // Leaf2's own copy lost: the fabric holds the address at Leaf3 now.
    expect(state).toMatchObject({ sequence: 1, owner: LEAF3_VTEP });
    expect(fabric.leaf3.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC))
      .toMatchObject({ sequence: 1, owner: "local", state: "moved" });
    // An older advertisement can never steal the address back: nobody else
    // advertises a sequence that could beat Leaf3's.
    for (const leaf of [fabric.leaf1, fabric.leaf2]) {
      const local = leaf.evpnRoutes()
        .find((route) => route.type === 2 && route.source === "local" && route.macAddress === MOBILE_MAC);
      const sequence = local?.type === 2 ? local.mobility?.sequence ?? 0 : 0;
      expect(sequence, `${leaf.name} must not outbid the new owner`).toBeLessThan(1);
    }
    // And the new owner really does forward: the address is reachable where it
    // now lives, with no topology rebuild anywhere.
    fabric.hostB.ping("10.10.10.10", 1);
    fabric.engine.runUntilIdle();
    expect(fabric.hostB.pingResults.at(-1)?.success).toBe(true);
  });

  it("resolves a same-sequence duplicate deterministically and reports it", () => {
    // Two genuinely different places advertise the address at the same highest
    // sequence. Full duplicate-MAC dampening is out of scope, so a stable
    // winner is chosen and the conflict is named rather than left to oscillate.
    const fabric = mobilityFabric();
    // Both links come up together, so neither station has ever been seen
    // elsewhere and both start at sequence 0.
    fabric.leaf3.interfaces.get("Gi0/3")!.noShutdown();
    fabric.engine.runUntilIdle();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.stationB.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();

    const winners = [fabric.leaf1, fabric.leaf2, fabric.leaf3]
      .map((leaf) => leaf.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)?.owner)
      .filter((owner) => owner !== undefined && owner !== "local");
    // Every observer picked the same winner, without telling one another.
    expect(new Set(winners).size).toBeLessThanOrEqual(1);
    // Running the same fabric again reaches the identical answer.
    const second = mobilityFabric();
    second.leaf3.interfaces.get("Gi0/3")!.noShutdown();
    second.engine.runUntilIdle();
    second.stationA.ping("10.10.10.20", 1);
    second.stationB.ping("10.10.10.20", 1);
    second.engine.runUntilIdle();
    expect(second.leaf2.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)?.owner)
      .toBe(fabric.leaf2.macMobilityStates().find((row) => row.macAddress === MOBILE_MAC)?.owner);
    // Sequence numbers never climb on their own while the conflict persists.
    expect(fabric.leaf1.macMobilitySequence(VNI, MOBILE_MAC)).toBeLessThanOrEqual(1);
    expect(fabric.leaf3.macMobilitySequence(VNI, MOBILE_MAC)).toBeLessThanOrEqual(1);
  });

  it("stores no mobility state in the overlay's persistent configuration", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    moveToLeaf3(fabric);
    expect(fabric.leaf3.macMobilitySequence(VNI, MOBILE_MAC)).toBeGreaterThan(0);
    // A sequence describes where an address has been during *this* run, so
    // clearing the overlay's runtime starts it over — exactly as rebuilding the
    // lab in the verifier does.
    fabric.leaf3.resetVxlanRuntime();
    expect(fabric.leaf3.macMobilitySequence(VNI, MOBILE_MAC)).toBe(0);
    expect(fabric.leaf3.macMobilityStates()).toEqual([]);
    // Nothing mobility-shaped reached the Ethernet Segment configuration.
    expect(JSON.stringify(fabric.leaf1.ethernetSegmentConfigurations())).not.toContain("sequence");
  });

  it("converges within the bounded deterministic event budget", () => {
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    fabric.engine.controlProtocolBudget.reset();
    // Mobility adds no periodic timer: `runUntilIdle` returning at all is the
    // assertion, because a repeating event would never let it.
    moveToLeaf3(fabric);
    expect(fabric.engine.controlProtocolBudget.consumed("evpnUpdates", "leaf3"))
      .toBeLessThan(fabric.engine.controlProtocolBudget.maximumOf("evpnUpdates"));
  });

  it("stops a contested address from counting the two leaves upwards for ever", () => {
    // Both stations stay up, so the address genuinely exists in two places.
    // Full duplicate-MAC dampening is out of scope, but the sequence must not
    // climb: whoever loses concedes and stops bidding.
    const fabric = mobilityFabric();
    fabric.stationA.ping("10.10.10.20", 1);
    fabric.engine.runUntilIdle();
    fabric.leaf3.interfaces.get("Gi0/3")!.noShutdown();
    fabric.engine.runUntilIdle();
    for (let round = 1; round <= 4; round++) {
      fabric.stationB.ping("10.10.10.20", round);
      fabric.engine.runUntilIdle();
      fabric.stationA.ping("10.10.10.20", round + 10);
      fabric.engine.runUntilIdle();
    }
    const sequences = [fabric.leaf1, fabric.leaf2, fabric.leaf3]
      .map((leaf) => leaf.macMobilitySequence(VNI, MOBILE_MAC));
    // One move happened; nothing after it kept incrementing.
    expect(Math.max(...sequences)).toBeLessThanOrEqual(1);
    expect(fabric.engine.traceLog.filter((entry) => entry.type === "evpn-mac-mobility-sequence-incremented").length)
      .toBeLessThanOrEqual(2);
    // The conflict is named rather than silently absorbed.
    expect(fabric.engine.traceLog.some((entry) => entry.type === "evpn-duplicate-mac-detected")).toBe(true);
  });
});
