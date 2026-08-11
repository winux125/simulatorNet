import { createCliSession } from "@sim/cli-engine";
import { Layer3Switch, createSimulationEngine, macFromIndex } from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * M10.16 — the multihoming CLI surface.
 *
 * Coverage stays at the parsing/adapter boundary: that the right command
 * reaches the right engine call with the right arguments, and that an
 * unsupported one is reported. The Designated Forwarder election and the
 * failover behaviour are proven in sim-core and are not re-run through a prompt.
 */

const ESI = "0000:0000:0000:0000:0001";

function leafSession() {
  const engine = createSimulationEngine({ seed: 11_016 });
  const device = engine.add(new Layer3Switch("leaf1", "LEAF1"));
  device.addInterface("Gi0/1", macFromIndex(10));
  device.addInterface("Gi0/2", macFromIndex(11));
  device.setVlanName(10, "TENANT-A");
  device.setAccess("Gi0/1", 10);
  device.setPortRouted("Gi0/2", true);
  device.setIpRouting(true);
  device.getOrCreateLoopback(0);
  device.setInterfaceIp("Loopback0", "10.255.0.1", 32);
  device.defineEvpnVni({
    vni: 10_010,
    routeDistinguisher: "65000:10010",
    importRouteTargets: ["65000:10010"],
    exportRouteTargets: ["65000:10010"],
  });
  device.configureNve({
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    adminUp: true,
    members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
  });
  const session = createCliSession(device, engine);
  session.execute("enable");
  session.execute("configure terminal");
  return { device, session };
}

describe("EVPN multihoming CLI", () => {
  it("defines a segment and binds it to an access switchport", () => {
    const { device, session } = leafSession();
    session.execute("evpn ethernet-segment ES-CE1");
    session.execute(`identifier ${ESI}`);
    session.execute("redundancy-mode single-active");
    session.execute("exit");
    session.execute("interface Gi0/1");
    session.execute("ethernet-segment ES-CE1");

    expect(device.ethernetSegmentConfigurations()).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    session.execute("no ethernet-segment");
    expect(device.ethernetSegmentConfigurations()[0]?.interfaces).toEqual([]);
  });

  it("accepts every ESI spelling and refuses the two reserved values", () => {
    const { device, session } = leafSession();
    session.execute("evpn ethernet-segment ES-CE1");
    session.execute("identifier 0000.0000.0000.0000.0001");
    expect(device.ethernetSegmentConfigurations()[0]?.esi).toBe(ESI);
    expect(session.execute("identifier 0000:0000:0000:0000:0000")).toMatch(/reserved for single-homed/);
    expect(session.execute("identifier ffff:ffff:ffff:ffff:ffff")).toMatch(/reserved/);
    expect(session.execute("identifier not-an-esi")).toMatch(/Invalid Ethernet Segment Identifier/);
    // A refused value never replaces the one that was already accepted.
    expect(device.ethernetSegmentConfigurations()[0]?.esi).toBe(ESI);
  });

  it("reports all-active honestly instead of downgrading it", () => {
    const { device, session } = leafSession();
    session.execute("evpn ethernet-segment ES-CE1");
    session.execute(`identifier ${ESI}`);
    expect(session.execute("redundancy-mode all-active")).toMatch(/Only 'single-active' redundancy is supported/);
    expect(device.ethernetSegmentConfigurations()[0]?.redundancyMode).toBe("single-active");
  });

  it("refuses an attachment that could never serve a CE", () => {
    const { session } = leafSession();
    session.execute("evpn ethernet-segment ES-CE1");
    session.execute(`identifier ${ESI}`);
    session.execute("exit");
    // Gi0/2 is a routed core port, so it has no CE hanging off it.
    session.execute("interface Gi0/2");
    expect(session.execute("ethernet-segment ES-CE1")).toMatch(/cannot carry an Ethernet Segment/);
    session.execute("exit");
    session.execute("interface Gi0/1");
    expect(session.execute("ethernet-segment MISSING")).toMatch(/is not defined/);
  });

  it("shows the segment, its peers and the Designated Forwarder", () => {
    const { session } = leafSession();
    session.execute("evpn ethernet-segment ES-CE1");
    session.execute(`identifier ${ESI}`);
    session.execute("redundancy-mode single-active");
    session.execute("exit");
    session.execute("interface Gi0/1");
    session.execute("ethernet-segment ES-CE1");
    session.execute("end");

    const summary = session.execute("show evpn ethernet-segment");
    expect(summary).toContain("ES-CE1");
    expect(summary).toContain(ESI);
    expect(summary).toContain("single-active");
    expect(summary).toContain("Gi0/1");
    // No cable is attached in this harness, so the segment is honestly down and
    // nothing pretends an election happened.
    expect(summary).toContain("attachment-down");
    const detail = session.execute("show evpn ethernet-segment detail");
    expect(detail).toMatch(/No Ethernet Segment peer is known/);
    expect(detail).toMatch(/No Designated Forwarder has been elected/);
    expect(session.execute("show evpn df")).toMatch(/No Designated Forwarder/);
    expect(session.execute("show evpn df vlan 99")).toMatch(/No Designated Forwarder/);
    expect(session.execute(`show evpn ethernet-segment esi ${ESI}`)).toContain("ES-CE1");
    expect(session.execute("show evpn ethernet-segment esi 0000:0000:0000:0000:0099"))
      .toMatch(/No Ethernet Segment is configured/);
    // The EVPN table accepts the two new route types by number.
    expect(session.execute("show bgp l2vpn evpn route-type 4")).toMatch(/EVPN table is empty|\[4\]/);
    expect(session.execute("show bgp l2vpn evpn route-type 6")).toMatch(/route types 1, 2, 3, 4 and 5/);
  });
});
