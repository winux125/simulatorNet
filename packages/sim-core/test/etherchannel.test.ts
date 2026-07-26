import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  ControlProtocolLimitError,
  createSimulationEngine,
  type EtherChannelMode,
  type EtherChannelSummary,
  hashFlowKey,
  L2Switch,
  macFromIndex,
  Pc,
  portChannelName,
  type SimulationEngine,
} from "@sim/sim-core";

function tracedEngine(seed: number): SimulationEngine {
  const engine = createSimulationEngine({ seed });
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

interface Pair {
  engine: SimulationEngine;
  sw1: L2Switch;
  sw2: L2Switch;
}

/** SW1 and SW2 joined by two parallel links, both in channel group 1. */
function buildPair(left: EtherChannelMode, right: EtherChannelMode, seed = 7): Pair {
  const engine = tracedEngine(seed);
  const sw1 = addSwitch(engine, "sw1", "SW1", 100);
  const sw2 = addSwitch(engine, "sw2", "SW2", 200);
  engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
  engine.connect("sw1", "Gi0/2", "sw2", "Gi0/2");
  for (const port of ["Gi0/1", "Gi0/2"]) {
    sw1.addChannelGroupMember(1, port, left);
    sw2.addChannelGroupMember(1, port, right);
  }
  return { engine, sw1, sw2 };
}

function channel(sw: L2Switch, channelId = 1): EtherChannelSummary {
  const found = sw.etherChannelSummaries().find((entry) => entry.channelId === channelId);
  if (!found) throw new Error(`${sw.name} has no ${portChannelName(channelId)}`);
  return found;
}

function traceTypes(engine: SimulationEngine, ...types: string[]): number {
  return engine.traceLog.filter((entry) => types.includes(entry.type)).length;
}

describe("EtherChannel negotiation", () => {
  it("bundles two static on/on members without any negotiation", () => {
    const { engine, sw1, sw2 } = buildPair("on", "on");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("up");
    expect(channel(sw1).protocol).toBe("static");
    expect(channel(sw1).activeMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(channel(sw2).activeMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(traceTypes(engine, "lacpdu-sent", "pagp-message-sent")).toBe(0);
    expect(traceTypes(engine, "etherchannel-formed")).toBe(2);
  });

  it("bundles LACP active with active", () => {
    const { engine, sw1, sw2 } = buildPair("active", "active");
    engine.runUntilIdle();

    expect(channel(sw1).protocol).toBe("lacp");
    expect(channel(sw1).status).toBe("up");
    expect(channel(sw2).status).toBe("up");
    expect(channel(sw1).members.every((member) => member.state === "distributing")).toBe(true);
    expect(traceTypes(engine, "lacpdu-sent")).toBeGreaterThan(0);
    expect(traceTypes(engine, "lacpdu-received")).toBeGreaterThan(0);
  });

  it("bundles LACP active with passive", () => {
    const { engine, sw1, sw2 } = buildPair("active", "passive");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("up");
    expect(channel(sw2).status).toBe("up");
    expect(channel(sw1).members[0]!.partnerMode).toBe("passive");
    expect(channel(sw2).members[0]!.partnerMode).toBe("active");
  });

  it("never bundles LACP passive with passive", () => {
    const { engine, sw1, sw2 } = buildPair("passive", "passive");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("down");
    expect(channel(sw2).status).toBe("down");
    expect(channel(sw1).activeMembers).toEqual([]);
    // Neither side ever sends the first LACPDU.
    expect(traceTypes(engine, "lacpdu-sent")).toBe(0);
    expect(channel(sw1).members[0]!.reason).toContain("never initiates");
  });

  it("bundles PAgP desirable with desirable", () => {
    const { engine, sw1, sw2 } = buildPair("desirable", "desirable");
    engine.runUntilIdle();

    expect(channel(sw1).protocol).toBe("pagp");
    expect(channel(sw1).status).toBe("up");
    expect(channel(sw2).status).toBe("up");
    expect(traceTypes(engine, "pagp-message-sent")).toBeGreaterThan(0);
    expect(traceTypes(engine, "pagp-message-received")).toBeGreaterThan(0);
  });

  it("bundles PAgP desirable with auto", () => {
    const { engine, sw1, sw2 } = buildPair("desirable", "auto");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("up");
    expect(channel(sw2).status).toBe("up");
    expect(channel(sw2).members[0]!.partnerMode).toBe("desirable");
  });

  it("never bundles PAgP auto with auto", () => {
    const { engine, sw1, sw2 } = buildPair("auto", "auto");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("down");
    expect(channel(sw2).status).toBe("down");
    expect(traceTypes(engine, "pagp-message-sent")).toBe(0);
  });

  it("suspends a static member that receives an LACPDU", () => {
    const { engine, sw1, sw2 } = buildPair("on", "active");
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("down");
    expect(channel(sw1).suspendedMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(channel(sw1).members[0]!.reason).toContain("protocol-mismatch");
    expect(traceTypes(engine, "lacp-member-suspended")).toBeGreaterThan(0);
    expect(channel(sw2).status).toBe("down");
  });

  it("refuses to mix negotiation protocols inside one channel group", () => {
    const engine = tracedEngine(3);
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    sw1.addChannelGroupMember(1, "Gi0/1", "active");
    expect(() => sw1.addChannelGroupMember(1, "Gi0/2", "desirable"))
      .toThrowError(ControlProtocolConfigurationError);
  });

  it("refuses to put one interface in two channel groups", () => {
    const engine = tracedEngine(3);
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    sw1.addChannelGroupMember(1, "Gi0/1", "on");
    expect(() => sw1.addChannelGroupMember(2, "Gi0/1", "on")).toThrowError(/already belongs to Port-channel1/);
  });
});

describe("EtherChannel member compatibility", () => {
  it("suspends a member whose access VLAN differs from the bundle", () => {
    const { engine, sw1 } = buildPair("on", "on");
    sw1.setAccess("Gi0/1", 10);
    sw1.setAccess("Gi0/2", 20);
    engine.runUntilIdle();

    expect(channel(sw1).suspendedMembers).toEqual(["Gi0/2"]);
    expect(channel(sw1).members[1]!.reason).toContain("incompatible switchport configuration");
    expect(channel(sw1).activeMembers).toEqual(["Gi0/1"]);
    expect(channel(sw1).status).toBe("up"); // one good link keeps the bundle up
  });

  it("suspends a member whose trunk configuration differs from the bundle", () => {
    const { engine, sw1 } = buildPair("on", "on");
    sw1.setTrunk("Gi0/1", { allowedVlans: [10, 20] });
    sw1.setTrunk("Gi0/2", { allowedVlans: [10, 30] });
    engine.runUntilIdle();

    expect(channel(sw1).suspendedMembers).toEqual(["Gi0/2"]);
    // The stored member configuration is never silently rewritten.
    const summaries = new Map(sw1.portSummaries().map((row) => [row.name, row]));
    expect(summaries.get("Gi0/2")!.allowedVlans).toEqual([10, 30]);
  });

  it("bundles members that share a compatible trunk configuration", () => {
    const { engine, sw1, sw2 } = buildPair("on", "on");
    for (const sw of [sw1, sw2]) {
      sw.defineVlan(10);
      sw.defineVlan(20);
      for (const port of ["Gi0/1", "Gi0/2"]) sw.setTrunk(port, { allowedVlans: [10, 20] });
    }
    engine.runUntilIdle();

    expect(channel(sw1).suspendedMembers).toEqual([]);
    expect(channel(sw1).activeMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(sw1.trunkSummary().map((row) => row.port)).toEqual(["Port-channel1"]);
  });

  it("lets an unconfigured member inherit an explicitly configured Port-channel", () => {
    const { engine, sw1 } = buildPair("on", "on");
    sw1.defineVlan(30);
    sw1.setTrunk("Port-channel1", { allowedVlans: [30] });
    engine.runUntilIdle();

    // The members never carried their own switchport configuration, so they
    // inherit Po1 instead of being suspended, and their stored configuration
    // is left exactly as it was.
    expect(channel(sw1).suspendedMembers).toEqual([]);
    expect(channel(sw1).activeMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(sw1.portConfigOf("Gi0/1").mode).toBe("trunk");
    expect(sw1.rawPortConfigOf("Gi0/1").mode).toBe("access");
  });

  it("suspends a member that carries its own conflicting configuration", () => {
    const { engine, sw1 } = buildPair("on", "on");
    sw1.defineVlan(30);
    sw1.setTrunk("Port-channel1", { allowedVlans: [30] });
    sw1.setAccess("Gi0/2", 30);
    engine.runUntilIdle();

    expect(channel(sw1).suspendedMembers).toEqual(["Gi0/2"]);
    expect(channel(sw1).activeMembers).toEqual(["Gi0/1"]);
  });
});

describe("EtherChannel frame distribution", () => {
  it("keeps one flow on one member and spreads different flows", () => {
    const { engine, sw1 } = buildPair("on", "on");
    engine.runUntilIdle();

    const chosen = new Set<string>();
    const repeats = new Set<string>();
    for (let index = 0; index < 12; index++) {
      const key = `02:00:00:00:00:01|02:00:00:00:0${index}:99`;
      const member = sw1.etherChannel.selectMember(1, key);
      chosen.add(member!);
      // The same flow key must always land on the same member.
      repeats.add(`${key}=>${sw1.etherChannel.selectMember(1, key)!}`);
      expect(sw1.etherChannel.selectMember(1, key)).toBe(member);
    }
    expect(chosen.size).toBe(2);
    expect(repeats.size).toBe(12);
  });

  it("selects members with a stable, seed-free hash", () => {
    expect(hashFlowKey("a|b")).toBe(hashFlowKey("a|b"));
    expect(hashFlowKey("a|b")).not.toBe(hashFlowKey("b|a"));
    const { engine, sw1 } = buildPair("on", "on", 11);
    const other = buildPair("on", "on", 11);
    engine.runUntilIdle();
    other.engine.runUntilIdle();
    expect(other.sw1.etherChannel.selectMember(1, "flow")).toBe(sw1.etherChannel.selectMember(1, "flow"));
  });

  it("floods exactly one copy of a frame through the bundle", () => {
    const { engine, sw1, sw2 } = buildPair("on", "on");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    const pc2 = addPc(engine, "pc2", "10.0.0.2", 12);
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.connect("sw2", "Gi0/3", "pc2", "eth0");
    engine.runUntilIdle();

    const before = engine.traceLog.length;
    pc1.ping("10.0.0.2", 1);
    engine.runUntilIdle();

    expect(pc1.pingResults.at(-1)).toMatchObject({ sequence: 1, success: true });
    const selections = engine.traceLog.slice(before)
      .filter((entry) => entry.type === "etherchannel-frame-member-selected" && entry.device === "sw1");
    expect(selections.length).toBeGreaterThan(0);
    // The forwarding database holds the bundle, not the individual members.
    expect(sw2.macAddressTable().some((row) => row.port === "Port-channel1")).toBe(true);
  });
});

describe("EtherChannel failure and recovery", () => {
  it("keeps the bundle up when one member fails", () => {
    const { engine, sw1, sw2 } = buildPair("active", "passive");
    const pc1 = addPc(engine, "pc1", "10.0.0.1", 11);
    const pc2 = addPc(engine, "pc2", "10.0.0.2", 12);
    engine.connect("sw1", "Gi0/3", "pc1", "eth0");
    engine.connect("sw2", "Gi0/3", "pc2", "eth0");
    engine.runUntilIdle();

    sw1.getInterface("Gi0/1")!.shutdown();
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("up");
    expect(channel(sw1).activeMembers).toEqual(["Gi0/2"]);
    pc1.ping("10.0.0.2", 2);
    engine.runUntilIdle();
    expect(pc1.pingResults.at(-1)).toMatchObject({ sequence: 2, success: true });
    expect(channel(sw2).activeMembers).toEqual(["Gi0/2"]);
  });

  it("brings the Port-channel down when every member fails", () => {
    const { engine, sw1 } = buildPair("on", "on");
    engine.runUntilIdle();

    for (const port of ["Gi0/1", "Gi0/2"]) sw1.getInterface(port)!.shutdown();
    engine.runUntilIdle();

    expect(channel(sw1).status).toBe("down");
    expect(channel(sw1).activeMembers).toEqual([]);
    expect(traceTypes(engine, "etherchannel-down")).toBeGreaterThan(0);
  });

  it("re-adds a member when its link comes back", () => {
    const { engine, sw1 } = buildPair("active", "active");
    engine.runUntilIdle();
    sw1.getInterface("Gi0/1")!.shutdown();
    engine.runUntilIdle();
    expect(channel(sw1).activeMembers).toEqual(["Gi0/2"]);

    sw1.getInterface("Gi0/1")!.noShutdown();
    engine.runUntilIdle();

    expect(channel(sw1).activeMembers).toEqual(["Gi0/1", "Gi0/2"]);
    expect(channel(sw1).status).toBe("up");
  });

  it("holds the bundle down while fewer than minimum-links members are active", () => {
    const { engine, sw1 } = buildPair("on", "on");
    sw1.etherChannel.setMinimumLinks(1, 2);
    engine.runUntilIdle();
    expect(channel(sw1).status).toBe("up");

    sw1.getInterface("Gi0/1")!.shutdown();
    engine.runUntilIdle();
    expect(channel(sw1).status).toBe("down");
  });
});

describe("EtherChannel and spanning tree", () => {
  it("presents the bundle to spanning tree as a single logical port", () => {
    const { engine, sw1, sw2 } = buildPair("on", "on");
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    engine.runUntilIdle();

    const ports = sw1.spanningTreeSummary().instances[0]!.ports.map((entry) => entry.port);
    expect(ports).toContain("Port-channel1");
    expect(ports).not.toContain("Gi0/1");
    expect(ports).not.toContain("Gi0/2");
    // A single logical port means the parallel links are never seen as a loop.
    expect(sw2.spanningTreeSummary().instances[0]!.ports
      .filter((entry) => entry.role === "alternate")).toEqual([]);
  });

  it("blocks the redundant Port-channel when two bundles join the same switches", () => {
    const engine = tracedEngine(17);
    const sw1 = addSwitch(engine, "sw1", "SW1", 100);
    const sw2 = addSwitch(engine, "sw2", "SW2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw1", "Gi0/2", "sw2", "Gi0/2");
    engine.connect("sw1", "Gi0/3", "sw2", "Gi0/3");
    engine.connect("sw1", "Gi0/4", "sw2", "Gi0/4");
    for (const sw of [sw1, sw2]) {
      sw.addChannelGroupMember(1, "Gi0/1", "on");
      sw.addChannelGroupMember(1, "Gi0/2", "on");
      sw.addChannelGroupMember(2, "Gi0/3", "on");
      sw.addChannelGroupMember(2, "Gi0/4", "on");
    }
    engine.runUntilIdle();

    const sw2Ports = new Map(sw2.spanningTreeSummary().instances[0]!.ports.map((entry) => [entry.port, entry]));
    expect(sw2Ports.get("Port-channel1")!.role).toBe("root");
    expect(sw2Ports.get("Port-channel2")!.role).toBe("alternate");
    expect(sw2Ports.get("Port-channel2")!.state).toBe("blocking");
  });
});

describe("EtherChannel configuration, determinism and limits", () => {
  it("round-trips channel configuration without any negotiation runtime", () => {
    const { engine, sw1 } = buildPair("active", "active");
    engine.runUntilIdle();

    expect(sw1.etherChannelConfigurations()).toEqual([
      { channelId: 1, protocol: "lacp", mode: "active", members: ["Gi0/1", "Gi0/2"], minimumLinks: undefined },
    ]);
    const serialized = JSON.stringify(sw1.etherChannelConfigurations());
    for (const runtimeField of ["distributing", "partner", "selectedFrames", "state"]) {
      expect(serialized).not.toContain(runtimeField);
    }

    sw1.etherChannel.resetRuntime();
    expect(sw1.etherChannelConfigurations()[0]!.members).toEqual(["Gi0/1", "Gi0/2"]);
    expect(channel(sw1).members.every((member) => member.selectedFrames === 0)).toBe(true);
  });

  it("produces a stable golden trace of LACP bundle formation", () => {
    const { engine } = buildPair("active", "passive", 5);
    engine.runUntilIdle();

    const golden = engine.traceLog
      .filter((entry) => entry.device === "sw2")
      .filter((entry) => entry.type === "lacp-member-selected" || entry.type === "etherchannel-formed")
      .map((entry) => `${entry.type}:${String(entry.detail?.interface ?? entry.detail?.name)}:${String(entry.detail?.state ?? entry.detail?.protocol)}`);

    // The passive side learns one partner per LACPDU, so Po1 comes up as soon
    // as the first member is selected and the second joins the live bundle.
    expect(golden).toEqual([
      "lacp-member-selected:Gi0/1:distributing",
      "etherchannel-formed:Port-channel1:lacp",
      "lacp-member-selected:Gi0/2:distributing",
    ]);
  });

  it("reaches an identical result from two independent engine builds", () => {
    const first = buildPair("active", "passive", 61);
    const second = buildPair("active", "passive", 61);
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    expect(second.sw1.etherChannelSummaries()).toEqual(first.sw1.etherChannelSummaries());
    expect(second.sw2.etherChannelSummaries()).toEqual(first.sw2.etherChannelSummaries());
    expect(second.engine.now()).toBe(first.engine.now());
  });

  it("enforces the per-device channel and per-channel member limits", () => {
    const engine = tracedEngine(71);
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    for (let index = 1; index <= 80; index++) sw1.addInterface(`Gi0/${index}`, macFromIndex(1_000 + index));

    for (let channelId = 1; channelId <= 64; channelId++) {
      sw1.addChannelGroupMember(channelId, `Gi0/${channelId}`, "on");
    }
    expect(() => sw1.addChannelGroupMember(65, "Gi0/65", "on")).toThrowError(ControlProtocolLimitError);

    const wide = tracedEngine(73);
    const sw2 = wide.add(new L2Switch("sw2", "SW2"));
    for (let index = 1; index <= 12; index++) sw2.addInterface(`Gi0/${index}`, macFromIndex(2_000 + index));
    for (let index = 1; index <= 8; index++) sw2.addChannelGroupMember(1, `Gi0/${index}`, "on");
    expect(() => sw2.addChannelGroupMember(1, "Gi0/9", "on")).toThrowError(ControlProtocolLimitError);
  });
});
