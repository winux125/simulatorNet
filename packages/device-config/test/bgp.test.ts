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

  it("accepts VPNv4 while keeping unsupported community variants in the report", () => {
    const parsed = parseIosConfig(`${SOURCE}\n address-family vpnv4\n neighbor 192.0.2.2 send-community\n`, ["Gi0/0"]);
    expect(parsed.appliedLines).toContain("address-family vpnv4");
    expect(parsed.unparsedLines).toContain("neighbor 192.0.2.2 send-community");
  });
});
