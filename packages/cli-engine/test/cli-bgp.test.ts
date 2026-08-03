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
      "set local-preference 200", "set metric 50", "set weight 25", "set as-path prepend 65001 65001", "set origin incomplete");
    expect(router.bgp.routingPolicy.prefixListConfigurations()[0]?.entries[0]).toMatchObject({ ge: 20, le: 24 });
    expect(router.bgp.routingPolicy.routeMapConfigurations()[0]?.sequences[0]).toMatchObject({
      match: { prefixListIds: ["CUSTOMER"], maximumAsPathLength: 4 },
      set: { localPreference: 200, med: 50, weight: 25, prependAsns: [65_001, 65_001], origin: "incomplete" },
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
    // Communities exist from M10.12, so contextual help must now offer them.
    expect(run(session, "show ip bgp ?")).toContain("community");
  });

  it("confirms an administrative reset and preserves BGP configuration", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "neighbor 192.0.2.2 remote-as 65002", "end");
    expect(run(session, "clear ip bgp *")).toBe("");
    expect(session.prompt()).toContain("Reset all BGP sessions");
    expect(run(session, "yes")).toContain("configuration is unchanged");
    expect(router.bgp.configurationSnapshot()?.neighbors).toHaveLength(1);
  });

  it("parses route reflection, send-community, aggregation and default-originate", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65000", "bgp router-id 10.255.0.1",
      "bgp cluster-id 10.255.0.9",
      "neighbor 10.0.1.2 remote-as 65000", "neighbor 10.0.1.2 route-reflector-client",
      "neighbor 10.0.1.2 send-community both",
      "neighbor 10.0.2.2 remote-as 65100", "neighbor 10.0.2.2 default-originate",
      "aggregate-address 10.20.0.0 255.255.0.0 summary-only as-set");
    expect(router.bgp.configurationSnapshot()).toMatchObject({
      clusterId: "10.255.0.9",
      aggregates: [{ prefix: "10.20.0.0", prefixLength: 16, summaryOnly: true, asSet: true }],
    });
    expect(router.bgp.routeReflectorClients()).toEqual(["10.0.1.2"]);
    expect(router.bgp.configurationSnapshot()?.neighbors).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "10.0.1.2", sendCommunityStandard: true, sendCommunityExtended: true }),
      expect.objectContaining({ address: "10.0.2.2", defaultOriginate: true }),
    ]));
  });

  it("parses community lists, safe AS-path lists and the new route-map clauses", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65000", "exit",
      "ip community-list standard CUSTOMER permit 65000:100",
      "ip community-list standard NO-EXPORT permit no-export",
      "ip as-path access-list LOCAL permit ^$",
      "route-map POLICY permit 10", "match community CUSTOMER", "match as-path LOCAL",
      "match route-type ebgp", "set community 65000:200 additive");
    expect(router.bgp.routingPolicy.communityListConfigurations()).toEqual([
      { id: "CUSTOMER", entries: [{ sequence: 10, action: "permit", communities: ["65000:100"] }] },
      { id: "NO-EXPORT", entries: [{ sequence: 10, action: "permit", communities: ["no-export"] }] },
    ]);
    expect(router.bgp.routingPolicy.asPathListConfigurations()[0]?.entries[0]?.matcher).toEqual({ kind: "empty" });
    expect(router.bgp.routingPolicy.routeMapConfigurations()[0]?.sequences[0]).toMatchObject({
      match: { communityListIds: ["CUSTOMER"], asPathListIds: ["LOCAL"], source: "ebgp" },
      set: { communities: ["65000:200"], communityAdditive: true },
    });
  });

  it("rejects an unsupported AS-path regular expression instead of executing it", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65000", "exit");
    expect(run(session, "ip as-path access-list BAD permit ^(65001|65002)+$")).toMatch(/not supported/i);
    expect(router.bgp.routingPolicy.asPathListConfigurations()).toEqual([]);
  });

  it("soft-clears a neighbor without confirmation and without resetting the session", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "router bgp 65001", "neighbor 192.0.2.2 remote-as 65002", "end");
    expect(run(session, "clear ip bgp 192.0.2.2 soft out")).toContain("session is unchanged");
    expect(run(session, "clear ip bgp * soft")).toContain("sessions are unchanged");
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
