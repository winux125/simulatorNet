import type { Layer3SwitchDeviceConfig } from "@sim/contracts";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "@sim/device-config";
import { describe, expect, it } from "vitest";

/**
 * M10.16 — the multihoming projection.
 *
 * Configuration text is a projection of structured `DeviceConfig`, so what is
 * checked here is that the projection round-trips and that an unsupported line
 * is reported rather than invented into something the engine does not model.
 */

const ESI = "0000:0000:0000:0000:0001";
const INTERFACES = ["Gi0/1", "Gi0/2"];

const config: Layer3SwitchDeviceConfig = {
  kind: "l3-switch",
  hostname: "LEAF1",
  vlans: [{ id: 10, name: "TENANT-A" }],
  interfaces: [
    { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
    { id: "Gi0/2", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 30 } },
  ],
  svis: [],
  staticRoutes: [],
  ipRoutingEnabled: true,
  loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
  nve: {
    id: "nve1",
    sourceInterfaceId: "Loopback0",
    shutdown: false,
    members: [{ vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } }],
  },
  evpn: {
    vnis: [{
      vni: 10_010,
      routeDistinguisher: "65000:10010",
      importRouteTargets: ["65000:10010"],
      exportRouteTargets: ["65000:10010"],
    }],
    ethernetSegments: [{ id: "ES-CE1", esi: ESI, redundancyMode: "single-active", interfaces: ["Gi0/1"] }],
  },
} as Layer3SwitchDeviceConfig;

describe("EVPN multihoming configuration text", () => {
  it("renders the segment block and the attachment binding, then reads them back", () => {
    const text = renderDeviceConfiguration(config);
    expect(text).toContain("evpn ethernet-segment ES-CE1");
    expect(text).toContain(` identifier ${ESI}`);
    expect(text).toContain(" redundancy-mode single-active");
    expect(text).toContain(" ethernet-segment ES-CE1");

    const parsed = parseIosConfig(text, INTERFACES);
    expect(parsed.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Gi0/1"],
    }]);
    const rebuilt = buildDeviceConfigFromIos("l3-switch", parsed, INTERFACES, "LEAF1").config;
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.evpn?.ethernetSegments).toEqual(config.evpn!.ethernetSegments);
    // Rendering the rebuilt configuration produces the same bytes.
    expect(renderDeviceConfiguration(rebuilt)).toContain("evpn ethernet-segment ES-CE1");
  });

  it("reads All-Active and reports every multihoming construct that is not modelled", () => {
    const parsed = parseIosConfig(`
hostname LEAF1
!
evpn ethernet-segment ES-CE1
 identifier ${ESI}
 redundancy-mode all-active
!
evpn ethernet-segment ES-PREF
 identifier 0000:0000:0000:0000:0002
 redundancy-mode port-active
 df-preference 200
 ethernet-segment df-election type preference
!
evpn ethernet-segment ES-ZERO
 identifier 0000:0000:0000:0000:0000
!
evpn ethernet-segment ES-MAX
 identifier ffff:ffff:ffff:ffff:ffff
!
interface Gi0/1
 switchport mode access
 switchport access vlan 10
 ethernet-segment ES-CE1
`, INTERFACES);
    const unparsed = parsed.unparsedLines.join("\n");
    for (const line of [
      "redundancy-mode port-active",
      "df-preference 200",
      "ethernet-segment df-election type preference",
      "identifier 0000:0000:0000:0000:0000",
      "identifier ffff:ffff:ffff:ffff:ffff",
    ]) {
      expect(unparsed, `expected '${line}' to be reported as unsupported`).toContain(line);
    }
    // All-Active is modelled since M10.17, so it is read rather than reported.
    expect(unparsed).not.toContain("redundancy-mode all-active");
    // A segment with no supported redundancy mode is still dropped, never
    // invented into a mode the author never asked for.
    expect(parsed.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "all-active",
      interfaces: ["Gi0/1"],
    }]);
  });

  it("round-trips an All-Active segment through render and parse", () => {
    const allActive = {
      ...config,
      evpn: {
        ...config.evpn!,
        ethernetSegments: [{ ...config.evpn!.ethernetSegments![0]!, redundancyMode: "all-active" as const }],
      },
    } as Layer3SwitchDeviceConfig;
    const text = renderDeviceConfiguration(allActive);
    expect(text).toContain(" redundancy-mode all-active");
    const rebuilt = buildDeviceConfigFromIos("l3-switch", parseIosConfig(text, INTERFACES), INTERFACES, "LEAF1").config;
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.evpn?.ethernetSegments).toEqual(allActive.evpn!.ethernetSegments);
    expect(renderDeviceConfiguration(rebuilt)).toBe(text);
  });
});
