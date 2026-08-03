import { createCliSession, type CliSession } from "@sim/cli-engine";
import { createSimulationEngine, Layer3Switch, macFromIndex, Router } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function setup() {
  const engine = createSimulationEngine({ seed: 101 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(1));
  return { router, session: createCliSession(router, engine) };
}

function run(session: CliSession, ...lines: string[]): string {
  return lines.map((line) => session.execute(line)).at(-1) ?? "";
}

describe("BGP CLI", () => {
  it("configures a 32-bit local AS, neighbor attributes and a network statement", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 4200000001", "bgp router-id 1.1.1.1",
      "neighbor 192.0.2.2 remote-as 65002", "neighbor 192.0.2.2 description ISP edge",
      "neighbor 192.0.2.2 ebgp-multihop 2", "neighbor 192.0.2.2 next-hop-self",
      "network 10.10.0.0 mask 255.255.255.0");
    expect(router.bgp.configurationSnapshot()).toMatchObject({
      localAs: 4_200_000_001, routerId: "1.1.1.1",
      neighbors: [{ address: "192.0.2.2", remoteAs: 65_002, description: "ISP edge", ebgpMultihop: 2, nextHopSelf: true }],
      networks: [{ network: "10.10.0.0", prefixLength: 24 }],
    });
  });

  it("configures prefix-list ge/le and route-map match/set clauses", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "exit",
      "ip prefix-list CUSTOMER seq 10 permit 10.10.0.0/16 ge 20 le 24",
      "route-map ISP-IN permit 10", "match ip address prefix-list CUSTOMER", "match as-path length 4",
      "set local-preference 200", "set metric 50", "set weight 25", "set as-path prepend 2", "set origin incomplete");
    expect(router.bgp.routingPolicy.prefixListConfigurations()[0]?.entries[0]).toMatchObject({ ge: 20, le: 24 });
    expect(router.bgp.routingPolicy.routeMapConfigurations()[0]?.sequences[0]).toMatchObject({
      match: { prefixListIds: ["CUSTOMER"], maximumAsPathLength: 4 },
      set: { localPreference: 200, med: 50, weight: 25, prependLocalAs: 2, origin: "incomplete" },
    });
  });

  it("attaches inbound and outbound policies to a neighbor", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "neighbor 192.0.2.2 remote-as 65002",
      "neighbor 192.0.2.2 prefix-list CUSTOMER in", "neighbor 192.0.2.2 route-map ISP-OUT out");
    expect(router.bgp.configurationSnapshot()?.neighbors[0]).toMatchObject({ prefixListIn: "CUSTOMER", routeMapOut: "ISP-OUT" });
  });

  it("shows summary, table and individual route errors without unsupported help", () => {
    const { session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "neighbor 192.0.2.2 remote-as 65002", "end");
    expect(run(session, "show ip bgp summary")).toContain("192.0.2.2");
    expect(run(session, "show ip bgp")).toContain("local router ID");
    expect(run(session, "show ip bgp 10.0.0.0/8")).toContain("not in BGP table");
    expect(run(session, "show ip bgp ?")).not.toContain("community");
  });

  it("confirms an administrative reset and preserves BGP configuration", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "neighbor 192.0.2.2 remote-as 65002", "end");
    expect(run(session, "clear ip bgp *")).toBe("");
    expect(session.prompt()).toContain("Reset all BGP sessions");
    expect(run(session, "yes")).toContain("configuration is unchanged");
    expect(router.bgp.configurationSnapshot()?.neighbors).toHaveLength(1);
  });

  it("requires IP routing for BGP on an L3 Switch", () => {
    const engine = createSimulationEngine({ seed: 102 });
    const device = engine.add(new Layer3Switch("dsw", "DSW1"));
    const session = createCliSession(device, engine);
    run(session, "enable", "configure terminal");
    expect(run(session, "router bgp 65001")).toContain("Enable 'ip routing'");

    run(session, "ip routing", "router bgp 65001", "end", "configure terminal");
    expect(device.bgp.localAs).toBe(65_001);
    expect(run(session, "no ip routing")).toContain("Remove the BGP process");
    expect(device.ipRoutingEnabled).toBe(true);
  });
});
