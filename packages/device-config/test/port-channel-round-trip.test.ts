import type { Layer3SwitchDeviceConfig, SwitchDeviceConfig } from "@sim/contracts";
import { buildDeviceConfigFromIos, parseIosConfig, renderDeviceConfiguration } from "@sim/device-config";
import { describe, expect, it } from "vitest";

/**
 * M10.17 — the logical Port-channel projection.
 *
 * A bundle is a real logical interface, so what lives on it has to survive
 * `LabDocument → running-config → parse/apply → LabDocument`. Before M10.17 an
 * L3 Switch rendered no Port-channel block at all, which is exactly why an
 * Ethernet Segment could not be bound to one: the binding had nowhere to be
 * written down.
 */

const ESI = "0000:0000:0000:0000:0001";
const INTERFACES = ["Gi0/1", "Gi0/2", "Gi0/3"];

function leaf(overrides: Partial<Layer3SwitchDeviceConfig> = {}): Layer3SwitchDeviceConfig {
  return {
    kind: "l3-switch",
    hostname: "LEAF1",
    // The native VLAN is declared: a trunk that names a VLAN the database does
    // not contain would gain one on the way back through the parser.
    vlans: [{ id: 10, name: "TENANT-A" }, { id: 20, name: "TENANT-B" }, { id: 99, name: "NATIVE" }],
    interfaces: [
      { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
      { id: "Gi0/3", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 30 } },
    ],
    svis: [],
    staticRoutes: [],
    ipRoutingEnabled: true,
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "10.255.0.1", prefixLength: 32 } }],
    etherChannels: [{
      channelId: 10,
      mode: "active",
      members: ["Gi0/1", "Gi0/2"],
      description: "CE-DUAL-HOMED",
      minimumLinks: 2,
      switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 99, allowedVlans: [10, 20] },
    }],
    nve: {
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [
        { vni: 10_010, vlanId: 10, replication: { type: "bgp-evpn" } },
        { vni: 10_020, vlanId: 20, replication: { type: "bgp-evpn" } },
      ],
    },
    evpn: {
      vnis: [10_010, 10_020].map((vni) => ({
        vni,
        routeDistinguisher: `65000:${vni}`,
        importRouteTargets: [`65000:${vni}`],
        exportRouteTargets: [`65000:${vni}`],
      })),
      ethernetSegments: [{
        id: "ES-CE1",
        esi: ESI,
        redundancyMode: "single-active",
        interfaces: ["Port-channel10"],
      }],
    },
    ...overrides,
  } as Layer3SwitchDeviceConfig;
}

/** text → structured, through the exact path an apply takes. */
function reread(text: string, kind: "l3-switch" | "l2-switch", interfaceIds = INTERFACES) {
  const parsed = parseIosConfig(text, interfaceIds);
  return { parsed, rebuilt: buildDeviceConfigFromIos(kind, parsed, interfaceIds, "LEAF1").config };
}

/**
 * The unparsed lines that belong to a bundle or a switchport.
 *
 * `ip routing` and `no switchport` are inferred from what follows them rather
 * than read, which is a much older shape of this parser and not what M10.17
 * changes — so they are excluded rather than silently asserted away.
 */
function unparsedSwitchportLines(unparsedLines: readonly string[]): string[] {
  return unparsedLines.filter((line) => line !== "ip routing" && line !== "no switchport");
}

describe("Port-channel configuration round-trip", () => {
  it("renders the bundle block on an L3 Switch and reads every field back", () => {
    const text = renderDeviceConfiguration(leaf());
    expect(text).toContain("interface Port-channel10");
    expect(text).toContain(" description CE-DUAL-HOMED");
    expect(text).toContain(" switchport mode trunk");
    expect(text).toContain(" switchport trunk native vlan 99");
    expect(text).toContain(" switchport trunk allowed vlan 10,20");
    expect(text).toContain(" ethernet-segment ES-CE1");
    expect(text).toContain(" port-channel min-links 2");
    // Membership is never duplicated: it stays one line per member.
    expect(text).toContain(" channel-group 10 mode active");
    expect(text.match(/channel-group 10 mode active/gu)).toHaveLength(2);

    const { parsed, rebuilt } = reread(text, "l3-switch");
    expect(unparsedSwitchportLines(parsed.unparsedLines)).toEqual([]);
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.etherChannels).toEqual([{
      channelId: 10,
      mode: "active",
      members: ["Gi0/1", "Gi0/2"],
      description: "CE-DUAL-HOMED",
      minimumLinks: 2,
      switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 99, allowedVlans: [10, 20] },
    }]);
    expect(rebuilt.evpn?.ethernetSegments).toEqual(leaf().evpn!.ethernetSegments);
    // The projection is stable: rendering the rebuilt configuration is the same
    // bytes, so a save can never turn a device into a modified one.
    expect(renderDeviceConfiguration(rebuilt)).toBe(text);
  });

  it("round-trips an access bundle with no description or minimum links", () => {
    const config = leaf({
      etherChannels: [{
        channelId: 10,
        mode: "on",
        members: ["Gi0/1", "Gi0/2"],
        switchport: { mode: "access", accessVlan: 10, nativeVlan: 1 },
      }],
    });
    const text = renderDeviceConfiguration(config);
    expect(text).toContain("interface Port-channel10");
    expect(text).toContain(" switchport access vlan 10");
    expect(text).not.toContain(" port-channel min-links");
    expect(text).not.toMatch(/^ description/mu);

    const { rebuilt } = reread(text, "l3-switch");
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.etherChannels?.[0]).toMatchObject({
      channelId: 10,
      mode: "on",
      members: ["Gi0/1", "Gi0/2"],
      switchport: { mode: "access", accessVlan: 10 },
    });
    expect(renderDeviceConfiguration(rebuilt)).toBe(text);
  });

  it("renders and reads the same bundle block on an L2 Switch", () => {
    const config: SwitchDeviceConfig = {
      kind: "l2-switch",
      hostname: "ACCESS1",
      vlans: [{ id: 1, name: "default" }, { id: 10, name: "TENANT-A" }, { id: 20, name: "TENANT-B" }],
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/3", shutdown: false, mode: "access", accessVlan: 1, nativeVlan: 1 },
      ],
      etherChannels: [{
        channelId: 1,
        mode: "active",
        members: ["Gi0/1", "Gi0/2"],
        description: "UPLINK",
        switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] },
      }],
    } as SwitchDeviceConfig;
    const text = renderDeviceConfiguration(config);
    expect(text).toContain("interface Port-channel1");
    expect(text).toContain(" description UPLINK");
    // The allowed VLAN list used to be rendered on a member but never on the
    // bundle, so a trunk bundle silently lost it on every save.
    expect(text).toContain(" switchport trunk allowed vlan 10,20");

    const { parsed, rebuilt } = reread(text, "l2-switch");
    expect(unparsedSwitchportLines(parsed.unparsedLines)).toEqual([]);
    if (rebuilt?.kind !== "l2-switch") throw new Error("expected an L2 Switch configuration");
    expect(rebuilt.etherChannels?.[0]).toMatchObject({
      description: "UPLINK",
      switchport: { mode: "trunk", nativeVlan: 1, allowedVlans: [10, 20] },
    });
    expect(renderDeviceConfiguration(rebuilt)).toBe(text);
  });

  it("round-trips a physical trunk's native and allowed VLANs", () => {
    const config = leaf({
      etherChannels: undefined,
      evpn: { vnis: leaf().evpn!.vnis },
      interfaces: [
        { id: "Gi0/1", shutdown: false, mode: "trunk", accessVlan: 1, nativeVlan: 99, allowedVlans: [10, 20] },
        { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
        { id: "Gi0/3", shutdown: false, mode: "routed", ipv4: { address: "192.0.2.1", prefixLength: 30 } },
      ],
    });
    const text = renderDeviceConfiguration(config);
    const { parsed, rebuilt } = reread(text, "l3-switch");
    expect(unparsedSwitchportLines(parsed.unparsedLines)).toEqual([]);
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.interfaces.find((iface) => iface.id === "Gi0/1")).toMatchObject({
      mode: "trunk",
      nativeVlan: 99,
      allowedVlans: [10, 20],
    });
    expect(renderDeviceConfiguration(rebuilt)).toBe(text);
  });

  it("reports what a bundle does not model instead of accepting it", () => {
    const { parsed } = reread(`
hostname LEAF1
!
interface Port-channel10
 switchport mode trunk
 shutdown
 lacp max-bundle 4
 port-channel min-links 9
!
interface Port-channel99
 switchport mode access
!
`, "l3-switch");
    const unparsed = parsed.unparsedLines.join("\n");
    // A bundle's administrative state is derived from its members, so there is
    // no field to store one in — reporting it beats inventing one.
    expect(unparsed).toContain("shutdown");
    expect(unparsed).toContain("lacp max-bundle 4");
    // Out of range: the bundle can never require more members than it may have.
    expect(unparsed).toContain("port-channel min-links 9");
    // A channel number outside the supported range is reported, and its body is
    // never attributed to some other bundle.
    expect(unparsed).toContain("interface Port-channel99");
    expect(parsed.portChannels.map((channel) => channel.channelId)).toEqual([10]);
    expect(parsed.portChannels[0]).toEqual({ channelId: 10, switchportMode: "trunk" });
  });

  it("drops a bundle no member declares, and the segment binding with it", () => {
    // `channel-group` is the only membership model, so a Port-channel block on
    // its own describes a bundle that cannot exist. It loses its binding rather
    // than producing a segment attached to a port the device does not have.
    const { rebuilt } = reread(`
hostname LEAF1
!
vlan 10
 name TENANT-A
!
evpn ethernet-segment ES-CE1
 identifier ${ESI}
 redundancy-mode single-active
!
interface Port-channel10
 switchport mode access
 switchport access vlan 10
 ethernet-segment ES-CE1
!
`, "l3-switch");
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.etherChannels).toEqual([]);
    expect(rebuilt.evpn?.ethernetSegments).toBeUndefined();
  });

  it("keeps the bundle binding when its members do declare it", () => {
    const { rebuilt } = reread(`
hostname LEAF1
!
vlan 10
 name TENANT-A
!
evpn ethernet-segment ES-CE1
 identifier ${ESI}
 redundancy-mode single-active
!
interface Port-channel10
 switchport mode access
 switchport access vlan 10
 ethernet-segment ES-CE1
!
interface Gi0/1
 channel-group 10 mode active
!
interface Gi0/2
 channel-group 10 mode active
!
`, "l3-switch");
    if (rebuilt?.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(rebuilt.etherChannels).toEqual([{
      channelId: 10,
      mode: "active",
      members: ["Gi0/1", "Gi0/2"],
      description: undefined,
      minimumLinks: undefined,
      switchport: { mode: "access", accessVlan: 10, nativeVlan: 1, allowedVlans: undefined },
    }]);
    expect(rebuilt.evpn?.ethernetSegments).toEqual([{
      id: "ES-CE1",
      esi: ESI,
      redundancyMode: "single-active",
      interfaces: ["Port-channel10"],
    }]);
  });
});
