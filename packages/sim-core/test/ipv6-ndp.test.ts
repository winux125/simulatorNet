import { describe, expect, it } from "vitest";
import {
  createSimulationEngine,
  L2Switch,
  macFromIndex,
  Pc,
  type SimulationEngine,
} from "@sim/sim-core";

function staticIpv6Lan(addresses: [string, string]): {
  engine: SimulationEngine;
  pc1: Pc;
  pc2: Pc;
} {
  const engine = createSimulationEngine({ seed: 105 });
  engine.enableTrace();
  const sw = engine.add(new L2Switch("sw1", "SW1"));
  sw.addInterface("Gi0/1", macFromIndex(101));
  sw.addInterface("Gi0/2", macFromIndex(102));
  const pc1 = engine.add(new Pc("pc1", "PC1"));
  const pc2 = engine.add(new Pc("pc2", "PC2"));
  pc1.addInterface("eth0", macFromIndex(1));
  pc2.addInterface("eth0", macFromIndex(2));
  engine.connect(sw.id, "Gi0/1", pc1.id, "eth0");
  engine.connect(sw.id, "Gi0/2", pc2.id, "eth0");
  pc1.configureIpv6Static(addresses[0], 64);
  pc2.configureIpv6Static(addresses[1], 64);
  return { engine, pc1, pc2 };
}

describe("IPv6 NDP and ICMPv6", () => {
  it("pings two static IPv6 hosts through an L2 switch and caches the neighbor", () => {
    const { engine, pc1, pc2 } = staticIpv6Lan(["2001:db8:10::10", "2001:db8:10::20"]);
    engine.runUntilIdle();

    pc1.ping6("2001:0db8:10::20", 1);
    engine.runUntilIdle();

    expect(pc1.ipv6PingResults).toEqual([
      expect.objectContaining({ sequence: 1, success: true }),
    ]);
    expect(pc1.ipv6NeighborEntries()).toEqual([
      expect.objectContaining({ address: "2001:db8:10::20", mac: pc2.primary.mac }),
    ]);
    expect(engine.traceLog.map((entry) => entry.type)).toEqual(expect.arrayContaining([
      "ndp-neighbor-solicitation",
      "ndp-neighbor-advertisement",
      "ipv6-ping-success",
    ]));
  });

  it("runs deterministic DAD and reports a duplicate without corrupting configuration", () => {
    const first = staticIpv6Lan(["2001:db8:10::10", "2001:db8:10::10"]);
    const second = staticIpv6Lan(["2001:db8:10::10", "2001:db8:10::10"]);
    first.engine.runUntilIdle();
    second.engine.runUntilIdle();

    for (const host of [first.pc1, first.pc2]) {
      expect(host.ipv6AddressSummaries().find((entry) => entry.address === "2001:db8:10::10"))
        .toMatchObject({ source: "static", state: "duplicate" });
      expect(host.ipv6Problems).toContain("Duplicate IPv6 address detected: 2001:db8:10::10");
    }
    expect(second.engine.traceLog).toEqual(first.engine.traceLog);
  });

  it("does not route a different prefix without a default router", () => {
    const { engine, pc1 } = staticIpv6Lan(["2001:db8:10::10", "2001:db8:20::20"]);
    engine.runUntilIdle();
    pc1.ping6("2001:db8:20::20", 4);
    engine.runUntilIdle();
    expect(pc1.ipv6PingResults).toEqual([{ sequence: 4, success: false }]);
    expect(pc1.ipv6NeighborEntries()).toEqual([]);
  });

  it("bounds configured prefix lengths", () => {
    const { pc1 } = staticIpv6Lan(["2001:db8:10::10", "2001:db8:10::20"]);
    const address = pc1.ipv6AddressSummaries().find((entry) => entry.source === "static")!.address;
    expect(() => {
      // The runtime method is reached through the public reconfiguration path:
      // re-adding an address may use at most the central control-protocol bound.
      pc1.configureIpv6Static(address, 129);
    }).toThrow(/prefix length/);
  });

  it("bounds repeated DAD probes through the shared control limits", () => {
    const { pc1 } = staticIpv6Lan(["2001:db8:10::10", "2001:db8:10::20"]);
    expect(() => pc1.beginIpv6Dad("2001:db8:10::10", 4)).toThrow(/DAD attempts/);
  });
});
