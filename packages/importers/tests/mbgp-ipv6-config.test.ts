import { buildDeviceConfigFromIos, parseIosConfig } from "@sim/importers";
import { describe, expect, it } from "vitest";

const INTERFACES = ["Gi0/0", "Gi0/1"];

/**
 * M10.13: the IOS-like subset an untrusted import may carry. Everything here is
 * structured configuration; no learned route, session, label or RIB is ever
 * imported, and an unsupported line is preserved in the report instead of being
 * applied silently.
 */
const IOS_MBGP = `ipv6 unicast-routing
vrf definition CUSTOMER-A
 rd 65000:100
 route-target export 65000:100
 route-target import 65000:100
 address-family ipv6
 exit-address-family
!
interface Gi0/0
 ipv6 address 2001:db8:12::1/64
!
interface Gi0/1
 vrf forwarding CUSTOMER-A
 ipv6 address 2001:db8:a:1::1/64
!
ipv6 route vrf CUSTOMER-A 2001:db8:a:2::/64 2001:db8:a:1::2
!
ipv6 prefix-list CUSTOMER6 seq 10 permit 2001:db8:100::/48 le 64
ipv6 prefix-list CUSTOMER6 seq 20 deny 2001:db8:200::/48
!
route-map FROM-PEER permit 10
 match ipv6 address prefix-list CUSTOMER6
!
router bgp 65000
 bgp router-id 10.255.0.1
 neighbor 2001:db8:12::2 remote-as 65002
 neighbor 10.255.0.2 remote-as 65000
 neighbor 10.255.0.2 update-source Loopback0
 address-family ipv6 unicast
  neighbor 2001:db8:12::2 activate
  neighbor 2001:db8:12::2 route-map FROM-PEER in
  neighbor 2001:db8:12::2 send-community
  network 2001:db8:100::/64
 exit-address-family
 address-family vpnv6
  neighbor 10.255.0.2 activate
  neighbor 10.255.0.2 send-community extended
 exit-address-family
 address-family ipv6 vrf CUSTOMER-A
  redistribute connected
  redistribute static
 exit-address-family
`;

describe("IOS MP-BGP IPv6 and VPNv6 import", () => {
  it("parses the supported IPv6 unicast, VPNv6 and VRF IPv6 subset", () => {
    const parsed = parseIosConfig(IOS_MBGP, INTERFACES);

    expect(parsed.unparsedLines, JSON.stringify(parsed.unparsedLines)).toEqual([]);
    expect(parsed.vrfs[0]).toMatchObject({
      routeDistinguisher: "65000:100",
      addressFamilyIpv6: true,
      ipv6StaticRoutes: [{ network: "2001:db8:a:2::", prefixLength: 64, nextHop: "2001:db8:a:1::2" }],
    });
    expect(parsed.ipv6PrefixLists).toEqual([{
      id: "CUSTOMER6",
      entries: [
        { sequence: 10, action: "permit", prefix: "2001:db8:100::", prefixLength: 48, ge: undefined, le: 64 },
        { sequence: 20, action: "deny", prefix: "2001:db8:200::", prefixLength: 48, ge: undefined, le: undefined },
      ],
    }]);
    expect(parsed.routeMaps[0]?.sequences[0]?.match).toMatchObject({ ipv6PrefixListIds: ["CUSTOMER6"] });
  });

  it("keeps IPv6 neighbor settings inside their own address family", () => {
    const parsed = parseIosConfig(IOS_MBGP, INTERFACES);
    const ipv6Peer = parsed.bgp.neighbors.find((neighbor) => neighbor.address === "2001:db8:12::2");
    const vpnPeer = parsed.bgp.neighbors.find((neighbor) => neighbor.address === "10.255.0.2");

    expect(ipv6Peer).toMatchObject({
      remoteAs: 65_002,
      ipv6: { activated: true, routeMapIn: "FROM-PEER", sendCommunityStandard: true },
    });
    // The IPv6 block must never leak into the flat IPv4 unicast fields.
    expect(ipv6Peer?.routeMapIn).toBeUndefined();
    expect(vpnPeer).toMatchObject({ vpnv6Activated: true, sendCommunityExtended: true });
    expect(vpnPeer?.vpnv4Activated).toBeUndefined();
    expect(parsed.bgp.ipv6Networks).toEqual([{ network: "2001:db8:100::", prefixLength: 64 }]);
    expect(parsed.bgp.vrfAddressFamilies).toEqual([
      { vrfId: parsed.vrfs[0]!.id, redistributeConnectedIpv6: true, redistributeStaticIpv6: true },
    ]);
  });

  it("builds canonical Router configuration without executing source text", () => {
    const parsed = parseIosConfig(IOS_MBGP, INTERFACES);
    const config = buildDeviceConfigFromIos("router", parsed, INTERFACES, "PE1").config;

    expect(config).toMatchObject({
      kind: "router",
      ipv6PrefixLists: [{ id: "CUSTOMER6" }],
      bgp: { localAs: 65_000, ipv6Networks: [{ network: "2001:db8:100::", prefixLength: 64 }] },
    });
    // Runtime never crosses the import boundary.
    expect(JSON.stringify(config)).not.toMatch(/vpnLabel|adjRib|lfib/iu);
  });

  it.each([
    ["EVPN address family", " address-family l2vpn evpn"],
    ["labeled unicast", " address-family ipv6 unicast labeled-unicast"],
    ["dynamic PE-CE redistribution", " redistribute ospf 1"],
  ])("reports %s as unsupported instead of applying it", (_label, line) => {
    const parsed = parseIosConfig(`router bgp 65000\n address-family ipv6 vrf CUSTOMER-A\n${line}\n`, INTERFACES);
    expect(parsed.unparsedLines.map((entry) => entry.trim())).toContain(line.trim());
  });
});
