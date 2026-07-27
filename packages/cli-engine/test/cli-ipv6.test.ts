import { createCliSession } from "@sim/cli-engine";
import {
  createSimulationEngine,
  L2Switch,
  macFromIndex,
  Pc,
  Router,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function routerCli() {
  const engine = createSimulationEngine({ seed: 10_501 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(100));
  router.addInterface("Gi0/1", macFromIndex(101));
  const cli = createCliSession(router, engine);
  cli.execute("enable");
  cli.execute("configure terminal");
  return { engine, router, cli };
}

describe("IPv6 CLI integration", () => {
  it("configures IPv6 interfaces, forwarding, a static route and inspection", () => {
    const { engine, router, cli } = routerCli();
    for (const command of [
      "ipv6 unicast-routing",
      "interface Gi0/0",
      "ipv6 enable",
      "ipv6 address 2001:db8:10::1/64",
      "exit",
      "interface Gi0/1",
      "ipv6 address 2001:db8:20::1/64",
      "exit",
      "ipv6 route 2001:db8:30::/64 2001:db8:20::2",
      "end",
    ]) cli.execute(command);
    engine.runUntilIdle();

    expect(router.ipv6UnicastRoutingEnabled).toBe(true);
    expect(router.ipv6RoutingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "static", network: "2001:db8:30::", prefixLength: 64 }),
    ]));
    expect(cli.execute("show ipv6 interface brief")).toContain("2001:db8:10::1/64");
    expect(cli.execute("show ipv6 route")).toContain("2001:db8:30::/64");
  });

  it("configures OSPFv3 and a named IPv6 ACL without changing OSPFv2", () => {
    const { router, cli } = routerCli();
    for (const command of [
      "interface Gi0/0",
      "ipv6 address 2001:db8:10::1/64",
      "ipv6 ospf 1 area 0",
      "ipv6 ospf cost 10",
      "exit",
      "ipv6 router ospf 1",
      "router-id 1.1.1.1",
      "passive-interface Gi0/1",
      "exit",
      "ipv6 access-list WEB6",
      "permit tcp 2001:db8:10::/64 host 2001:db8:20::10 eq 80",
      "deny ipv6 any any",
      "exit",
      "interface Gi0/0",
      "ipv6 traffic-filter WEB6 in",
      "end",
    ]) expect(cli.execute(command)).not.toContain("% Invalid");

    expect(router.ospfv3.configuration()).toMatchObject({
      processId: 1,
      routerId: "1.1.1.1",
      passiveInterfaces: ["Gi0/1"],
    });
    expect(router.ospf.enabled).toBe(false);
    expect(router.ipv6AclConfigurations()[0]?.rules).toHaveLength(2);
    expect(cli.execute("show ipv6 access-list")).toContain("permit tcp 2001:db8:10::/64");
    expect(cli.execute("show ipv6 ospf")).toContain("Router ID 1.1.1.1");
  });

  it("runs ping -6 through an L2 switch and shows IPv6 in ipconfig /all", () => {
    const engine = createSimulationEngine({ seed: 10_502 });
    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc2.addInterface("eth0", macFromIndex(2));
    sw.addInterface("Gi0/1", macFromIndex(11));
    sw.addInterface("Gi0/2", macFromIndex(12));
    engine.connect("pc1", "eth0", "sw1", "Gi0/1");
    engine.connect("pc2", "eth0", "sw1", "Gi0/2");
    pc1.configureIpv6Static("2001:db8:10::10", 64);
    pc2.configureIpv6Static("2001:db8:10::20", 64);
    engine.runUntilIdle();

    const cli = createCliSession(pc1, engine);
    expect(cli.execute("ping -6 2001:db8:10::20")).toContain("Success rate is 100 percent");
    expect(cli.execute("ipconfig /all")).toContain("2001:db8:10::10/64");
  });
});
