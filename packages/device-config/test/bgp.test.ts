import type { DeviceConfig } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "../src";

const SOURCE = [
  "interface Gi0/0",
  " ip address 192.0.2.1 255.255.255.252",
  "!",
  "interface Loopback0",
  " ip address 10.10.0.1 255.255.255.0",
  "!",
  "ip prefix-list CUSTOMER seq 10 permit 10.10.0.0/16 le 24",
  "route-map ISP-IN permit 10",
  " match ip address prefix-list CUSTOMER",
  " set local-preference 200",
  " set metric 50",
  " set origin incomplete",
  "!",
  "router bgp 65001",
  " bgp router-id 1.1.1.1",
  " neighbor 192.0.2.2 remote-as 65002",
  " neighbor 192.0.2.2 description Transit ISP",
  " neighbor 192.0.2.2 update-source Loopback0",
  " neighbor 192.0.2.2 ebgp-multihop 2",
  " neighbor 192.0.2.2 next-hop-self",
  " neighbor 192.0.2.2 prefix-list CUSTOMER in",
  " neighbor 192.0.2.2 route-map ISP-IN in",
  " network 10.10.0.0 mask 255.255.255.0",
].join("\n");

describe("BGP IOS-like import and render", () => {
  it("parses the supported process, neighbor and network subset", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0"]);
    expect(parsed.bgp).toMatchObject({ localAs: 65_001, routerId: "1.1.1.1", networks: [{ network: "10.10.0.0", prefixLength: 24 }] });
    expect(parsed.bgp?.neighbors[0]).toMatchObject({
      address: "192.0.2.2", remoteAs: 65_002, updateSource: "Loopback0", ebgpMultihop: 2,
      nextHopSelf: true, prefixListIn: "CUSTOMER", routeMapIn: "ISP-IN",
    });
  });

  it("parses prefix lists and route-map set actions", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0"]);
    expect(parsed.prefixLists[0]?.entries[0]).toMatchObject({ sequence: 10, action: "permit", le: 24 });
    expect(parsed.routeMaps[0]?.sequences[0]).toMatchObject({
      match: { prefixListIds: ["CUSTOMER"] }, set: { localPreference: 200, med: 50, origin: "incomplete" },
    });
  });

  it("maps BGP configuration only onto supported routed devices", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0"]);
    const router = buildDeviceConfigFromIos("router", parsed, ["Gi0/0"], "R1").config;
    const l3 = buildDeviceConfigFromIos("l3-switch", parsed, ["Gi0/0"], "L3SW").config;
    expect(router && "bgp" in router ? router.bgp?.localAs : undefined).toBe(65_001);
    expect(l3 && "bgp" in l3 ? l3.bgp?.localAs : undefined).toBe(65_001);
  });

  it("renders configuration deterministically without runtime RIB state", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0"]);
    const config = buildDeviceConfigFromIos("router", parsed, ["Gi0/0"], "R1").config as DeviceConfig;
    const text = renderDeviceConfiguration(config);
    expect(text).toContain("router bgp 65001");
    expect(text).toContain("neighbor 192.0.2.2 route-map ISP-IN in");
    expect(text).toContain("ip prefix-list CUSTOMER seq 10 permit 10.10.0.0/16 le 24");
    expect(text).not.toMatch(/Adj-RIB|Loc-RIB|Established|counter/);
    expect(renderDeviceConfiguration(config)).toBe(text);
  });

  it("accepts VPNv4 and send-community while keeping unsupported variants in the report", () => {
    const parsed = parseIosConfig(
      `${SOURCE}\n address-family vpnv4\n neighbor 192.0.2.2 send-community\n neighbor 192.0.2.2 send-community local-as\n`,
      ["Gi0/0"],
    );
    expect(parsed.appliedLines).toContain("address-family vpnv4");
    expect(parsed.appliedLines).toContain("neighbor 192.0.2.2 send-community");
    // local-AS/no-export-subconfed needs confederations, which do not exist.
    expect(parsed.unparsedLines).toContain("neighbor 192.0.2.2 send-community local-as");
  });
});

const ADVANCED_SOURCE = [
  "interface Gi0/0",
  " ip address 10.0.1.1 255.255.255.252",
  "!",
  "ip community-list standard CUSTOMER permit 65000:100",
  "ip community-list expanded WILD permit 65000:.*",
  "ip as-path access-list NO-TRANSIT permit _65100_",
  "ip as-path access-list BAD permit ^(65001|65002)+$",
  "route-map POLICY permit 10",
  " match community CUSTOMER",
  " match as-path NO-TRANSIT",
  " match route-type ebgp",
  " set community 65000:200 additive",
  " set as-path prepend 65000 65000",
  "!",
  "router bgp 65000",
  " bgp router-id 10.255.0.1",
  " bgp cluster-id 10.255.0.9",
  " neighbor 10.0.1.2 remote-as 65000",
  " neighbor 10.0.1.2 route-reflector-client",
  " neighbor 10.0.1.2 send-community both",
  " neighbor 10.0.2.2 remote-as 65100",
  " neighbor 10.0.2.2 default-originate route-map POLICY",
  " aggregate-address 10.20.0.0 255.255.0.0 summary-only as-set",
  " clear ip bgp * soft",
].join("\n");

describe("M10.12 BGP IOS-like import and render", () => {
  it("parses reflection, communities, safe AS-path lists, aggregation and default-originate", () => {
    const parsed = parseIosConfig(ADVANCED_SOURCE, ["Gi0/0"]);
    expect(parsed.bgp).toMatchObject({
      clusterId: "10.255.0.9",
      aggregates: [{ prefix: "10.20.0.0", prefixLength: 16, summaryOnly: true, asSet: true }],
    });
    expect(parsed.bgp?.neighbors).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: "10.0.1.2", routeReflectorClient: true, sendCommunityStandard: true, sendCommunityExtended: true }),
      expect.objectContaining({ address: "10.0.2.2", defaultOriginate: true, defaultOriginateRouteMap: "POLICY" }),
    ]));
    expect(parsed.communityLists).toEqual([{ id: "CUSTOMER", entries: [{ sequence: 10, action: "permit", communities: ["65000:100"] }] }]);
    expect(parsed.asPathLists).toEqual([{ id: "NO-TRANSIT", entries: [{ sequence: 10, action: "permit", matcher: { kind: "contains", asn: 65_100 } }] }]);
    expect(parsed.routeMaps[0]?.sequences[0]).toMatchObject({
      match: { communityListIds: ["CUSTOMER"], asPathListIds: ["NO-TRANSIT"], source: "ebgp" },
      set: { communities: ["65000:200"], communityAdditive: true, prependAsns: [65_000, 65_000] },
    });
  });

  it("reports unsupported regex community/AS-path forms and never imports a soft clear", () => {
    const parsed = parseIosConfig(ADVANCED_SOURCE, ["Gi0/0"]);
    expect(parsed.unparsedLines).toContain("ip community-list expanded WILD permit 65000:.*");
    expect(parsed.unparsedLines).toContain("ip as-path access-list BAD permit ^(65001|65002)+$");
    expect(parsed.unparsedLines).toContain("clear ip bgp * soft");
  });

  it("renders the M10.12 subset back to the same bytes", () => {
    const parsed = parseIosConfig(ADVANCED_SOURCE, ["Gi0/0"]);
    const config = buildDeviceConfigFromIos("router", parsed, ["Gi0/0"], "RR").config as DeviceConfig;
    const text = renderDeviceConfiguration(config);
    for (const line of [
      "ip community-list standard CUSTOMER permit 65000:100",
      "ip as-path access-list NO-TRANSIT permit _65100_",
      " match community CUSTOMER",
      " set community 65000:200 additive",
      " set as-path prepend 65000 65000",
      " bgp cluster-id 10.255.0.9",
      " neighbor 10.0.1.2 route-reflector-client",
      " neighbor 10.0.1.2 send-community both",
      " neighbor 10.0.2.2 default-originate route-map POLICY",
      " aggregate-address 10.20.0.0 255.255.0.0 summary-only as-set",
    ]) expect(text.split("\n")).toContain(line);
    expect(renderDeviceConfiguration(config)).toBe(text);
  });
});
