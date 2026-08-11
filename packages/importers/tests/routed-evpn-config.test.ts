import type { Layer3SwitchDeviceConfig } from "@sim/contracts";
import { buildDeviceConfigFromIos, parseIosConfig } from "@sim/importers";
import { describe, expect, it } from "vitest";

/**
 * M10.15.1 — the routed-EVPN import subset.
 *
 * An import is an untrusted, one-way conversion. The recognised subset is
 * mapped as structured configuration; everything the simulator does not model
 * is reported as unsupported rather than approximated into something it is not.
 */

const INTERFACES = ["Gi0/1", "Gi0/2"];

const ROUTED_EVPN = `
hostname LEAF1
ip routing
fabric forwarding anycast-gateway-mac 0200.00ff.0001
!
vrf definition TENANT-A
 rd 65000:50001
 route-target import 65000:50001
 route-target export 65000:50001
!
vlan 10
 name TENANT-A-WEB
!
interface Gi0/1
 switchport mode access
 switchport access vlan 10
!
interface Gi0/2
 no switchport
 ip address 192.0.2.1 255.255.255.252
!
interface Vlan10
 vrf forwarding TENANT-A
 ip address 10.10.10.1 255.255.255.0
 fabric forwarding mode anycast-gateway
!
interface Loopback0
 ip address 10.255.0.1 255.255.255.255
!
interface nve1
 no shutdown
 source-interface Loopback0
 member vni 10010
  ingress-replication protocol bgp
 member vni 50001 associate-vrf TENANT-A
!
vlan configuration 10
 member vni 10010
!
evpn
 vni 10010 l2
  rd 65000:10010
  route-target import 65000:10010
  route-target export 65000:10010
!
router bgp 65000
 bgp router-id 10.255.0.1
 neighbor 10.255.0.9 remote-as 65000
 neighbor 10.255.0.9 update-source Loopback0
 address-family l2vpn evpn
  neighbor 10.255.0.9 activate
  neighbor 10.255.0.9 send-community extended
 exit-address-family
 address-family ipv4 vrf TENANT-A
  advertise l2vpn evpn
 exit-address-family
`;

/**
 * The M10.16 multihoming subset: one Ethernet Segment with a Single-Active
 * redundancy mode, bound to an access switchport.
 */
const MULTIHOMING = `
hostname LEAF1
ip routing
!
vlan 10
 name TENANT-A
!
evpn ethernet-segment ES-CE1
 identifier 0000:0000:0000:0000:0001
 redundancy-mode single-active
!
interface Gi0/1
 switchport mode access
 switchport access vlan 10
 ethernet-segment ES-CE1
!
interface Loopback0
 ip address 10.255.0.1 255.255.255.255
!
interface nve1
 no shutdown
 source-interface Loopback0
 member vni 10010
  ingress-replication protocol bgp
!
vlan configuration 10
 member vni 10010
!
evpn
 vni 10010 l2
  rd 65000:10010
  route-target import 65000:10010
  route-target export 65000:10010
`;

/** Everything M10.15 and M10.16 deliberately do not model. */
const UNSUPPORTED = `
interface nve1
 source-interface Loopback0
 member vni 10010
  ingress-replication protocol static
  suppress-arp
 member vni 30000
  multisite ingress-replication
!
evpn
 vni 10010 l3
 ethernet-segment 1
  identifier type 0 00.11.22.33.44.55.66.77.88
  redundancy all-active
!
router bgp 65000
 address-family l2vpn evpn
  route-type 1
  route-type 4
 exit-address-family
 address-family ipv6 vrf TENANT-A
  advertise l2vpn evpn
 exit-address-family
!
interface Vlan10
 ip arp suppression
!
nve anycast-vtep 10.255.0.99
!
evpn ethernet-segment ES-ALL-ACTIVE
 identifier 0000:0000:0000:0000:0002
 redundancy-mode all-active
 df-election type highest-random-weight
 df-preference 200
 ac-df disable
!
evpn ethernet-segment ES-RESERVED
 identifier 0000:0000:0000:0000:0000
`;

function map(text: string): Layer3SwitchDeviceConfig {
  const parsed = parseIosConfig(text, INTERFACES);
  const built = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "LEAF1").config;
  if (built?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
  return built;
}

describe("routed EVPN import subset", () => {
  it("maps the fabric gateway MAC, the anycast SVI and its tenant VRF", () => {
    const config = map(ROUTED_EVPN);
    expect(config.evpn?.anycastGatewayMac).toBe("02:00:00:ff:00:01");
    expect(config.svis).toEqual([expect.objectContaining({
      vlanId: 10,
      ipAddress: "10.10.10.1",
      prefixLength: 24,
      adminUp: true,
      vrfId: "TENANT-A",
      anycastGateway: true,
    })]);
    expect(config.vrfs).toEqual([expect.objectContaining({
      id: "TENANT-A",
      routeDistinguisher: "65000:50001",
      importRouteTargets: ["65000:50001"],
      exportRouteTargets: ["65000:50001"],
      advertiseEvpn: true,
    })]);
  });

  it("maps the L3VNI, the bridged VNI and the EVPN address family together", () => {
    const config = map(ROUTED_EVPN);
    expect(config.nve).toEqual(expect.objectContaining({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
      vrfMembers: [{ vni: 50_001, vrfId: "TENANT-A" }],
    }));
    expect(config.evpn?.vnis).toEqual([{
      vni: 10_010,
      routeDistinguisher: "65000:10010",
      importRouteTargets: ["65000:10010"],
      exportRouteTargets: ["65000:10010"],
    }]);
    expect(config.bgp?.neighbors[0]).toEqual(expect.objectContaining({
      address: "10.255.0.9",
      evpnActivated: true,
      sendCommunityExtended: true,
    }));
  });

  it("maps the M10.16 Ethernet Segment and its attachment", () => {
    const config = map(MULTIHOMING);
    expect(config.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: "0000:0000:0000:0000:0001",
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    const unparsed = parseIosConfig(MULTIHOMING, INTERFACES).unparsedLines.join("\n");
    for (const line of ["evpn ethernet-segment", "identifier", "redundancy-mode", "ethernet-segment ES-CE1"]) {
      expect(unparsed, `expected '${line}' to be understood`).not.toContain(line);
    }
  });

  it("reports every routed-EVPN construct SimulatorNet does not model", () => {
    const parsed = parseIosConfig(UNSUPPORTED, INTERFACES);
    const unparsed = parsed.unparsedLines.join("\n");
    for (const line of [
      "suppress-arp",
      "multisite ingress-replication",
      "vni 10010 l3",
      "ethernet-segment 1",
      "identifier type 0 00.11.22.33.44.55.66.77.88",
      "redundancy all-active",
      "route-type 1",
      "route-type 4",
      "ip arp suppression",
      "nve anycast-vtep 10.255.0.99",
      // M10.16 is Single-Active only: all-active, HRW, an ESI preference and
      // AC-DF are reported rather than accepted as something they are not.
      "redundancy-mode all-active",
      "df-election type highest-random-weight",
      "df-preference 200",
      "ac-df disable",
      "identifier 0000:0000:0000:0000:0000",
    ]) {
      expect(unparsed, `expected '${line}' to be reported as unsupported`).toContain(line);
    }
    // A segment whose redundancy mode is not modelled never becomes one.
    expect(parsed.evpn?.ethernetSegments).toBeUndefined();
    // An IPv6 tenant advertisement is not invented into an IPv4-only Type 5.
    expect(parsed.vrfs.some((vrf) => vrf.advertiseEvpn === true)).toBe(false);
    // Nothing unsupported leaked into the mapped configuration.
    const config = map(UNSUPPORTED);
    expect(config.nve?.vrfMembers).toBeUndefined();
    expect(config.svis.every((svi) => svi.anycastGateway === undefined)).toBe(true);
  });

  it("drops an L3VNI whose VRF the file never defined rather than inventing one", () => {
    const config = map(ROUTED_EVPN.replace("vrf definition TENANT-A", "vrf definition OTHER"));
    expect(config.nve?.vrfMembers).toBeUndefined();
    expect(config.svis[0]?.vrfId).toBeUndefined();
    // The SVI, its address and its anycast mode still survive.
    expect(config.svis[0]).toEqual(expect.objectContaining({ vlanId: 10, ipAddress: "10.10.10.1", anycastGateway: true }));
  });
});
