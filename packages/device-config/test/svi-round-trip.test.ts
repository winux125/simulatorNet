import type { Layer3SwitchDeviceConfig, SwitchDeviceConfig } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "../src";

/**
 * M10.15.1 — one SVI model round-trips through the configuration projection.
 *
 * `interface Vlan<n>` is a logical interface, so it is never matched against the
 * device's physical port list, and the same mapping serves plain inter-VLAN
 * routing and a routed EVPN tenant gateway. There is no EVPN-specific SVI shape.
 */

const INTERFACES = ["Gi0/1", "Gi0/2"];

function roundTrip(config: Layer3SwitchDeviceConfig): Layer3SwitchDeviceConfig {
  const text = renderDeviceConfiguration(config);
  const parsed = parseIosConfig(text, INTERFACES);
  const built = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "L3SW").config;
  if (built?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
  return built;
}

const PLAIN: Layer3SwitchDeviceConfig = {
  kind: "l3-switch",
  hostname: "DIST1",
  vlans: [{ id: 10, name: "USERS" }, { id: 20, name: "SERVERS" }],
  interfaces: [
    { id: "Gi0/1", mode: "access", accessVlan: 10, nativeVlan: 1, shutdown: false },
    { id: "Gi0/2", mode: "access", accessVlan: 20, nativeVlan: 1, shutdown: false },
  ],
  svis: [
    { vlanId: 10, ipAddress: "10.0.10.1", prefixLength: 24, adminUp: true, description: "User gateway" },
    { vlanId: 20, ipAddress: "10.0.20.1", prefixLength: 24, adminUp: false },
  ],
  staticRoutes: [{ network: "192.168.9.0", prefixLength: 24, nextHop: "10.0.10.9" }],
  ipRoutingEnabled: true,
  acls: [],
  aclBindings: [],
} as unknown as Layer3SwitchDeviceConfig;

const ROUTED_EVPN: Layer3SwitchDeviceConfig = {
  kind: "l3-switch",
  hostname: "LEAF1",
  vlans: [{ id: 10, name: "TENANT-A-WEB" }],
  interfaces: [
    { id: "Gi0/1", mode: "access", accessVlan: 10, nativeVlan: 1, shutdown: false },
    { id: "Gi0/2", mode: "routed", shutdown: false, ipv4: { address: "192.0.2.1", prefixLength: 30 } },
  ],
  svis: [
    {
      vlanId: 10,
      ipAddress: "10.10.10.1",
      prefixLength: 24,
      adminUp: true,
      description: "TENANT-A anycast gateway",
      vrfId: "TENANT-A",
      anycastGateway: true,
    },
  ],
  vrfs: [{
    id: "TENANT-A",
    name: "TENANT-A",
    routeDistinguisher: "65000:50001",
    importRouteTargets: ["65000:50001"],
    exportRouteTargets: ["65000:50001"],
    staticRoutes: [],
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
    anycastGatewayMac: "02:00:00:ff:00:01",
  },
  // `advertise l2vpn evpn` lives inside `address-family ipv4 vrf`, so the
  // tenant only round-trips together with the BGP process that carries it.
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

describe("L3 Switch SVI configuration round-trip", () => {
  it("preserves an ordinary inter-VLAN routing SVI", () => {
    const applied = roundTrip(PLAIN);
    expect(applied.svis).toEqual([
      {
        vlanId: 10,
        ipAddress: "10.0.10.1",
        prefixLength: 24,
        adminUp: true,
        description: "User gateway",
        ipv6: undefined,
        vrfId: undefined,
        anycastGateway: undefined,
      },
      {
        vlanId: 20,
        ipAddress: "10.0.20.1",
        prefixLength: 24,
        adminUp: false,
        description: undefined,
        ipv6: undefined,
        vrfId: undefined,
        anycastGateway: undefined,
      },
    ]);
    // A next hop that sits on an SVI subnet is directly connected, so the
    // static route survives instead of being dropped as unreachable.
    expect(applied.staticRoutes).toEqual([{ network: "192.168.9.0", prefixLength: 24, nextHop: "10.0.10.9" }]);
    expect(applied.ipRoutingEnabled).toBe(true);
    // Declaring an SVI declares the VLAN it routes for.
    expect(applied.vlans.map((vlan) => vlan.id)).toEqual([1, 10, 20]);
  });

  it("preserves the VLAN, SVI, address, VRF, anycast flag and L3VNI association", () => {
    const applied = roundTrip(ROUTED_EVPN);
    expect(applied.svis).toEqual([expect.objectContaining({
      vlanId: 10,
      ipAddress: "10.10.10.1",
      prefixLength: 24,
      adminUp: true,
      vrfId: "TENANT-A",
      anycastGateway: true,
    })]);
    expect(applied.vlans.some((vlan) => vlan.id === 10)).toBe(true);
    expect(applied.evpn?.anycastGatewayMac).toBe("02:00:00:ff:00:01");
    expect(applied.nve?.vrfMembers).toEqual([{ vni: 50_001, vrfId: "TENANT-A" }]);
    expect(applied.vrfs).toEqual([expect.objectContaining({ id: "TENANT-A", advertiseEvpn: true })]);
  });

  it("renders identical text the second time round, so nothing drifts", () => {
    const once = renderDeviceConfiguration(ROUTED_EVPN);
    expect(renderDeviceConfiguration(roundTrip(ROUTED_EVPN))).toBe(once);
  });

  it("reports every recognised SVI line instead of skipping the block", () => {
    const parsed = parseIosConfig(renderDeviceConfiguration(ROUTED_EVPN), INTERFACES);
    const sviLines = parsed.lines.filter((line) =>
      line.text.startsWith("interface Vlan")
      || line.text === "vrf forwarding TENANT-A"
      || line.text === "fabric forwarding mode anycast-gateway"
      || line.text === "ip address 10.10.10.1 255.255.255.0");
    expect(sviLines).toHaveLength(4);
    expect(sviLines.every((line) => line.outcome === "applied")).toBe(true);
  });

  it("drops an SVI VRF binding the file never defined rather than inventing one", () => {
    const text = renderDeviceConfiguration(ROUTED_EVPN).replace("vrf definition TENANT-A", "vrf definition OTHER");
    const parsed = parseIosConfig(text, INTERFACES);
    const built = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "LEAF1").config as Layer3SwitchDeviceConfig;
    expect(built.svis[0]?.vrfId).toBeUndefined();
    // The SVI itself, its address and its anycast mode are still preserved.
    expect(built.svis[0]).toEqual(expect.objectContaining({ vlanId: 10, ipAddress: "10.10.10.1", anycastGateway: true }));
  });

  it("keeps a distributed anycast gateway an SVI property", () => {
    const parsed = parseIosConfig([
      "interface Gi0/2",
      " no switchport",
      " ip address 192.0.2.1 255.255.255.252",
      " fabric forwarding mode anycast-gateway",
    ].join("\n"), INTERFACES);
    expect(parsed.unparsedLines).toContain("fabric forwarding mode anycast-gateway");
  });

  it("never turns an SVI into a physical port on any device kind", () => {
    const parsed = parseIosConfig(renderDeviceConfiguration(PLAIN), INTERFACES);
    expect(parsed.interfaces.map((iface) => iface.id)).toEqual(INTERFACES);
    const l2 = buildDeviceConfigFromIos("l2-switch", parsed, INTERFACES, "ACC1").config as SwitchDeviceConfig;
    expect(l2.interfaces.map((iface) => iface.id)).toEqual(INTERFACES);
  });
});
