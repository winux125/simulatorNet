import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  ControlProtocolLimitError,
  createSimulationEngine,
  DEFAULT_CDP_HOLD_TIME_NS,
  DEFAULT_LLDP_HOLD_TIME_NS,
  type DiscoveryNeighbor,
  L2Switch,
  Layer3Switch,
  macFromIndex,
  NS_PER_S,
  Pc,
  Router,
  Server,
  type SimulationEngine,
} from "@sim/sim-core";

function tracedEngine(seed: number): SimulationEngine {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  return engine;
}

function traceTypes(engine: SimulationEngine, ...types: string[]): number {
  return engine.traceLog.filter((entry) => types.includes(entry.type)).length;
}

function neighbors(device: { discovery: { neighborTable(): DiscoveryNeighbor[] } }): DiscoveryNeighbor[] {
  return device.discovery.neighborTable();
}

/** R1 (Gi0/0) — (Gi0/1) SW1 (Gi0/2) — (Gi0/1) SW2, plus PC1 on SW1 Gi0/3. */
interface Campus {
  engine: SimulationEngine;
  r1: Router;
  sw1: L2Switch;
  sw2: L2Switch;
  pc1: Pc;
}

function buildCampus(seed = 7): Campus {
  const engine = tracedEngine(seed);
  const r1 = engine.add(new Router("r1", "R1"));
  r1.addInterface("Gi0/0", macFromIndex(11));
  r1.addInterface("Gi0/1", macFromIndex(12));
  r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });

  const sw1 = engine.add(new L2Switch("sw1", "SW1"));
  const sw2 = engine.add(new L2Switch("sw2", "SW2"));
  for (const [sw, base] of [[sw1, 100], [sw2, 200]] as const) {
    for (let index = 1; index <= 4; index++) sw.addInterface(`Gi0/${index}`, macFromIndex(base + index));
  }
  const pc1 = engine.add(new Pc("pc1", "PC1"));
  pc1.addInterface("eth0", macFromIndex(51));
  pc1.configure({ ip: "10.0.0.50", mask: 24, gateway: "10.0.0.1" });

  engine.connect("r1", "Gi0/0", "sw1", "Gi0/1");
  engine.connect("sw1", "Gi0/2", "sw2", "Gi0/1");
  engine.connect("sw1", "Gi0/3", "pc1", "eth0");
  return { engine, r1, sw1, sw2, pc1 };
}

function enableCdp(...devices: Array<Router | L2Switch>): void {
  for (const device of devices) device.discovery.setCdpEnabled(true);
}

function enableLldp(...devices: Array<Router | L2Switch | Server>): void {
  for (const device of devices) device.discovery.setLldpEnabled(true);
}

describe("CDP discovery", () => {
  it("discovers a directly connected router from a switch", () => {
    const { engine, r1, sw1 } = buildCampus();
    enableCdp(r1, sw1);
    engine.runUntilIdle();

    const entry = neighbors(sw1).find((neighbor) => neighbor.deviceId === "R1");
    expect(entry).toMatchObject({
      protocol: "cdp",
      localInterface: "Gi0/1",
      deviceId: "R1",
      remoteInterface: "Gi0/0",
      platform: "SimulatorNet Router",
    });
    expect(entry!.capabilities).toEqual(["router"]);
    expect(entry!.softwareVersion).toContain("SimulatorNet");
  });

  it("discovers a directly connected switch", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableCdp(sw1, sw2);
    engine.runUntilIdle();

    expect(neighbors(sw2).map((neighbor) => neighbor.deviceId)).toEqual(["SW1"]);
    expect(neighbors(sw1).find((neighbor) => neighbor.deviceId === "SW2")?.localInterface).toBe("Gi0/2");
    expect(neighbors(sw2)[0]!.capabilities).toEqual(["switch", "bridge"]);
  });

  it("advertises the router management address", () => {
    const { engine, r1, sw1 } = buildCampus();
    enableCdp(r1, sw1);
    engine.runUntilIdle();

    expect(neighbors(sw1).find((neighbor) => neighbor.deviceId === "R1")?.managementAddress).toBe("10.0.0.1");
  });

  it("never traverses a router", () => {
    const engine = tracedEngine(11);
    const r1 = engine.add(new Router("r1", "R1"));
    r1.addInterface("Gi0/0", macFromIndex(11));
    r1.addInterface("Gi0/1", macFromIndex(12));
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    r1.configureInterface("Gi0/1", { ip: "10.0.1.1", mask: 24 });
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    const sw2 = engine.add(new L2Switch("sw2", "SW2"));
    for (const [sw, base] of [[sw1, 100], [sw2, 200]] as const) {
      for (let index = 1; index <= 2; index++) sw.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    }
    engine.connect("r1", "Gi0/0", "sw1", "Gi0/1");
    engine.connect("r1", "Gi0/1", "sw2", "Gi0/1");
    enableCdp(r1, sw1, sw2);
    engine.runUntilIdle();

    // Each switch sees only the router, never the switch on the far side.
    expect(neighbors(sw1).map((neighbor) => neighbor.deviceId)).toEqual(["R1"]);
    expect(neighbors(sw2).map((neighbor) => neighbor.deviceId)).toEqual(["R1"]);
    expect(neighbors(r1).map((neighbor) => neighbor.deviceId).sort()).toEqual(["SW1", "SW2"]);
  });

  it("stays silent while CDP is disabled globally", () => {
    const { engine, r1, sw1 } = buildCampus();
    enableCdp(sw1); // R1 leaves CDP off
    engine.runUntilIdle();

    expect(neighbors(sw1)).toEqual([]);
    expect(neighbors(r1)).toEqual([]);
    expect(traceTypes(engine, "cdp-advertisement-sent")).toBeGreaterThan(0);
    expect(traceTypes(engine, "cdp-neighbor-added")).toBe(0);
  });

  it("honours a per-interface CDP disable", () => {
    const { engine, r1, sw1, sw2 } = buildCampus();
    enableCdp(r1, sw1, sw2);
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(2);

    sw1.discovery.setInterfaceCdpEnabled("Gi0/2", false);
    engine.runUntilIdle();

    expect(neighbors(sw1).map((neighbor) => neighbor.deviceId)).toEqual(["R1"]);
    // The explicit withdrawal cleared SW2's table too.
    expect(neighbors(sw2)).toEqual([]);
  });

  it("expires a neighbour once its hold time passes in virtual time", () => {
    const { engine, r1, sw1 } = buildCampus();
    enableCdp(r1, sw1);
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(1);

    engine.advanceTo(engine.now() + DEFAULT_CDP_HOLD_TIME_NS + NS_PER_S);

    expect(neighbors(sw1)).toEqual([]);
    expect(traceTypes(engine, "cdp-neighbor-expired")).toBeGreaterThan(0);
  });

  it("clears the neighbour table when the local link goes down", () => {
    const { engine, r1, sw1 } = buildCampus();
    enableCdp(r1, sw1);
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(1);

    sw1.getInterface("Gi0/1")!.shutdown();
    engine.runUntilIdle();

    expect(neighbors(sw1)).toEqual([]);
    expect(neighbors(r1)).toEqual([]);
  });

  it("refuses CDP on a vendor-neutral station", () => {
    const engine = tracedEngine(13);
    const server = engine.add(new Server("srv1", "SRV1"));
    server.addInterface("eth0", macFromIndex(61));
    expect(() => server.discovery.setCdpEnabled(true)).toThrowError(ControlProtocolConfigurationError);
  });
});

describe("LLDP discovery", () => {
  it("discovers a neighbour in both directions", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableLldp(sw1, sw2);
    engine.runUntilIdle();

    expect(neighbors(sw1).map((neighbor) => neighbor.deviceId)).toEqual(["SW2"]);
    expect(neighbors(sw2)[0]).toMatchObject({
      protocol: "lldp",
      deviceId: "SW1",
      localInterface: "Gi0/1",
      remoteInterface: "Gi0/2",
    });
  });

  it("supports a transmit-only port", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableLldp(sw1, sw2);
    sw1.discovery.setInterfaceLldpReceive("Gi0/2", false);
    engine.runUntilIdle();

    expect(neighbors(sw1)).toEqual([]);
    expect(neighbors(sw2).map((neighbor) => neighbor.deviceId)).toEqual(["SW1"]);
  });

  it("supports a receive-only port", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableLldp(sw1, sw2);
    sw1.discovery.setInterfaceLldpTransmit("Gi0/2", false);
    engine.runUntilIdle();

    expect(neighbors(sw2)).toEqual([]);
    expect(neighbors(sw1).map((neighbor) => neighbor.deviceId)).toEqual(["SW2"]);
  });

  it("stays silent while LLDP is disabled globally", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableLldp(sw1);
    engine.runUntilIdle();

    expect(neighbors(sw1)).toEqual([]);
    expect(neighbors(sw2)).toEqual([]);
  });

  it("expires an entry once the advertised TTL passes", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableLldp(sw1, sw2);
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(1);

    engine.advanceTo(engine.now() + DEFAULT_LLDP_HOLD_TIME_NS + NS_PER_S);

    expect(neighbors(sw1)).toEqual([]);
    expect(traceTypes(engine, "lldp-neighbor-expired")).toBeGreaterThan(0);
  });

  it("lets a server take part as a vendor-neutral station", () => {
    const engine = tracedEngine(17);
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    sw1.addInterface("Gi0/1", macFromIndex(101));
    const server = engine.add(new Server("srv1", "SRV1"));
    server.addInterface("eth0", macFromIndex(61));
    server.configure({ ip: "10.0.0.9", mask: 24 });
    engine.connect("sw1", "Gi0/1", "srv1", "eth0");
    enableLldp(sw1, server);
    engine.runUntilIdle();

    expect(neighbors(sw1)[0]).toMatchObject({ deviceId: "SRV1", remoteInterface: "eth0" });
    expect(neighbors(sw1)[0]!.capabilities).toEqual(["station"]);
    expect(neighbors(server)[0]).toMatchObject({ deviceId: "SW1", localInterface: "eth0" });
    expect(neighbors(sw1)[0]!.managementAddress).toBe("10.0.0.9");
  });
});

describe("Discovery coexistence and isolation", () => {
  it("runs CDP and LLDP side by side without duplicating entries", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableCdp(sw1, sw2);
    enableLldp(sw1, sw2);
    engine.runUntilIdle();

    const table = neighbors(sw1);
    expect(table.map((neighbor) => neighbor.protocol)).toEqual(["cdp", "lldp"]);
    expect(new Set(table.map((neighbor) => neighbor.deviceId))).toEqual(new Set(["SW2"]));

    // Repeated advertisements refresh instead of appending.
    engine.advanceTo(engine.now() + 5 * NS_PER_S);
    sw1.discovery.arm();
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(2);
  });

  it("keeps discovery frames out of IP routing and the ACL pipeline", () => {
    const { engine, r1, sw1 } = buildCampus();
    r1.defineAcl({ id: "1", type: "standard", rules: [{ sequence: 10, action: "deny", source: { kind: "any" } }] });
    r1.applyAcl("Gi0/0", "in", "1");
    enableCdp(r1, sw1);
    enableLldp(r1, sw1);
    engine.runUntilIdle();

    // The deny-any ACL never sees a link-local advertisement.
    expect(neighbors(r1).map((neighbor) => neighbor.deviceId)).toEqual(["SW1", "SW1"]);
    expect(traceTypes(engine, "acl-evaluated", "acl-denied", "acl-implicit-deny")).toBe(0);
    expect(traceTypes(engine, "route", "nat-translated")).toBe(0);
  });

  it("keeps discovering across a spanning-tree blocking port", () => {
    const engine = tracedEngine(23);
    const switches = ["sw1", "sw2", "sw3"].map((id, index) => {
      const sw = engine.add(new L2Switch(id, id.toUpperCase()));
      for (let port = 1; port <= 3; port++) sw.addInterface(`Gi0/${port}`, macFromIndex(100 * (index + 1) + port));
      sw.setSpanningTreeMode("stp");
      sw.discovery.setCdpEnabled(true);
      return sw;
    });
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw2", "Gi0/2", "sw3", "Gi0/1");
    engine.connect("sw3", "Gi0/2", "sw1", "Gi0/2");
    engine.runUntilIdle();

    const sw3 = switches[2]!;
    const blocked = sw3.spanningTreeSummary().instances[0]!.ports.find((port) => port.role === "alternate");
    expect(blocked?.port).toBe("Gi0/1");
    // Documented rule: a blocking port stops user data, never link-local control.
    expect(neighbors(sw3).map((neighbor) => neighbor.localInterface).sort()).toEqual(["Gi0/1", "Gi0/2"]);
  });

  it("discovers an L3 switch with both switch and router capabilities", () => {
    const engine = tracedEngine(29);
    const l3 = engine.add(new Layer3Switch("l3", "L3SW"));
    for (let index = 1; index <= 3; index++) l3.addInterface(`Gi0/${index}`, macFromIndex(300 + index));
    l3.setSviIp(1, "10.0.0.2", 24);
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    sw1.addInterface("Gi0/1", macFromIndex(101));
    engine.connect("l3", "Gi0/1", "sw1", "Gi0/1");
    enableCdp(l3, sw1);
    engine.runUntilIdle();

    expect(neighbors(sw1)[0]).toMatchObject({
      deviceId: "L3SW",
      platform: "SimulatorNet L3 Switch",
      managementAddress: "10.0.0.2",
    });
    expect(neighbors(sw1)[0]!.capabilities).toEqual(["switch", "router"]);
  });
});

describe("Discovery configuration, determinism and limits", () => {
  it("keeps the neighbour table out of the persistent configuration", () => {
    const { engine, sw1, sw2 } = buildCampus();
    enableCdp(sw1, sw2);
    sw1.discovery.setInterfaceLldpTransmit("Gi0/1", false);
    engine.runUntilIdle();
    expect(neighbors(sw1).length).toBe(1);

    const configuration = sw1.discovery.configuration();
    expect(configuration).toMatchObject({ cdpEnabled: true, lldpEnabled: false });
    expect(configuration.interfaces).toEqual([
      { id: "Gi0/1", configuration: { cdpEnabled: true, lldpTransmit: false, lldpReceive: true } },
    ]);
    const serialized = JSON.stringify(configuration);
    for (const runtimeField of ["lastSeen", "expiresAt", "remoteInterface", "SW2"]) {
      expect(serialized).not.toContain(runtimeField);
    }

    sw1.discovery.resetRuntime();
    expect(sw1.discovery.neighborTable()).toEqual([]);
    expect(sw1.discovery.configuration().interfaces).toEqual(configuration.interfaces);
  });

  it("round-trips global and per-interface configuration", () => {
    const { sw1 } = buildCampus();
    sw1.discovery.setCdpEnabled(true);
    sw1.discovery.setLldpEnabled(true);
    sw1.discovery.setTimers({ cdpIntervalNs: 30 * NS_PER_S, lldpHoldTimeNs: 90 * NS_PER_S });
    sw1.discovery.setInterfaceCdpEnabled("Gi0/4", false);

    expect(sw1.discovery.configuration()).toEqual({
      cdpEnabled: true,
      lldpEnabled: true,
      cdpIntervalNs: 30 * NS_PER_S,
      cdpHoldTimeNs: DEFAULT_CDP_HOLD_TIME_NS,
      lldpIntervalNs: 30 * NS_PER_S,
      lldpHoldTimeNs: 90 * NS_PER_S,
      interfaces: [
        { id: "Gi0/4", configuration: { cdpEnabled: false, lldpTransmit: true, lldpReceive: true } },
      ],
    });
    expect(() => sw1.discovery.setTimers({ cdpHoldTimeNs: 0 })).toThrowError(ControlProtocolConfigurationError);
  });

  it("produces a stable golden trace of discovery on one link", () => {
    const engine = tracedEngine(31);
    const sw1 = engine.add(new L2Switch("sw1", "SW1"));
    const sw2 = engine.add(new L2Switch("sw2", "SW2"));
    for (const [sw, base] of [[sw1, 100], [sw2, 200]] as const) {
      sw.addInterface("Gi0/1", macFromIndex(base + 1));
    }
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    enableCdp(sw1, sw2);
    engine.runUntilIdle();

    const golden = engine.traceLog
      .filter((entry) => entry.device === "sw2")
      .filter((entry) => entry.type.startsWith("cdp-"))
      .map((entry) => `${entry.type}:${String(entry.detail?.interface)}:${String(entry.detail?.deviceId)}`);

    // One neighbour is added once; the remaining rounds only refresh it, and
    // the bounded activity window then closes instead of running for ever.
    expect(golden).toEqual([
      "cdp-advertisement-sent:Gi0/1:SW2",
      "cdp-advertisement-received:Gi0/1:SW1",
      "cdp-neighbor-added:Gi0/1:SW1",
      "cdp-advertisement-sent:Gi0/1:SW2",
      "cdp-advertisement-received:Gi0/1:SW1",
      "cdp-advertisement-sent:Gi0/1:SW2",
      "cdp-advertisement-received:Gi0/1:SW1",
      "cdp-advertisement-sent:Gi0/1:SW2",
      "cdp-advertisement-received:Gi0/1:SW1",
    ]);
  });

  it("reaches an identical table from two independent engine builds", () => {
    const first = buildCampus(97);
    const second = buildCampus(97);
    for (const campus of [first, second]) {
      enableCdp(campus.r1, campus.sw1, campus.sw2);
      enableLldp(campus.r1, campus.sw1, campus.sw2);
      campus.engine.runUntilIdle();
    }

    expect(neighbors(second.sw1)).toEqual(neighbors(first.sw1));
    expect(neighbors(second.r1)).toEqual(neighbors(first.r1));
    expect(second.engine.now()).toBe(first.engine.now());
  });

  it("enforces the per-device neighbour limit", () => {
    const engine = tracedEngine(41);
    const hub = engine.add(new L2Switch("sw1", "SW1"));
    for (let index = 1; index <= 70; index++) hub.addInterface(`Gi0/${index}`, macFromIndex(1_000 + index));
    hub.discovery.setCdpEnabled(true);
    for (let index = 1; index <= 70; index++) {
      const peer = engine.add(new L2Switch(`peer${index}`, `PEER${index}`));
      peer.addInterface("Gi0/1", macFromIndex(5_000 + index));
      peer.discovery.setCdpEnabled(true);
      engine.connect("sw1", `Gi0/${index}`, `peer${index}`, "Gi0/1");
    }

    expect(() => engine.runUntilIdle()).toThrowError(ControlProtocolLimitError);
  });
});
