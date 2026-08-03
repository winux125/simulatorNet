import type { DeviceConfig } from "@sim/contracts";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "../src";
import { describe, expect, it } from "vitest";

const SOURCE = [
  "mpls label protocol ldp",
  "mpls ldp router-id Loopback0 force",
  "vrf definition CUSTOMER-A",
  " rd 65000:100",
  " route-target import 65000:100",
  " route-target export 65000:100",
  "!",
  "interface Gi0/0",
  " ip address 192.0.2.1 255.255.255.252",
  " mpls ip",
  "!",
  "interface Gi0/1",
  " vrf forwarding CUSTOMER-A",
  " ip address 10.1.1.1 255.255.255.0",
  "!",
  "interface Loopback0",
  " ip address 1.1.1.1 255.255.255.255",
  "!",
  "ip route vrf CUSTOMER-A 10.2.1.0 255.255.255.0 10.1.1.2",
  "router bgp 65000",
  " bgp router-id 1.1.1.1",
  " neighbor 3.3.3.3 remote-as 65000",
  " neighbor 3.3.3.3 update-source Loopback0",
  " address-family vpnv4",
  "  neighbor 3.3.3.3 activate",
  "  neighbor 3.3.3.3 send-community extended",
  " exit-address-family",
  " address-family ipv4 vrf CUSTOMER-A",
  "  redistribute connected",
  "  redistribute static",
  " exit-address-family",
].join("\n");

describe("MPLS and L3VPN IOS-like import/render", () => {
  it("parses MPLS/LDP and interface VRF identity without inventing links", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0", "Gi0/1"]);
    expect(parsed.ldp).toEqual({ routerIdInterface: "Loopback0" });
    expect(parsed.interfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "Gi0/0", mplsEnabled: true }),
      expect.objectContaining({ id: "Gi0/1", vrfId: "CUSTOMER-A" }),
    ]));
  });

  it("parses RD/RT, VRF static routes and VPNv4 activation", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0", "Gi0/1"]);
    expect(parsed.vrfs[0]).toMatchObject({
      id: "CUSTOMER-A", routeDistinguisher: "65000:100",
      importRouteTargets: ["65000:100"], exportRouteTargets: ["65000:100"],
      staticRoutes: [{ network: "10.2.1.0", prefixLength: 24, nextHop: "10.1.1.2" }],
    });
    expect(parsed.bgp).toMatchObject({
      neighbors: [{ address: "3.3.3.3", vpnv4Activated: true, sendCommunityExtended: true }],
      vrfAddressFamilies: [{ vrfId: "CUSTOMER-A", redistributeConnected: true, redistributeStatic: true }],
    });
  });

  it("maps and renders the canonical supported subset deterministically", () => {
    const parsed = parseIosConfig(SOURCE, ["Gi0/0", "Gi0/1"]);
    const config = buildDeviceConfigFromIos("router", parsed, ["Gi0/0", "Gi0/1"], "PE1").config as DeviceConfig;
    const rendered = renderDeviceConfiguration(config);
    expect(rendered).toContain("mpls ldp router-id Loopback0 force");
    expect(rendered).toContain("vrf definition CUSTOMER-A");
    expect(rendered).toContain("neighbor 3.3.3.3 send-community extended");
    expect(rendered).toContain("address-family ipv4 vrf CUSTOMER-A");
    expect(rendered).not.toMatch(/LFIB|Operational|allocated label/iu);
    expect(renderDeviceConfiguration(config)).toBe(rendered);
  });

  it("preserves unsupported TE, pseudowire, RR, VPNv6 and EVPN lines", () => {
    const parsed = parseIosConfig(`${SOURCE}\nmpls traffic-eng tunnels\nxconnect 192.0.2.2 10\n neighbor 3.3.3.3 route-reflector-client\n address-family vpnv6\n address-family l2vpn evpn\n`, ["Gi0/0", "Gi0/1"]);
    expect(parsed.unparsedLines).toEqual(expect.arrayContaining([
      "mpls traffic-eng tunnels",
      "xconnect 192.0.2.2 10",
      "neighbor 3.3.3.3 route-reflector-client",
      "address-family vpnv6",
      "address-family l2vpn evpn",
    ]));
  });
});
