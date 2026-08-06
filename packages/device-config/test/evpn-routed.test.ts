import type { Layer3SwitchDeviceConfig } from "@sim/contracts";
import { inspectDeviceConfigurationText, renderDeviceConfiguration } from "@sim/device-config";
import { describe, expect, it } from "vitest";

// M10.15c — routed EVPN survives the running-config projection and the atomic
// text apply. Configuration only: no imported prefix, no counter, no runtime.

const ANYCAST_MAC = "02:00:00:ff:00:01";

const LEAF: Layer3SwitchDeviceConfig = {
  kind: "l3-switch",
  hostname: "Leaf1",
  vlans: [{ id: 10, name: "TENANT-A-WEB" }],
  interfaces: [
    { id: "Gi0/1", mode: "access", accessVlan: 10, nativeVlan: 1, shutdown: false },
    { id: "Gi0/2", mode: "routed", shutdown: false, ipv4: { address: "192.0.2.1", prefixLength: 30 } },
  ],
  svis: [
    { vlanId: 10, ipAddress: "10.10.10.1", prefixLength: 24, adminUp: true, vrfId: "TENANT-A", anycastGateway: true },
  ],
  vrfs: [{
    id: "TENANT-A",
    name: "TENANT-A",
    routeDistinguisher: "65000:50001",
    importRouteTargets: ["65000:50001"],
    exportRouteTargets: ["65000:50001"],
    staticRoutes: [{ network: "172.16.9.0", prefixLength: 24, nextHop: "10.10.10.9" }],
    advertiseEvpn: true,
  }],
  staticRoutes: [],
  ipRoutingEnabled: true,
  loopbacks: [{ id: 0, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
  nve: {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    shutdown: false,
    members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
    vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
  },
  evpn: {
    vnis: [{
      vni: 10_010,
      routeDistinguisher: "65000:10010",
      importRouteTargets: ["65000:10010"],
      exportRouteTargets: ["65000:10010"],
    }],
    anycastGatewayMac: ANYCAST_MAC,
  },
  bgp: {
    localAs: 65_000,
    routerId: "10.255.0.1",
    networks: [],
    neighbors: [{
      address: "10.255.0.9",
      remoteAs: 65_000,
      updateSource: "Loopback0",
      evpnActivated: true,
      sendCommunityExtended: true,
    }],
  },
  acls: [],
  aclBindings: [],
} as unknown as Layer3SwitchDeviceConfig;

function render(): string {
  return renderDeviceConfiguration(LEAF);
}

function inspect(text: string) {
  return inspectDeviceConfigurationText(text, {
    deviceId: "leaf1",
    deviceType: "l3-switch",
    interfaceIds: ["Gi0/1", "Gi0/2"],
    fallbackHostname: "Leaf1",
  });
}

describe("M10.15c routed EVPN configuration text", () => {
  it("renders the fabric gateway, the tenant VRF, the L3VNI and the advertise flag", () => {
    const text = render();
    expect(text).toContain(`fabric forwarding anycast-gateway-mac ${ANYCAST_MAC}`);
    expect(text).toContain("vrf definition TENANT-A");
    expect(text).toContain(" rd 65000:50001");
    expect(text).toContain(" route-target import 65000:50001");
    expect(text).toContain(" route-target export 65000:50001");
    expect(text).toContain("ip route vrf TENANT-A 172.16.9.0 255.255.255.0 10.10.10.9");
    expect(text).toContain(" vrf forwarding TENANT-A");
    expect(text).toContain(" fabric forwarding mode anycast-gateway");
    expect(text).toContain(" member vni 50001 associate-vrf TENANT-A");
    expect(text).toContain(" address-family ipv4 vrf TENANT-A");
    expect(text).toContain("  advertise l2vpn evpn");
    // The routing context is chosen before the address it scopes.
    expect(text.indexOf(" vrf forwarding TENANT-A")).toBeLessThan(text.indexOf(" ip address 10.10.10.1"));
    // An L3VNI has no broadcast domain, so it gets no `vlan configuration`.
    expect(text).not.toContain("vlan configuration 50001");
  });

  it("never renders runtime state or a learned prefix", () => {
    const text = render();
    for (const forbidden of ["evpn-type5", "Type 5", "imported", "counter", "10.10.20.0"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("round-trips through the atomic text apply", () => {
    const plan = inspect(render());
    const applied = plan.configuration as Layer3SwitchDeviceConfig;
    expect(applied.evpn?.anycastGatewayMac).toBe(ANYCAST_MAC);
    expect(applied.nve?.vrfMembers).toEqual([{ vni: 50_001, vrfId: "TENANT-A" }]);
    expect(applied.vrfs).toEqual([expect.objectContaining({
      id: "TENANT-A",
      routeDistinguisher: "65000:50001",
      importRouteTargets: ["65000:50001"],
      exportRouteTargets: ["65000:50001"],
      advertiseEvpn: true,
    })]);
    expect(applied.vrfs?.[0]?.staticRoutes)
      .toEqual([{ network: "172.16.9.0", prefixLength: 24, nextHop: "10.10.10.9" }]);
  });

  it("reports an L3VNI whose VRF the file never defined, rather than inventing one", () => {
    const text = render().replace("vrf definition TENANT-A", "vrf definition OTHER");
    const applied = inspect(text).configuration as Layer3SwitchDeviceConfig;
    expect(applied.nve?.vrfMembers).toBeUndefined();
  });

  it("refuses an anycast gateway MAC that could never be a next hop", () => {
    for (const bad of ["0100.5e00.0001", "0000.0000.0000", "not-a-mac"]) {
      const plan = inspect(render().replace(ANYCAST_MAC, bad));
      const applied = plan.configuration as Layer3SwitchDeviceConfig;
      expect(applied.evpn?.anycastGatewayMac).toBeUndefined();
      // The line is reported rather than silently accepted.
      expect(plan.unsupportedCount).toBeGreaterThan(0);
    }
  });
});
