import { ArpOp, EtherType } from "@sim/contracts";
import {
  Layer3Switch,
  Pc,
  Router,
  createSimulationEngine,
  macFromIndex,
  VXLAN_UDP_PORT,
  type NveInterfaceConfiguration,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const VNI = 10_010;
const VLAN = 10;

interface Fabric {
  engine: ReturnType<typeof createSimulationEngine>;
  leaf1: Layer3Switch;
  leaf2: Layer3Switch;
  spine: Router;
  hostA: Pc;
  hostB: Pc;
}

function nve(source: string, peers: readonly string[]): NveInterfaceConfiguration {
  return {
    id: "nve1",
    sourceInterfaceId: source,
    adminUp: true,
    members: [{
      vni: VNI,
      vlanId: VLAN,
      replication: { type: "static", peerAddresses: [...peers] },
    }],
  };
}

/**
 * PC-A — Leaf1 ===== routed IPv4 underlay via Spine ===== Leaf2 — PC-B.
 *
 * Both hosts sit in the same access VLAN on different VTEPs, so they can only
 * reach each other through the stretched VXLAN segment.
 */
function fabric(options: { peers?: boolean; loopbackOnLeaf2?: boolean } = {}): Fabric {
  const engine = createSimulationEngine({ seed: 1_014 });
  const leaf1 = engine.add(new Layer3Switch("leaf1", "Leaf1"));
  const leaf2 = engine.add(new Layer3Switch("leaf2", "Leaf2"));
  const spine = engine.add(new Router("spine", "Spine"));
  const hostA = engine.add(new Pc("hostA", "HostA"));
  const hostB = engine.add(new Pc("hostB", "HostB"));

  hostA.addInterface("eth0", macFromIndex(1));
  hostB.addInterface("eth0", macFromIndex(2));
  hostA.configure({ ip: "10.10.10.10", mask: 24 });
  hostB.configure({ ip: "10.10.10.20", mask: 24 });

  for (const leaf of [leaf1, leaf2]) {
    leaf.addInterface("Gi0/1", macFromIndex(leaf === leaf1 ? 101 : 201));
    leaf.addInterface("Gi0/2", macFromIndex(leaf === leaf1 ? 102 : 202));
  }
  spine.addInterface("Gi0/0", macFromIndex(50));
  spine.addInterface("Gi0/1", macFromIndex(51));

  engine.connect("hostA", "eth0", "leaf1", "Gi0/1");
  engine.connect("hostB", "eth0", "leaf2", "Gi0/1");
  engine.connect("leaf1", "Gi0/2", "spine", "Gi0/0");
  engine.connect("leaf2", "Gi0/2", "spine", "Gi0/1");

  leaf1.setAccess("Gi0/1", VLAN);
  leaf2.setAccess("Gi0/1", VLAN);
  leaf1.configureRoutedInterface("Gi0/2", "192.0.2.1", 30);
  leaf2.configureRoutedInterface("Gi0/2", "192.0.2.5", 30);
  spine.configureInterface("Gi0/0", { ip: "192.0.2.2", mask: 30 });
  spine.configureInterface("Gi0/1", { ip: "192.0.2.6", mask: 30 });

  leaf1.getOrCreateLoopback(0);
  leaf1.setInterfaceIp("Loopback0", "10.255.0.1", 32);
  if (options.loopbackOnLeaf2 !== false) {
    leaf2.getOrCreateLoopback(0);
    leaf2.setInterfaceIp("Loopback0", "10.255.0.2", 32);
  }
  leaf1.setIpRouting(true);
  leaf2.setIpRouting(true);
  leaf1.addStaticRoute("10.255.0.2", 32, "192.0.2.2");
  leaf2.addStaticRoute("10.255.0.1", 32, "192.0.2.6");
  spine.addStaticRoute("10.255.0.1", 32, "192.0.2.1");
  spine.addStaticRoute("10.255.0.2", 32, "192.0.2.5");

  if (options.peers !== false) {
    leaf1.configureNve(nve("Loopback0", ["10.255.0.2"]));
    leaf2.configureNve(nve("Loopback0", ["10.255.0.1"]));
  }
  return { engine, leaf1, leaf2, spine, hostA, hostB };
}

function typesOf(trace: readonly TraceEntry[], device: string): string[] {
  return trace.filter((entry) => entry.device === device).map((entry) => entry.type);
}

describe("VXLAN layer-2 overlay", () => {
  it("stretches one VLAN across static VTEP peers and carries ARP and ICMP", () => {
    const run = () => {
      const { engine, leaf1, hostA } = fabric();
      engine.enableTrace();
      hostA.ping("10.10.10.20", 1);
      engine.runUntilIdle();
      return { success: hostA.pingResults[0]?.success ?? false, leaf: typesOf(engine.traceLog, "leaf1"), remote: leaf1.remoteMacEntries() };
    };
    const first = run();
    const second = run();
    expect(first.success).toBe(true);
    // Broadcast ARP is head-end replicated; the ICMP reply comes back as a
    // known unicast once the remote MAC has been learned.
    expect(first.leaf).toContain("vxlan-bum-replicated");
    expect(first.leaf).toContain("vxlan-packet-sent");
    expect(first.leaf).toContain("vxlan-decapsulated");
    expect(first.leaf).toContain("vxlan-mac-learned-remote");
    expect(first.remote).toEqual([
      expect.objectContaining({ vni: VNI, remoteVtep: "10.255.0.2", source: "data-plane" }),
    ]);
    expect(second).toEqual(first);
  });

  it("maps VLAN to VNI and reports the derived NVE and VNI state", () => {
    const { leaf1 } = fabric();
    expect(leaf1.nveSummaries()).toEqual([
      expect.objectContaining({ id: "nve1", sourceInterfaceId: "Loopback0", up: true, sourceAddress: "10.255.0.1" }),
    ]);
    expect(leaf1.vniSummaries()).toEqual([
      expect.objectContaining({ vni: VNI, vlanId: VLAN, up: true, replication: "static" }),
    ]);
    expect(leaf1.vxlanPeerSummaries()).toEqual([
      { vni: VNI, address: "10.255.0.2", source: "static", reachable: true },
    ]);
  });

  it("rejects a second VNI for the same VLAN and a second VLAN for the same VNI", () => {
    const { leaf1 } = fabric();
    expect(() => leaf1.configureNve({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      adminUp: true,
      members: [
        { vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" } },
        { vni: 20_020, vlanId: VLAN, replication: { type: "bgp-evpn" } },
      ],
    })).toThrow(/VLAN 10 is already mapped/);
    expect(() => leaf1.configureNve({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      adminUp: true,
      members: [
        { vni: VNI, vlanId: VLAN, replication: { type: "bgp-evpn" } },
        { vni: VNI, vlanId: 20, replication: { type: "bgp-evpn" } },
      ],
    })).toThrow(/VNI 10010 is already mapped/);
  });

  it("rejects VNI 0 and a VNI above the 24-bit range", () => {
    const { leaf1 } = fabric();
    for (const vni of [0, 16_777_216]) {
      expect(() => leaf1.configureNve({
        id: "nve1",
        sourceInterfaceId: "Loopback0",
        adminUp: true,
        members: [{ vni, vlanId: VLAN, replication: { type: "bgp-evpn" } }],
      })).toThrow(/VNI must be between/);
    }
  });

  it("keeps the NVE down without a usable loopback source", () => {
    const { leaf1 } = fabric();
    leaf1.removeLoopback(0);
    expect(leaf1.nveSummaries()[0]).toMatchObject({ up: false, reason: "source-interface-missing" });
    leaf1.getOrCreateLoopback(0);
    expect(leaf1.nveSummaries()[0]).toMatchObject({ up: false, reason: "source-interface-down" });
  });

  it("refuses a non-loopback NVE source", () => {
    const { leaf1 } = fabric();
    leaf1.configureNve(nve("Gi0/2", ["10.255.0.2"]));
    expect(leaf1.nveSummaries()[0]).toMatchObject({ up: false, reason: "source-not-loopback" });
  });

  it("requires an underlay route to the remote VTEP", () => {
    const { engine, leaf1, hostA } = fabric();
    leaf1.addStaticRoute("10.255.0.2", 32, "192.0.2.99");
    // Replace the usable route by shutting the underlay port instead: the
    // remaining static route can no longer resolve its next hop.
    leaf1.getInterface("Gi0/2")!.shutdown();
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(typesOf(engine.traceLog, "leaf1")).toContain("vxlan-underlay-unreachable");
    expect(hostA.pingResults[0]?.success ?? false).toBe(false);
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/no underlay route to VTEP 10\.255\.0\.2/);
  });

  it("stops the overlay when an ACL blocks UDP 4789", () => {
    const { engine, leaf1, hostA } = fabric();
    leaf1.defineAcl({
      id: "block-vxlan",
      type: "extended",
      rules: [
        { sequence: 10, action: "deny", protocol: 17, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: VXLAN_UDP_PORT } },
        { sequence: 20, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } },
      ],
    });
    leaf1.applyAcl("Gi0/2", "out", "block-vxlan");
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    // The VTEP still encapsulates; the underlay ACL is what drops the packet.
    expect(typesOf(engine.traceLog, "leaf1")).toContain("vxlan-packet-sent");
    expect(typesOf(engine.traceLog, "leaf1")).toContain("acl-denied");
    expect(hostA.pingResults[0]?.success ?? false).toBe(false);
  });

  it("floods locally only and reports a problem without a remote peer", () => {
    const { engine, leaf1, hostA } = fabric({ peers: false });
    leaf1.configureNve(nve("Loopback0", []));
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    const replicated = engine.traceLog.filter((entry) => entry.type === "vxlan-bum-replicated" && entry.device === "leaf1");
    expect(replicated[0]?.detail).toMatchObject({ replicas: 0, peers: 0 });
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/has no remote VTEP/);
  });

  it("never re-encapsulates a frame that arrived from the overlay", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    // A third VTEP in the same VNI would be the loop opportunity: Leaf2 must
    // still not forward Leaf1's BUM traffic onwards.
    leaf2.configureNve(nve("Loopback0", ["10.255.0.1", "10.255.0.9"]));
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(typesOf(engine.traceLog, "leaf2")).toContain("vxlan-split-horizon-dropped");
    const relayed = engine.traceLog.filter((entry) =>
      entry.device === "leaf2"
      && entry.type === "vxlan-packet-sent"
      && entry.detail?.destinationVtep === "10.255.0.9");
    expect(relayed).toEqual([]);
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
  });

  it("reports a VNI that has no local mapping instead of guessing one", () => {
    const { engine, leaf1, leaf2, hostA } = fabric();
    leaf2.configureNve({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      adminUp: true,
      members: [{ vni: 20_020, vlanId: 20, replication: { type: "static", peerAddresses: ["10.255.0.1"] } }],
    });
    leaf2.defineVlan(20);
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(typesOf(engine.traceLog, "leaf2")).toContain("vxlan-vni-not-found");
    expect(leaf1.remoteMacEntries()).toEqual([]);
  });

  it("prefers a local attachment when a MAC moves in from a remote VTEP", () => {
    const { engine, leaf1, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
    const remoteMac = leaf1.remoteMacEntries()[0]!.mac;
    // The station reappears on Leaf1's local access segment in the same VLAN.
    hostA.getInterface("eth0")!.transmit({
      src: remoteMac,
      dst: "ff:ff:ff:ff:ff:ff",
      etherType: EtherType.ARP,
      payload: {
        kind: "arp",
        op: ArpOp.Request,
        senderMac: remoteMac,
        senderIp: "10.10.10.20",
        targetMac: "00:00:00:00:00:00",
        targetIp: "10.10.10.10",
      },
    });
    engine.runUntilIdle();
    expect(leaf1.remoteMacEntries()).toEqual([]);
    expect(typesOf(engine.traceLog, "leaf1")).toContain("vxlan-mac-moved-local");
  });

  it("drops and reports an inner frame that does not fit the underlay MTU", () => {
    const { engine, leaf1, hostA } = fabric();
    engine.enableTrace();
    hostA.ping("10.10.10.20", 1, { payloadBytes: 1_600 });
    engine.runUntilIdle();
    expect(typesOf(engine.traceLog, "leaf1")).toContain("vxlan-mtu-exceeded");
    expect(leaf1.vxlanProblems().join("\n")).toMatch(/exceeds the 1500-byte underlay MTU/);
  });

  it("leaves the underlay devices without any tenant MAC", () => {
    const { engine, spine, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    const tenantMacs = [macFromIndex(1), macFromIndex(2)];
    expect(spine.arpTable.size).toBeGreaterThan(0);
    for (const mac of tenantMacs) expect([...spine.arpTable.values()]).not.toContain(mac);
  });

  it("carries an IPv6 payload across the same layer-2 segment", () => {
    const { engine, leaf1, hostA, hostB } = fabric();
    hostA.configureIpv6Static("2001:db8:10::10", 64);
    hostB.configureIpv6Static("2001:db8:10::20", 64);
    // Duplicate address detection has to finish before the address is usable.
    engine.runUntilIdle();
    engine.enableTrace();
    hostA.ping6("2001:db8:10::20", 1);
    engine.runUntilIdle();
    expect(hostA.ipv6PingResults[0]?.success ?? false).toBe(true);
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
  });

  it("clears only runtime state when the overlay is reset", () => {
    const { engine, leaf1, hostA } = fabric();
    hostA.ping("10.10.10.20", 1);
    engine.runUntilIdle();
    expect(leaf1.remoteMacEntries()).toHaveLength(1);
    leaf1.resetVxlanRuntime();
    expect(leaf1.remoteMacEntries()).toEqual([]);
    expect(leaf1.nveConfiguration()).toMatchObject({ id: "nve1", sourceInterfaceId: "Loopback0" });
  });
});
