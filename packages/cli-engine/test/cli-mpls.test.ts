import { createCliSession, type CliSession } from "@sim/cli-engine";
import { createSimulationEngine, macFromIndex, Router } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

function setup() {
  const engine = createSimulationEngine({ seed: 10_111 });
  const router = engine.add(new Router("r1", "R1"));
  router.addInterface("Gi0/0", macFromIndex(1));
  router.addInterface("Gi0/1", macFromIndex(2));
  return { engine, router, session: createCliSession(router, engine) };
}

function run(session: CliSession, ...commands: string[]): string {
  return commands.map((command) => session.execute(command)).at(-1) ?? "";
}

describe("MPLS, LDP and L3VPN CLI", () => {
  it("configures a VRF definition and a customer-facing interface", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "vrf definition CUSTOMER-A", "rd 65000:100",
      "route-target import 65000:100", "route-target export 65000:100", "exit",
      "interface Gi0/1", "vrf forwarding CUSTOMER-A", "ip address 10.1.1.1 255.255.255.0");
    expect(router.vrfConfigurations()).toEqual([expect.objectContaining({
      id: "CUSTOMER-A", routeDistinguisher: "65000:100",
      importRouteTargets: ["65000:100"], exportRouteTargets: ["65000:100"],
    })]);
    expect(router.interfaceVrf("Gi0/1")).toBe("CUSTOMER-A");
  });

  it("configures MPLS and a stable LDP router-id source", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "interface Loopback0", "ip address 1.1.1.1 255.255.255.255", "exit",
      "interface Gi0/0", "ip address 192.0.2.1 255.255.255.252", "mpls ip", "exit",
      "mpls label protocol ldp", "mpls ldp router-id Loopback0 force");
    expect(router.mpls.interfaceEnabled("Gi0/0")).toBe(true);
    expect(router.ldp.configuredRouterIdSource()).toBe("Loopback0");
    expect(router.ldp.routerId()).toBe("1.1.1.1");
  });

  it("adds a VRF static route only through a same-VRF next hop", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "vrf definition BLUE", "rd 65000:1", "exit",
      "interface Gi0/1", "vrf forwarding BLUE", "ip address 10.0.0.1 255.255.255.0", "exit",
      "ip route vrf BLUE 10.2.0.0 255.255.255.0 10.0.0.2");
    expect(router.vrfRoutingTable("BLUE")).toEqual(expect.arrayContaining([
      expect.objectContaining({ network: "10.2.0.0", prefixLength: 24, source: "static", nextHop: "10.0.0.2" }),
    ]));
    expect(run(session, "ip route vrf BLUE 10.3.0.0 255.255.255.0 192.0.2.9")).toContain("not reachable in the same VRF");
  });

  it("activates VPNv4 and explicit VRF redistribution on the existing BGP process", () => {
    const { router, session } = setup();
    run(session, "enable", "configure terminal", "vrf definition BLUE", "rd 65000:1", "route-target import 65000:1", "route-target export 65000:1", "exit",
      "router bgp 65000", "neighbor 2.2.2.2 remote-as 65000", "address-family vpnv4",
      "neighbor 2.2.2.2 activate", "neighbor 2.2.2.2 send-community extended", "exit-address-family",
      "address-family ipv4 vrf BLUE", "redistribute connected", "redistribute static", "exit-address-family");
    expect(router.bgp.configurationSnapshot()).toMatchObject({
      neighbors: [{ address: "2.2.2.2", vpnv4Activated: true, sendCommunityExtended: true }],
      vrfAddressFamilies: [{ vrfId: "BLUE", redistributeConnected: true, redistributeStatic: true }],
    });
  });

  it("renders bounded MPLS, LDP, VRF and VPNv4 inspection", () => {
    const { session } = setup();
    run(session, "enable", "configure terminal", "vrf definition BLUE", "rd 65000:1", "exit",
      "interface Gi0/0", "ip address 192.0.2.1 255.255.255.252", "end");
    expect(run(session, "show vrf")).toContain("65000:1");
    expect(run(session, "show mpls forwarding-table")).toContain("65000:1:vrf");
    expect(run(session, "show mpls ldp neighbor")).toContain("No LDP neighbors");
    expect(run(session, "show bgp vpnv4 unicast all")).toContain("VPNv4 table is empty");
    expect(run(session, "show ip interface brief vrf all")).toContain("global");
    expect(run(session, "show bgp vpnv4 unicast neighbors")).toContain("No VPNv4 neighbors");
  });

  it("keeps unsupported MPLS commands out of contextual help", () => {
    const { session } = setup();
    run(session, "enable");
    const output = run(session, "show mpls ?");
    expect(output).toContain("interfaces");
    expect(output).toContain("forwarding-table");
    expect(output).not.toContain("traffic-eng");
    expect(output).not.toContain("xconnect");
  });
});
