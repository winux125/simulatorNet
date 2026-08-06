import { createCliSession } from "@sim/cli-engine";
import { Layer3Switch, Router, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";
import { createTestConfigurationService } from "./helpers/configuration";

/**
 * CLI coverage stays at the parsing/adapter boundary: that the right command
 * reaches the right engine call with the right arguments. VXLAN forwarding and
 * EVPN route behaviour are proven in sim-core, not re-tested through a prompt.
 */
function leafSession() {
  const engine = createSimulationEngine({ seed: 11_014 });
  const device = engine.add(new Layer3Switch("leaf1", "LEAF1"));
  device.addInterface("Gi0/1", macFromIndex(10));
  device.addInterface("Gi0/2", macFromIndex(11));
  device.setVlanName(10, "TENANT-A");
  device.setAccess("Gi0/1", 10);
  device.setPortRouted("Gi0/2", true);
  device.configureRoutedInterface("Gi0/2", "192.0.2.1", 30);
  device.setIpRouting(true);
  device.getOrCreateLoopback(0);
  device.setInterfaceIp("Loopback0", "10.255.0.1", 32);
  const session = createCliSession(device, engine);
  session.useConfigurationService(createTestConfigurationService(device));
  session.execute("enable");
  session.execute("configure terminal");
  return { engine, device, session };
}

describe("VXLAN and EVPN CLI", () => {
  it("configures nve1 with a static peer through the IOS-like subset", () => {
    const { device, session } = leafSession();
    session.execute("interface nve1");
    expect(session.prompt()).toBe("LEAF1(config-if-nve)#");
    session.execute("no shutdown");
    session.execute("source-interface Loopback0");
    session.execute("member vni 10010");
    expect(session.prompt()).toBe("LEAF1(config-if-nve-vni)#");
    session.execute("peer-ip 10.255.0.2");
    session.execute("exit");
    expect(session.prompt()).toBe("LEAF1(config-if-nve)#");
    session.execute("exit");
    session.execute("vlan configuration 10");
    expect(session.prompt()).toBe("LEAF1(config-vlan-config)#");
    session.execute("member vni 10010");

    expect(device.nveConfiguration()).toEqual({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      adminUp: true,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: ["10.255.0.2"] } }],
    });
  });

  it("carries a BGP EVPN replication setting across the VLAN binding", () => {
    const { device, session } = leafSession();
    session.execute("interface nve1");
    session.execute("source-interface Loopback0");
    session.execute("no shutdown");
    // The replication mode is typed before the VLAN binding exists, which is
    // the order a learner actually uses.
    session.execute("member vni 10010");
    session.execute("ingress-replication protocol bgp");
    session.execute("end");
    session.execute("configure terminal");
    session.execute("vlan configuration 10");
    session.execute("member vni 10010");

    expect(device.nveConfiguration()?.members).toEqual([
      { vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } },
    ]);
  });

  it("builds the EVPN VNI block with its RD and route targets", () => {
    const { device, session } = leafSession();
    session.execute("evpn");
    expect(session.prompt()).toBe("LEAF1(config-evpn)#");
    session.execute("vni 10010 l2");
    expect(session.prompt()).toBe("LEAF1(config-evpn-vni)#");
    session.execute("rd 65000:10010");
    session.execute("route-target import 65000:10010");
    session.execute("route-target export 65000:10010");

    expect(device.evpnVniConfigurations()).toEqual([{
      vni: 10_010,
      routeDistinguisher: "65000:10010",
      importRouteTargets: ["65000:10010"],
      exportRouteTargets: ["65000:10010"],
    }]);
  });

  it("activates the l2vpn evpn address family on a neighbor", () => {
    const { device, session } = leafSession();
    session.execute("router bgp 65000");
    session.execute("bgp router-id 10.255.0.1");
    session.execute("neighbor 10.255.0.3 remote-as 65000");
    session.execute("neighbor 10.255.0.3 update-source Loopback0");
    session.execute("address-family l2vpn evpn");
    session.execute("neighbor 10.255.0.3 activate");
    session.execute("neighbor 10.255.0.3 send-community extended");
    session.execute("exit-address-family");

    expect(device.bgp.configurationSnapshot()?.neighbors?.[0]).toMatchObject({
      address: "10.255.0.3",
      evpnActivated: true,
      sendCommunityExtended: true,
    });
  });

  it("rejects an out-of-range VNI, a non-Loopback source and a Router VTEP", () => {
    const { session } = leafSession();
    session.execute("interface nve1");
    expect(session.execute("source-interface Gi0/2")).toMatch(/not a Loopback/i);
    session.execute("source-interface Loopback0");
    expect(session.execute("member vni 16777216")).toMatch(/between 1 and 16777215/i);
    expect(session.execute("member vni 0")).toMatch(/between 1 and 16777215/i);

    const engine = createSimulationEngine({ seed: 11_015 });
    const router = engine.add(new Router("r1", "R1"));
    router.addInterface("Gi0/0", macFromIndex(20));
    const routerSession = createCliSession(router, engine);
    routerSession.execute("enable");
    routerSession.execute("configure terminal");
    // A Router is an underlay router and may reflect EVPN, but is never a VTEP.
    expect(routerSession.execute("interface nve1")).toMatch(/Invalid input|% /i);
  });

  it("exposes overlay inspection and never invents an unsupported command", () => {
    const { session } = leafSession();
    session.execute("interface nve1");
    session.execute("source-interface Loopback0");
    session.execute("no shutdown");
    session.execute("member vni 10010");
    session.execute("peer-ip 10.255.0.2");
    session.execute("end");
    session.execute("configure terminal");
    session.execute("vlan configuration 10");
    session.execute("member vni 10010");
    session.execute("end");

    expect(session.execute("show nve interfaces")).toMatch(/nve1.*Loopback0/s);
    expect(session.execute("show nve vni")).toMatch(/10010.*10/s);
    expect(session.execute("show nve peers")).toContain("10.255.0.2");
    expect(session.execute("show vxlan")).toMatch(/nve1 source Loopback0/);
    expect(session.execute("show mac address-table remote")).toMatch(/No remote MAC/i);
    expect(session.execute("show bgp l2vpn evpn")).toMatch(/EVPN table is empty/i);
    expect(session.execute("show bgp l2vpn evpn route-type 2")).toMatch(/EVPN table is empty/i);
    // M10.15 added Type 5; anything outside 2, 3 and 5 is still refused.
    expect(session.execute("show bgp l2vpn evpn route-type 5")).toMatch(/EVPN table is empty/i);
    expect(session.execute("show bgp l2vpn evpn route-type 4")).toMatch(/route types 2, 3 and 5/i);
    // Vendor VXLAN features SimulatorNet does not model stay unknown commands.
    for (const unsupported of [
      "show nve interface nve1 detail",
      "show l2route evpn mac all",
      "show bgp l2vpn evpn route-type 1",
    ]) expect(session.execute(unsupported)).not.toMatch(/^VNI\b/m);
  });
});
