import type { Layer3SwitchDeviceConfig } from "@sim/contracts";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "../src";
import { describe, expect, it } from "vitest";

const INTERFACES = ["Gi0/1", "Gi0/2"];

const SOURCE = [
  "hostname LEAF1",
  "ip routing",
  "vlan 10",
  " name TENANT-A",
  "!",
  "interface Gi0/1",
  " switchport mode access",
  " switchport access vlan 10",
  "!",
  "interface Gi0/2",
  " no switchport",
  " ip address 192.0.2.1 255.255.255.252",
  "!",
  "interface Loopback0",
  " ip address 10.255.0.1 255.255.255.255",
  "!",
  "interface nve1",
  " no shutdown",
  " source-interface Loopback0",
  " member vni 10010",
  "  ingress-replication protocol bgp",
  "!",
  "vlan configuration 10",
  " member vni 10010",
  "!",
  "evpn",
  " vni 10010 l2",
  "  rd 65000:10010",
  "  route-target import 65000:10010",
  "  route-target export 65000:10010",
  "!",
  "router bgp 65000",
  " bgp router-id 10.255.0.1",
  " neighbor 10.255.0.3 remote-as 65000",
  " neighbor 10.255.0.3 update-source Loopback0",
  " address-family l2vpn evpn",
  "  neighbor 10.255.0.3 activate",
  "  neighbor 10.255.0.3 send-community extended",
  " exit-address-family",
].join("\n");

describe("VXLAN and BGP EVPN IOS-like import/render", () => {
  it("parses the NVE, the VLAN-to-VNI binding and the EVPN block", () => {
    const parsed = parseIosConfig(SOURCE, INTERFACES);
    expect(parsed.nve).toEqual({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
    });
    expect(parsed.evpn).toEqual({
      vnis: [{
        vni: 10_010,
        routeDistinguisher: "65000:10010",
        importRouteTargets: ["65000:10010"],
        exportRouteTargets: ["65000:10010"],
      }],
    });
    expect(parsed.bgp?.neighbors[0]).toMatchObject({
      address: "10.255.0.3",
      evpnActivated: true,
      sendCommunityExtended: true,
    });
    // Every VXLAN/EVPN line applied; only lines outside this parser's scope
    // (`ip routing`, `no switchport`) remain, exactly as before M10.14.
    expect(parsed.unparsedLines.filter((entry) =>
      /nve|vni|evpn|route-target|rd |peer-ip|source-interface/iu.test(entry))).toEqual([]);
  });

  it("parses a static ingress-replication peer list", () => {
    const parsed = parseIosConfig([
      "vlan 10",
      "interface Loopback0",
      " ip address 10.255.0.1 255.255.255.255",
      "!",
      "interface nve1",
      " no shutdown",
      " source-interface Loopback0",
      " member vni 10010",
      "  peer-ip 10.255.0.2",
      "  peer-ip 10.255.0.3",
      "!",
      "vlan configuration 10",
      " member vni 10010",
    ].join("\n"), INTERFACES);
    expect(parsed.nve?.members).toEqual([{
      vni: 10_010,
      vlanId: 10,
      replication: { type: "static", peerAddresses: ["10.255.0.2", "10.255.0.3"] },
    }]);
  });

  it("round-trips canonical VXLAN and EVPN syntax through the renderer", () => {
    const parsed = parseIosConfig(SOURCE, INTERFACES);
    const config = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "LEAF1").config as Layer3SwitchDeviceConfig;
    const rendered = renderDeviceConfiguration(config);
    for (const line of [
      "interface nve1",
      " source-interface Loopback0",
      " member vni 10010",
      "  ingress-replication protocol bgp",
      "vlan configuration 10",
      " member vni 10010",
      "evpn",
      " vni 10010 l2",
      "  rd 65000:10010",
      "  route-target import 65000:10010",
      " address-family l2vpn evpn",
      "  neighbor 10.255.0.3 activate",
      "  neighbor 10.255.0.3 send-community extended",
    ]) expect(rendered.split("\n")).toContain(line);

    // The rendered text is a projection of the structured configuration, so
    // re-reading it must produce the same bytes and no runtime state.
    const reparsed = parseIosConfig(rendered, INTERFACES);
    const reconfig = buildDeviceConfigFromIos("l3-switch", reparsed, INTERFACES, "LEAF1").config;
    expect(renderDeviceConfiguration(reconfig)).toBe(rendered);
    expect(rendered).not.toMatch(/remote MAC|Adj-RIB|replication list|last seen/iu);
  });

  it("reports unsupported VXLAN features rather than inventing them", () => {
    const parsed = parseIosConfig([
      "vlan 10",
      "interface Loopback0",
      " ip address 10.255.0.1 255.255.255.255",
      "!",
      "interface nve1",
      " source-interface Loopback0",
      " host-reachability protocol bgp",
      " member vni 10010",
      "  mcast-group 239.1.1.1",
      "  suppress-arp",
      " member vni 50000 associate-vrf",
      "!",
      "vlan configuration 10",
      " member vni 10010",
      "!",
      "evpn",
      " vni 10010 l2",
      "  rd 65000:10010",
      "  route-target both 65000:10010",
    ].join("\n"), INTERFACES);
    expect(parsed.unparsedLines).toEqual(expect.arrayContaining([
      "host-reachability protocol bgp",
      "mcast-group 239.1.1.1",
      "suppress-arp",
      "member vni 50000 associate-vrf",
      "route-target both 65000:10010",
    ]));
    // The supported half still applies; the unsupported half is never guessed.
    expect(parsed.nve?.members).toEqual([
      { vni: 10_010, vlanId: 10, replication: { type: "static", peerAddresses: [] } },
    ]);
  });

  it("drops a VNI whose VLAN the source never bound", () => {
    const parsed = parseIosConfig([
      "interface Loopback0",
      " ip address 10.255.0.1 255.255.255.255",
      "!",
      "interface nve1",
      " source-interface Loopback0",
      " member vni 10010",
      "  peer-ip 10.255.0.2",
    ].join("\n"), INTERFACES);
    expect(parsed.nve?.members).toEqual([]);
    const config = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "LEAF1").config as Layer3SwitchDeviceConfig;
    expect(config.nve).toBeUndefined();
  });

  it("rejects an NVE source that is not a Loopback", () => {
    const parsed = parseIosConfig([
      "vlan 10",
      "interface nve1",
      " source-interface Gi0/2",
      " member vni 10010",
    ].join("\n"), INTERFACES);
    expect(parsed.unparsedLines).toContain("source-interface Gi0/2");
    expect(parsed.nve).toBeUndefined();
  });
});
