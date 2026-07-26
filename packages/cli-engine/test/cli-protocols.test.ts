import { createCliSession, type CliSession } from "@sim/cli-engine";
import {
  createSimulationEngine,
  L2Switch,
  macFromIndex,
  Router,
  type SimulationEngine,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function engineWith(seed = 7): SimulationEngine {
  const engine = createSimulationEngine({ seed });
  engine.enableTrace();
  return engine;
}

function addSwitch(engine: SimulationEngine, id: string, macBase: number, ports = 4): L2Switch {
  const sw = engine.add(new L2Switch(id, id.toUpperCase()));
  for (let index = 1; index <= ports; index++) sw.addInterface(`Gi0/${index}`, macFromIndex(macBase + index));
  return sw;
}

function addRouter(engine: SimulationEngine, id: string, macBase: number, ports = 2): Router {
  const router = engine.add(new Router(id, id.toUpperCase()));
  for (let index = 0; index < ports; index++) router.addInterface(`Gi0/${index}`, macFromIndex(macBase + index));
  return router;
}

function run(session: CliSession, ...lines: string[]): string {
  return lines.map((line) => session.execute(line)).at(-1) ?? "";
}

describe("Spanning-tree CLI", () => {
  it("configures mode, priority and per-port settings", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal", "spanning-tree mode rapid-pvst");
    expect(sw1.spanningTreeMode).toBe("rstp");

    run(session, "spanning-tree vlan 10 priority 24576");
    expect(sw1.spanningTree.bridgePriorityOf(10)).toBe(24_576);

    run(session, "spanning-tree vlan 20 root primary");
    expect(sw1.spanningTree.bridgePriorityOf(20)).toBe(24_576);
    run(session, "spanning-tree vlan 30 root secondary");
    expect(sw1.spanningTree.bridgePriorityOf(30)).toBe(28_672);

    run(session, "interface Gi0/1", "spanning-tree cost 19", "spanning-tree port-priority 64",
      "spanning-tree portfast", "spanning-tree bpduguard enable");
    const port = sw1.spanningTree.portConfigurationOf("Gi0/1");
    expect(port).toMatchObject({ cost: 19, priority: 64, portFast: true, bpduGuard: true });
  });

  it("rejects a priority that is not a valid increment", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    const output = run(session, "enable", "configure terminal", "spanning-tree vlan 10 priority 1000");
    expect(output).toContain("multiple of 4096");
    expect(sw1.spanningTree.bridgePriorityOf(10)).toBe(32_768);
  });

  it("renders show spanning-tree and its summary", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const sw2 = addSwitch(engine, "sw2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();

    const session = createCliSession(sw1, engine);
    const output = run(session, "enable", "show spanning-tree");
    expect(output).toContain("VLAN0001");
    expect(output).toContain("This bridge is the root");
    expect(output).toContain("Gi0/1");

    expect(run(session, "show spanning-tree summary")).toContain("Switch is in pvst mode");
    expect(run(session, "show spanning-tree vlan 1")).toContain("Bridge ID");
    expect(run(session, "show spanning-tree interface Gi0/1")).toContain("designated");
  });

  it("reports that spanning tree is disabled by default", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    expect(run(session, "enable", "show spanning-tree")).toContain("Spanning tree is disabled");
  });

  it("recovers an error-disabled port", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const sw2 = addSwitch(engine, "sw2", 200);
    for (const sw of [sw1, sw2]) sw.setSpanningTreeMode("stp");
    sw2.spanningTree.setBpduGuard("Gi0/1", true);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.runUntilIdle();
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(true);

    const session = createCliSession(sw2, engine);
    expect(run(session, "enable", "errdisable recovery Gi0/1")).toContain("recovered");
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(false);
  });
});

describe("EtherChannel CLI", () => {
  it("configures a channel group over an interface range", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal", "interface range Gi0/1 - 2", "channel-group 1 mode active");

    expect(sw1.etherChannelConfigurations()).toEqual([
      { channelId: 1, protocol: "lacp", mode: "active", members: ["Gi0/1", "Gi0/2"], minimumLinks: undefined },
    ]);
  });

  it("never applies a partial range when one member is invalid", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    const output = run(session, "enable", "configure terminal", "interface range Gi0/3 - 9");

    expect(output).toContain("not found");
    // The range never entered interface configuration, so nothing was changed.
    expect(sw1.etherChannelConfigurations()).toEqual([]);
    expect(sw1.etherChannel.channelOf("Gi0/3")).toBeUndefined();
  });

  it("configures the Port-channel switchport and shows the bundle", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const sw2 = addSwitch(engine, "sw2", 200);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    engine.connect("sw1", "Gi0/2", "sw2", "Gi0/2");
    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal",
      "vlan 10", "exit",
      "vlan 20", "exit",
      "interface range Gi0/1 - 2", "channel-group 1 mode on", "exit",
      "interface Port-channel1", "switchport mode trunk", "switchport trunk allowed vlan 10,20", "end");
    const peer = createCliSession(sw2, engine);
    run(peer, "enable", "configure terminal", "interface range Gi0/1 - 2", "channel-group 1 mode on", "end");
    engine.runUntilIdle();

    const summary = run(session, "show etherchannel summary");
    expect(summary).toContain("Port-channel1(SU)");
    expect(summary).toContain("Gi0/1(P)");
    expect(run(session, "show interfaces port-channel")).toContain("Port-channel1");
    expect(sw1.portConfigOf("Gi0/1").mode).toBe("trunk");
  });

  it("shows LACP and PAgP neighbours", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const sw2 = addSwitch(engine, "sw2", 200);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    for (const [sw, mode] of [[sw1, "active"], [sw2, "passive"]] as const) {
      sw.addChannelGroupMember(1, "Gi0/1", mode);
    }
    engine.runUntilIdle();

    const session = createCliSession(sw1, engine);
    expect(run(session, "enable", "show lacp neighbor")).toContain("Port-channel1");
    expect(run(session, "show pagp neighbor")).toContain("No PAGP neighbours");
  });
});

describe("Discovery CLI", () => {
  it("enables CDP and LLDP and shows the neighbour tables", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    engine.connect("sw1", "Gi0/1", "r1", "Gi0/0");

    const switchSession = createCliSession(sw1, engine);
    const routerSession = createCliSession(r1, engine);
    run(switchSession, "enable", "configure terminal", "cdp run", "lldp run", "end");
    run(routerSession, "enable", "configure terminal", "cdp run", "lldp run", "end");
    engine.runUntilIdle();

    const cdp = run(switchSession, "show cdp neighbors");
    expect(cdp).toContain("R1");
    expect(cdp).toContain("SimulatorNet Router");
    expect(run(switchSession, "show cdp neighbors detail")).toContain("Entry address(es): 10.0.0.1");
    expect(run(switchSession, "show lldp neighbors")).toContain("R1");
    expect(run(switchSession, "show cdp interface")).toContain("Gi0/1");
    expect(run(switchSession, "show lldp interface")).toContain("Gi0/1");
  });

  it("disables discovery per interface and clears a table", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const sw2 = addSwitch(engine, "sw2", 200);
    engine.connect("sw1", "Gi0/1", "sw2", "Gi0/1");
    for (const sw of [sw1, sw2]) sw.discovery.setCdpEnabled(true);
    engine.runUntilIdle();
    expect(sw1.discovery.neighborTable().length).toBe(1);

    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal", "interface Gi0/1", "no cdp enable", "end");
    expect(sw1.discovery.neighborTable()).toEqual([]);

    expect(run(session, "clear cdp table")).toContain("Cleared 0 CDP neighbour entries");
  });

  it("refuses CDP where it is not supported and reports a disabled protocol", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    expect(run(session, "enable", "show cdp neighbors")).toContain("CDP is not enabled");
    expect(run(session, "show lldp neighbors")).toContain("LLDP is not enabled");
  });
});

describe("Loopback and OSPF CLI", () => {
  function twoRouters() {
    const engine = engineWith();
    const r1 = addRouter(engine, "r1", 10);
    const r2 = addRouter(engine, "r2", 20);
    engine.connect("r1", "Gi0/0", "r2", "Gi0/0");
    return { engine, r1, r2 };
  }

  it("configures a loopback, the process and the interface settings", () => {
    const { engine, r1 } = twoRouters();
    const session = createCliSession(r1, engine);
    run(session, "enable", "configure terminal",
      "interface Loopback0", "ip address 1.1.1.1 255.255.255.255", "exit",
      "interface Gi0/0", "ip address 10.0.12.1 255.255.255.0",
      "ip ospf 1 area 0", "ip ospf cost 10", "ip ospf priority 100",
      "ip ospf network point-to-point", "ip ospf hello-interval 10", "ip ospf dead-interval 40", "exit",
      "router ospf 1", "router-id 1.1.1.1", "network 10.0.12.0 0.0.0.255 area 0",
      "passive-interface Loopback0", "end");

    expect(r1.loopbackNumbers()).toEqual([0]);
    const configuration = r1.ospf.configuration();
    expect(configuration.routerId).toBe("1.1.1.1");
    expect(configuration.networks).toEqual([{ network: "10.0.12.0", wildcard: "0.0.0.255", area: 0 }]);
    expect(configuration.passiveInterfaces).toEqual(["Loopback0"]);
    expect(configuration.interfaces[0]).toMatchObject({
      id: "Gi0/0",
      configuration: { cost: 10, priority: 100, networkType: "point-to-point", enabled: true },
    });
  });

  it("rejects an area other than the backbone", () => {
    const { engine, r1 } = twoRouters();
    const session = createCliSession(r1, engine);
    const output = run(session, "enable", "configure terminal", "router ospf 1",
      "network 10.0.0.0 0.0.0.255 area 1");
    expect(output).toContain("area 0 is supported");
  });

  it("brings up an adjacency and shows the neighbour, database and routes", () => {
    const { engine, r1, r2 } = twoRouters();
    for (const [router, address, id] of [[r1, "10.0.12.1", "1.1.1.1"], [r2, "10.0.12.2", "2.2.2.2"]] as const) {
      const session = createCliSession(router, engine);
      run(session, "enable", "configure terminal",
        `interface Loopback0`, `ip address ${id} 255.255.255.255`, "exit",
        "interface Gi0/0", `ip address ${address} 255.255.255.0`,
        "ip ospf network point-to-point", "exit",
        "router ospf 1", `router-id ${id}`,
        "network 0.0.0.0 255.255.255.255 area 0", "passive-interface Loopback0", "end");
    }
    engine.runUntilIdle();

    const session = createCliSession(r1, engine);
    expect(run(session, "enable", "show ip ospf")).toContain("Routing Process \"ospf 1\" with ID 1.1.1.1");
    const neighbor = run(session, "show ip ospf neighbor");
    expect(neighbor).toContain("2.2.2.2");
    expect(neighbor).toContain("full");
    expect(run(session, "show ip ospf neighbor detail")).toContain("Dead timer due in");
    expect(run(session, "show ip ospf interface brief")).toContain("Gi0/0");
    expect(run(session, "show ip ospf database")).toContain("router");
    expect(run(session, "show ip route ospf")).toContain("2.2.2.2");
  });

  it("asks for confirmation before clearing the OSPF process", () => {
    const { engine, r1 } = twoRouters();
    r1.configureInterface("Gi0/0", { ip: "10.0.12.1", mask: 24 });
    r1.ospf.createProcess(1);
    r1.ospf.setRouterId("1.1.1.1");
    r1.ospf.addNetwork("0.0.0.0", "255.255.255.255", 0);
    engine.runUntilIdle();

    const session = createCliSession(r1, engine);
    run(session, "enable");
    expect(session.execute("clear ip ospf process")).toBe("");
    expect(session.prompt()).toContain("[yes/no]");
    expect(session.execute("no")).toBe("% Cancelled.");

    session.execute("clear ip ospf process");
    expect(session.execute("yes")).toContain("Clearing the OSPF process");
    // Configuration survives a runtime reset.
    expect(r1.ospf.configuration().routerId).toBe("1.1.1.1");
  });
});

describe("Contextual help and abbreviations", () => {
  it("offers the new protocol commands in help", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal");
    const help = session.execute("?");
    expect(help).toContain("spanning-tree");
    expect(help).toContain("cdp");
    expect(session.execute("spanning-tree ?")).toContain("mode");
  });

  it("accepts the documented abbreviations", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    sw1.setSpanningTreeMode("stp");
    const session = createCliSession(sw1, engine);
    run(session, "enable");
    expect(session.execute("show span")).toContain("VLAN0001");
    expect(session.execute("show etherchannel sum")).toContain("No EtherChannel");
    expect(session.execute("show cdp nei")).toContain("CDP is not enabled");
    expect(session.execute("show lldp nei")).toContain("LLDP is not enabled");
  });

  it("keeps an ambiguous abbreviation an error", () => {
    const engine = engineWith();
    const r1 = addRouter(engine, "r1", 10);
    r1.configureInterface("Gi0/0", { ip: "10.0.0.1", mask: 24 });
    r1.ospf.createProcess(1);
    const session = createCliSession(r1, engine);
    run(session, "enable");
    expect(session.execute("show ip ospf nei")).toContain("No OSPF neighbours");
    expect(session.execute("show ip ospf int br")).toContain("No interfaces are running OSPF");
    // "show ip" alone still cannot pick between route/ospf/interface.
    expect(session.execute("s ip")).toMatch(/Ambiguous|Incomplete|%/);
  });

  it("does not offer OSPF commands on a device that cannot run it", () => {
    const engine = engineWith();
    const sw1 = addSwitch(engine, "sw1", 100);
    const session = createCliSession(sw1, engine);
    run(session, "enable", "configure terminal");
    expect(session.execute("?")).not.toContain("router-id");
    expect(session.execute("router ospf 1")).toMatch(/%/);
  });
});
