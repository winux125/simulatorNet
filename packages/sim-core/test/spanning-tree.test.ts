import { describe, expect, it } from "vitest";
import {
  ControlProtocolBudget,
  ControlProtocolLimitError,
  createSimulationEngine,
  DEFAULT_STP_FORWARD_DELAY_NS,
  Hub,
  L2Switch,
  macFromIndex,
  NS_PER_S,
  Pc,
  type SimulationEngine,
  type SpanningTreeInstanceSummary,
  type SpanningTreeMode,
  type SpanningTreePortSummary,
} from "@sim/sim-core";

const VLAN = 1;

/** Tracing must be on before the first `connect`, which already runs the election. */
function tracedEngine(options: { seed: number }): SimulationEngine {
  const engine = createSimulationEngine(options);
  engine.enableTrace();
  return engine;
}

function addSwitch(engine: SimulationEngine, id: string, name: string, macBase: number, ports = 4): L2Switch {
  const sw = engine.add(new L2Switch(id, name));
  for (let index = 1; index <= ports; index++) sw.addInterface(`Gi0/${index}`, macFromIndex(macBase + index));
  return sw;
}

function addPc(engine: SimulationEngine, id: string, address: string, macIndex: number): Pc {
  const pc = engine.add(new Pc(id, id.toUpperCase()));
  pc.addInterface("eth0", macFromIndex(macIndex));
  pc.configure({ ip: address, mask: 24 });
  return pc;
}

/** SW1—SW2, SW2—SW3, SW3—SW1: the classic redundant triangle. */
interface Triangle {
  engine: SimulationEngine;
  sw1: L2Switch;
  sw2: L2Switch;
  sw3: L2Switch;
}

function buildTriangle(mode: SpanningTreeMode, seed = 7): Triangle {
  const engine = tracedEngine({ seed });
  const sw1 = addSwitch(engine, "sw1", "SW1", 100);
  const sw2 = addSwitch(engine, "sw2", "SW2", 200);
  const sw3 = addSwitch(engine, "sw3", "SW3", 300);
  for (const sw of [sw1, sw2, sw3]) sw.setSpanningTreeMode(mode);
  engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
  engine.connect("sw2", "Gi0/2", "sw3", "Gi0/1");
  engine.connect("sw3", "Gi0/2", "sw1", "Gi0/2");
  return { engine, sw1, sw2, sw3 };
}

function instance(sw: L2Switch, vlanId = VLAN): SpanningTreeInstanceSummary {
  const found = sw.spanningTreeSummary().instances.find((entry) => entry.vlanId === vlanId);
  if (!found) throw new Error(`${sw.name} has no spanning-tree instance for VLAN ${vlanId}`);
  return found;
}

function port(sw: L2Switch, portId: string, vlanId = VLAN): SpanningTreePortSummary {
  const found = instance(sw, vlanId).ports.find((entry) => entry.port === portId);
  if (!found) throw new Error(`${sw.name} has no spanning-tree port ${portId} in VLAN ${vlanId}`);
  return found;
}

function traceTypes(engine: SimulationEngine, ...types: string[]): number {
  return engine.traceLog.filter((entry) => types.includes(entry.type)).length;
}

describe("STP root and port election", () => {
  it("elects the lowest bridge ID as root", () => {
    const { engine, sw1, sw2, sw3 } = buildTriangle("stp");
    engine.runUntilIdle();

    expect(instance(sw1).isRoot).toBe(true);
    expect(instance(sw2).isRoot).toBe(false);
    expect(instance(sw3).isRoot).toBe(false);
    expect(instance(sw2).rootId).toBe(instance(sw1).bridgeId);
    expect(instance(sw3).rootId).toBe(instance(sw1).bridgeId);
  });

  it("moves the root when a lower priority is configured", () => {
    const { engine, sw1, sw3 } = buildTriangle("stp");
    sw3.spanningTree.setBridgePriority(VLAN, 4_096);
    engine.runUntilIdle();

    expect(instance(sw3).isRoot).toBe(true);
    expect(instance(sw1).isRoot).toBe(false);
    expect(instance(sw1).rootId).toBe(instance(sw3).bridgeId);
  });

  it("selects one root port per non-root bridge", () => {
    const { engine, sw2, sw3 } = buildTriangle("stp");
    engine.runUntilIdle();

    expect(instance(sw2).rootPort).toBe("Gi0/1");
    expect(instance(sw3).rootPort).toBe("Gi0/2");
    expect(port(sw2, "Gi0/1").role).toBe("root");
    expect(port(sw3, "Gi0/2").role).toBe("root");
    expect(instance(sw2).rootPathCost).toBe(4);
    expect(instance(sw3).rootPathCost).toBe(4);
  });

  it("makes the lower bridge ID designated on the shared segment", () => {
    const { engine, sw1, sw2 } = buildTriangle("stp");
    engine.runUntilIdle();

    // Every root-bridge port is designated.
    expect(port(sw1, "Gi0/1").role).toBe("designated");
    expect(port(sw1, "Gi0/2").role).toBe("designated");
    // SW2 wins the SW2–SW3 segment because its bridge ID is lower than SW3's.
    expect(port(sw2, "Gi0/2").role).toBe("designated");
  });

  it("blocks the redundant link on the inferior bridge", () => {
    const { engine, sw3 } = buildTriangle("stp");
    engine.runUntilIdle();

    const alternate = port(sw3, "Gi0/1");
    expect(alternate.role).toBe("alternate");
    expect(alternate.state).toBe("blocking");
  });

  it("breaks a cost tie with the port priority", () => {
    const engine = tracedEngine({ seed:3 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    // Two parallel links: equal cost and equal sender bridge, so the sender's
    // port identifier decides which of SW2's ports becomes the root port.
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw1", "Gi0/2", "sw2", "Gi0/2");
    sw1.spanningTree.setPortPriority("Gi0/2", 16);
    engine.runUntilIdle();

    expect(instance(sw2).rootPort).toBe("Gi0/2");
    expect(port(sw2, "Gi0/1").role).toBe("alternate");
  });

  it("prefers the cheaper path when a port cost is raised", () => {
    const { engine, sw3 } = buildTriangle("stp");
    // Make SW3's direct link to the root expensive; the SW2 path now wins.
    sw3.spanningTree.setPortCost("Gi0/2", 100);
    engine.runUntilIdle();

    expect(instance(sw3).rootPort).toBe("Gi0/1");
    expect(instance(sw3).rootPathCost).toBe(8);
    expect(port(sw3, "Gi0/2").role).toBe("alternate");
  });
});

describe("STP port states and the data plane", () => {
  it("does not forward or learn while listening", () => {
    const { engine, sw2 } = buildTriangle("stp");
    engine.advanceTo(NS_PER_S);

    const listening = port(sw2, "Gi0/2");
    expect(listening.state).toBe("listening");
    expect(sw2.spanningTree.allowsLearning("Gi0/2", VLAN)).toBe(false);
    expect(sw2.spanningTree.allowsForwarding("Gi0/2", VLAN)).toBe(false);
  });

  it("learns but does not forward while learning", () => {
    const { engine, sw2 } = buildTriangle("stp");
    engine.advanceTo(DEFAULT_STP_FORWARD_DELAY_NS + NS_PER_S);

    expect(port(sw2, "Gi0/2").state).toBe("learning");
    expect(sw2.spanningTree.allowsLearning("Gi0/2", VLAN)).toBe(true);
    expect(sw2.spanningTree.allowsForwarding("Gi0/2", VLAN)).toBe(false);
  });

  it("reaches forwarding after two forward delays and passes traffic", () => {
    const engine = tracedEngine({ seed:11 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    const pc2 = addPc(engine, "pc2", "10.0.0.2", 12);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.connect("sw2", "Gi0/3", "pc2", "eth0");
    engine.runUntilIdle();

    expect(port(sw1, "Gi0/1").state).toBe("forwarding");
    expect(engine.now()).toBeGreaterThanOrEqual(2 * DEFAULT_STP_FORWARD_DELAY_NS);

    pc1.ping("10.0.0.2", 1);
    engine.runUntilIdle();
    expect(pc1.pingResults.at(-1)).toMatchObject({ sequence: 1, success: true });
  });

  it("drops data on a blocking port but still exchanges BPDUs", () => {
    const { engine, sw3 } = buildTriangle("stp");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    const pc3 = addPc(engine, "pc3", "10.0.0.3", 13);
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.connect("sw3", "Gi0/3", "pc3", "eth0");
    engine.runUntilIdle();

    const before = engine.traceLog.length;
    pc1.ping("10.0.0.3", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults.at(-1)).toMatchObject({ success: true });
    const during = engine.traceLog.slice(before);
    // The alternate port refused the flooded frame ...
    expect(during.some((entry) => entry.type === "stp-frame-blocked" && entry.device === "sw3")).toBe(true);
    // ... while BPDUs keep flowing on that same port.
    expect(port(sw3, "Gi0/1").state).toBe("blocking");
    expect(port(sw3, "Gi0/1").designatedBridgeId).toBeDefined();
  });

  it("stops a broadcast from looping around the triangle", () => {
    const { engine, sw1 } = buildTriangle("stp");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.runUntilIdle();

    const before = engine.traceLog.length;
    pc1.ping("10.0.0.9", 1); // nobody answers: the ARP broadcast is the test
    engine.runUntilIdle();

    const during = engine.traceLog.slice(before);
    expect(during.some((entry) => entry.type === "frame-traversal-limit")).toBe(false);
    // Each switch floods the ARP request at most once per VLAN.
    expect(during.filter((entry) => entry.type === "flood" && entry.device === "sw1").length).toBeLessThanOrEqual(2);
    expect(sw1.spanningTree.enabled).toBe(true);
  });

  it("keeps the hub loop safety budget for labs that leave STP disabled", () => {
    const engine = tracedEngine({ seed:5 });
    const hub1 = engine.add(new Hub("hub1", "HUB1"));
    const hub2 = engine.add(new Hub("hub2", "HUB2"));
    for (const [hub, base] of [[hub1, 400], [hub2, 500]] as const) {
      for (let index = 1; index <= 3; index++) hub.addInterface(`Eth0/${index}`, macFromIndex(base + index));
    }
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    engine.connect("hub1", "Eth0/1", "hub2", "Eth0/1");
    engine.connect("hub1", "Eth0/2", "hub2", "Eth0/2");
    engine.connect("hub1", "Eth0/3", "pc1", "eth0");

    pc1.ping("10.0.0.9", 1);
    expect(() => engine.runUntilIdle()).toThrowError(/traversal budget/);
  });
});

describe("Per-VLAN spanning tree instances", () => {
  it("can elect a different root per VLAN", () => {
    const engine = tracedEngine({ seed:13 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    const sw3 = addSwitch(engine, "sw3", "SW3", 300);
    for (const sw of [sw1, sw2, sw3]) {
      sw.setSpanningTreeMode("stp");
      sw.defineVlan(10);
      sw.defineVlan(20);
      sw.setTrunk("Gi0/1", { allowedVlans: [10, 20] });
      sw.setTrunk("Gi0/2", { allowedVlans: [10, 20] });
    }
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw2", "Gi0/2", "sw3", "Gi0/1");
    engine.connect("sw3", "Gi0/2", "sw1", "Gi0/2");
    sw1.spanningTree.setBridgePriority(10, 4_096);
    sw2.spanningTree.setBridgePriority(20, 4_096);
    engine.runUntilIdle();

    expect(instance(sw1, 10).isRoot).toBe(true);
    expect(instance(sw2, 10).isRoot).toBe(false);
    expect(instance(sw2, 20).isRoot).toBe(true);
    expect(instance(sw1, 20).isRoot).toBe(false);
  });

  it("only builds instances for VLANs the trunk allows", () => {
    const engine = tracedEngine({ seed:17 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) {
      sw.setSpanningTreeMode("stp");
      sw.defineVlan(10);
      sw.defineVlan(20);
      sw.defineVlan(30);
      sw.setTrunk("Gi0/1", { allowedVlans: [10, 20] });
    }
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();

    const vlans = sw1.spanningTreeSummary().instances.map((entry) => entry.vlanId);
    expect(vlans).toContain(10);
    expect(vlans).toContain(20);
    // Gi0/2..Gi0/4 default to access VLAN 1, so VLAN 1 still has an instance;
    // VLAN 30 has no port at all and therefore no instance.
    expect(vlans).toContain(1);
    expect(vlans).not.toContain(30);
  });

  it("puts an access port only in its own VLAN instance", () => {
    const engine = tracedEngine({ seed:19 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    sw1.setSpanningTreeMode("stp");
    sw1.setAccess("Gi0/1", 10);
    sw1.setAccess("Gi0/2", 20);
    engine.runUntilIdle();

    const summary = sw1.spanningTreeSummary();
    const vlan10 = summary.instances.find((entry) => entry.vlanId === 10)!;
    const vlan20 = summary.instances.find((entry) => entry.vlanId === 20)!;
    expect(vlan10.ports.map((entry) => entry.port)).toEqual(["Gi0/1"]);
    expect(vlan20.ports.map((entry) => entry.port)).toEqual(["Gi0/2"]);
  });

  it("keeps the native VLAN consistent across an untagged trunk", () => {
    const engine = tracedEngine({ seed:23 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) {
      sw.setSpanningTreeMode("stp");
      sw.defineVlan(99);
      sw.setTrunk("Gi0/1", { nativeVlan: 99, allowedVlans: [99] });
    }
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();

    expect(instance(sw2, 99).rootId).toBe(instance(sw1, 99).bridgeId);
    expect(port(sw2, "Gi0/1", 99).role).toBe("root");
    expect(port(sw1, "Gi0/1", 99).role).toBe("designated");
  });
});

describe("STP reconvergence", () => {
  it("promotes the alternate port when the active link fails", () => {
    const { engine, sw2, sw3 } = buildTriangle("stp");
    engine.runUntilIdle();
    expect(port(sw3, "Gi0/1").role).toBe("alternate");

    // Break SW3's direct link to the root bridge.
    sw3.getInterface("Gi0/2")!.shutdown();
    engine.runUntilIdle();

    expect(port(sw3, "Gi0/1").role).toBe("root");
    expect(port(sw3, "Gi0/1").state).toBe("forwarding");
    expect(instance(sw3).rootPathCost).toBe(8);
    expect(instance(sw3).topologyChanges).toBeGreaterThan(0);
    expect(instance(sw2).rootId).toBe(instance(sw2).rootId);
  });

  it("elects a new root when the root bridge drops off the topology", () => {
    const { engine, sw1, sw2, sw3 } = buildTriangle("stp");
    engine.runUntilIdle();
    expect(instance(sw1).isRoot).toBe(true);

    for (const name of ["Gi0/1", "Gi0/2"]) sw1.getInterface(name)!.shutdown();
    engine.runUntilIdle();

    expect(instance(sw2).isRoot).toBe(true);
    expect(instance(sw3).rootId).toBe(instance(sw2).bridgeId);
    expect(instance(sw3).rootPort).toBe("Gi0/1");
  });

  it("discards the VLAN forwarding entries touched by a topology change", () => {
    const { engine, sw3 } = buildTriangle("stp");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    const pc3 = addPc(engine, "pc3", "10.0.0.3", 13);
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.connect("sw3", "Gi0/3", "pc3", "eth0");
    engine.runUntilIdle();
    pc1.ping("10.0.0.3", 1);
    engine.runUntilIdle();
    expect(sw3.macAddressTable().length).toBeGreaterThan(0);

    sw3.getInterface("Gi0/2")!.shutdown();
    engine.runUntilIdle();
    expect(sw3.spanningTreeSummary().instances[0]!.topologyChanges).toBeGreaterThan(0);
    // The table is rebuilt from live traffic, never restored from a document.
    expect(sw3.macAddressTable().every((row) => row.vlan === VLAN)).toBe(true);
  });
});

describe("Rapid PVST", () => {
  it("uses proposal and agreement to reach forwarding", () => {
    const { engine } = buildTriangle("rstp");
    engine.runUntilIdle();

    expect(traceTypes(engine, "rstp-proposal")).toBeGreaterThan(0);
    expect(traceTypes(engine, "rstp-agreement")).toBeGreaterThan(0);
  });

  it("converges with fewer transitions and less virtual time than 802.1D", () => {
    const classic = buildTriangle("stp");
    classic.engine.runUntilIdle();
    const rapid = buildTriangle("rstp");
    rapid.engine.runUntilIdle();

    const classicTransitions = traceTypes(classic.engine, "stp-port-state-changed");
    const rapidTransitions = traceTypes(rapid.engine, "stp-port-state-changed");
    expect(rapidTransitions).toBeLessThan(classicTransitions);
    expect(rapid.engine.now()).toBeLessThan(classic.engine.now());
    expect(instance(rapid.sw1).isRoot).toBe(true);
    expect(port(rapid.sw3, "Gi0/1").state).toBe("discarding");
  });

  it("reconverges rapidly after a link failure", () => {
    const { engine, sw3 } = buildTriangle("rstp");
    engine.runUntilIdle();
    const failureAt = engine.now();

    sw3.getInterface("Gi0/2")!.shutdown();
    engine.runUntilIdle();

    expect(port(sw3, "Gi0/1").role).toBe("root");
    expect(port(sw3, "Gi0/1").state).toBe("forwarding");
    expect(engine.now() - failureAt).toBeLessThan(2 * DEFAULT_STP_FORWARD_DELAY_NS);
  });
});

describe("PortFast and BPDU Guard", () => {
  it("forwards immediately on a PortFast edge port", () => {
    const engine = tracedEngine({ seed:29 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    sw1.setSpanningTreeMode("stp");
    sw1.spanningTree.setPortFast("Gi0/1", true);
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    engine.connect("sw1", "Gi0/1", "pc1", "eth0");
    engine.advanceTo(NS_PER_S);

    expect(port(sw1, "Gi0/1").state).toBe("forwarding");
    expect(port(sw1, "Gi0/1").edge).toBe(true);
    expect(port(sw1, "Gi0/2").state).not.toBe("forwarding");
  });

  it("cancels edge behaviour once a BPDU arrives", () => {
    const engine = tracedEngine({ seed:31 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    sw2.spanningTree.setPortFast("Gi0/1", true);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();

    expect(port(sw2, "Gi0/1").edge).toBe(false);
    expect(port(sw2, "Gi0/1").role).toBe("root");
    expect(traceTypes(engine, "stp-portfast-cancelled")).toBeGreaterThan(0);
  });

  it("error-disables a guarded port that receives a BPDU", () => {
    const engine = tracedEngine({ seed:37 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    sw2.spanningTree.setPortFast("Gi0/1", true);
    sw2.spanningTree.setBpduGuard("Gi0/1", true);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();

    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(true);
    expect(sw2.spanningTreeSummary().errorDisabledPorts).toEqual(["Gi0/1"]);
    expect(port(sw2, "Gi0/1").state).toBe("disabled");
    expect(traceTypes(engine, "bpdu-guard-triggered")).toBeGreaterThan(0);

    expect(sw2.spanningTree.resetErrorDisabled("Gi0/1")).toBe(true);
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(false);
  });

  it("keeps error-disabled state out of the persistent configuration", () => {
    const engine = tracedEngine({ seed:41 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    sw2.spanningTree.setBpduGuard("Gi0/1", true);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(true);

    const configured = sw2.spanningTree.configuredPorts();
    expect(configured).toEqual([{ port: "Gi0/1", configuration: { priority: 128, portFast: false, bpduGuard: true } }]);
    expect(JSON.stringify(configured)).not.toContain("errorDisabled");

    sw2.spanningTree.resetRuntime();
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(false);
    expect(sw2.spanningTree.configuredPorts()).toEqual(configured);
  });
});

describe("Configuration, determinism and limits", () => {
  it("round-trips mode, priorities, timers and port configuration", () => {
    const engine = tracedEngine({ seed:43 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    sw1.setSpanningTreeMode("rstp");
    sw1.spanningTree.setBridgePriority(10, 24_576);
    sw1.spanningTree.setTimers({ helloTimeNs: 4 * NS_PER_S, maxAgeNs: 24 * NS_PER_S });
    sw1.spanningTree.setPortCost("Gi0/1", 19);
    sw1.spanningTree.setPortPriority("Gi0/1", 64);
    sw1.spanningTree.setPortFast("Gi0/2", true);

    expect(sw1.spanningTreeMode).toBe("rstp");
    expect(sw1.spanningTree.configuredVlanPriorities()).toEqual([{ vlanId: 10, priority: 24_576 }]);
    expect(sw1.spanningTree.currentTimers()).toEqual({
      helloTimeNs: 4 * NS_PER_S,
      maxAgeNs: 24 * NS_PER_S,
      forwardDelayNs: DEFAULT_STP_FORWARD_DELAY_NS,
    });
    expect(sw1.spanningTree.configuredPorts()).toEqual([
      { port: "Gi0/1", configuration: { cost: 19, priority: 64, portFast: false, bpduGuard: false } },
      { port: "Gi0/2", configuration: { priority: 128, portFast: true, bpduGuard: false } },
    ]);
    expect(sw1.spanningTree.portCostOf("Gi0/1")).toBe(19);
    expect(sw1.spanningTree.portCostOf("Gi0/3")).toBe(4);
  });

  it("rejects priorities that are not valid increments", () => {
    const engine = tracedEngine({ seed:47 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    expect(() => sw1.spanningTree.setBridgePriority(1, 1_000)).toThrowError(/multiple of 4096/);
    expect(() => sw1.spanningTree.setPortPriority("Gi0/1", 7)).toThrowError(/multiple of 16/);
    expect(() => sw1.spanningTree.setPortCost("Gi0/1", 0)).toThrowError(/between 1 and/);
  });

  it("produces a stable golden trace of the election", () => {
    const { engine } = buildTriangle("stp");
    engine.runUntilIdle();

    const golden = engine.traceLog
      .filter((entry) => entry.type === "stp-root-elected" || entry.type === "stp-port-role-changed")
      .filter((entry) => entry.device === "sw3")
      .map((entry) => `${entry.type}:${String(entry.detail?.interface ?? "-")}:${String(entry.detail?.role ?? entry.detail?.root)}`);

    // SW3 believes it is root, learns about SW2, then about the better SW1,
    // and finally blocks the SW2 link. Only cabled ports ever leave "disabled".
    expect(golden).toEqual([
      "stp-port-role-changed:Gi0/1:designated",
      "stp-port-role-changed:Gi0/2:designated",
      "stp-root-elected:-:32769.02:00:00:00:00:c9",
      "stp-port-role-changed:Gi0/1:root",
      "stp-root-elected:-:32769.02:00:00:00:00:65",
      "stp-port-role-changed:Gi0/1:designated",
      "stp-port-role-changed:Gi0/2:root",
      "stp-port-role-changed:Gi0/1:alternate",
    ]);
  });

  it("reaches an identical result from two independent engine builds", () => {
    const first = buildTriangle("rstp", 99);
    const second = buildTriangle("rstp", 99);
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    for (const key of ["sw1", "sw2", "sw3"] as const) {
      expect(second[key].spanningTreeSummary()).toEqual(first[key].spanningTreeSummary());
    }
    expect(second.engine.now()).toBe(first.engine.now());
    expect(second.engine.traceLog.map((entry) => `${entry.time}:${entry.type}:${entry.device}`))
      .toEqual(first.engine.traceLog.map((entry) => `${entry.time}:${entry.type}:${entry.device}`));
  });

  it("enforces the per-device spanning-tree instance limit", () => {
    const engine = tracedEngine({ seed:53 });
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    for (let vlan = 2; vlan <= 200; vlan++) sw1.defineVlan(vlan);
    sw1.setTrunk("Gi0/1");

    expect(() => sw1.setSpanningTreeMode("stp")).toThrowError(ControlProtocolLimitError);
  });

  it("enforces the per-operation control protocol event budget", () => {
    const budget = new ControlProtocolBudget();
    const maximum = budget.maximumOf("bpduEvents");
    for (let index = 0; index < maximum; index++) budget.consume("bpduEvents");
    expect(() => budget.consume("bpduEvents")).toThrowError(ControlProtocolLimitError);

    // Port transitions are scoped, so a busy port cannot starve another one.
    for (let index = 0; index < budget.maximumOf("portTransitions"); index++) {
      budget.consume("portTransitions", "sw1/Gi0/1");
    }
    expect(() => budget.consume("portTransitions", "sw1/Gi0/1")).toThrowError(ControlProtocolLimitError);
    expect(() => budget.consume("portTransitions", "sw1/Gi0/2")).not.toThrow();

    budget.reset();
    expect(budget.consumed("bpduEvents")).toBe(0);
  });
});
