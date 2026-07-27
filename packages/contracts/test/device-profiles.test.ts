import {
  DEVICE_CAPABILITIES,
  DEVICE_PROFILE_LIST,
  DEVICE_PROFILES,
  DEVICE_TYPES,
  DeviceTypeSchema,
  LabDocumentSchema,
  deviceTypeHasCapability,
} from "@sim/contracts";
import * as browserContracts from "@sim/contracts";
import { describe, expect, it } from "vitest";

describe("device profile registry", () => {
  it("registers exactly one profile for every DeviceType", () => {
    expect(DEVICE_PROFILE_LIST.map((profile) => profile.type)).toEqual(DEVICE_TYPES);
    expect(new Set(DEVICE_PROFILE_LIST.map((profile) => profile.type)).size).toBe(DEVICE_TYPES.length);
    for (const type of DEVICE_TYPES) {
      expect(DeviceTypeSchema.parse(type)).toBe(type);
      expect(DEVICE_PROFILES[type].type).toBe(type);
    }
  });

  it("uses unique, stable interface IDs inside every profile", () => {
    for (const profile of DEVICE_PROFILE_LIST) {
      const ids = profile.interfaceTemplates.map((template) => template.id);
      expect(new Set(ids).size, profile.type).toBe(ids.length);
      expect(ids.every((id) => id.length > 0)).toBe(true);
    }
    expect(DEVICE_PROFILES.pc.interfaceTemplates.map(({ id }) => id)).toEqual(["eth0"]);
    expect(DEVICE_PROFILES.server.interfaceTemplates.map(({ id }) => id)).toEqual(["eth0", "eth1"]);
    expect(DEVICE_PROFILES.hub.interfaceTemplates.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Eth0/${index + 1}`),
    );
    expect(DEVICE_PROFILES.bridge.interfaceTemplates.map(({ id }) => id)).toEqual(["Eth0/1", "Eth0/2"]);
    expect(DEVICE_PROFILES["l2-switch"].interfaceTemplates.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Gi0/${index + 1}`),
    );
    expect(DEVICE_PROFILES["l3-switch"].interfaceTemplates.map(({ id }) => id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Gi0/${index + 1}`),
    );
    expect(DEVICE_PROFILES.router.interfaceTemplates.map(({ id }) => id)).toEqual(["Gi0/0", "Gi0/1"]);
    expect(DEVICE_PROFILES.firewall.interfaceTemplates.map(({ id }) => id)).toEqual([
      "Eth0/0", "Eth0/1", "Eth0/2", "Eth0/3",
    ]);
    expect(DEVICE_PROFILES.cloud.interfaceTemplates).toHaveLength(4);
    expect(DEVICE_PROFILES["traffic-generator"].interfaceTemplates.map(({ id }) => id)).toEqual(["eth0"]);
    expect(DEVICE_PROFILES["access-point"].interfaceTemplates).toEqual([
      { id: "wlan0", media: "wireless" },
      { id: "eth0", media: "ethernet" },
    ]);
    expect(DEVICE_PROFILES.laptop.interfaceTemplates).toEqual([
      { id: "wlan0", media: "wireless" },
      { id: "eth0", media: "ethernet" },
    ]);
    expect(DEVICE_PROFILES.smartphone.interfaceTemplates).toEqual([
      { id: "wlan0", media: "wireless" },
    ]);
    expect(DEVICE_PROFILES["wireless-router"].interfaceTemplates.map(({ id }) => id)).toEqual([
      "wlan0", "LAN1", "LAN2", "LAN3", "LAN4", "WAN",
    ]);
  });

  it("declares capabilities deliberately for each supported type", () => {
    for (const profile of DEVICE_PROFILE_LIST) {
      expect(new Set(profile.capabilities).size).toBe(profile.capabilities.length);
      expect(profile.capabilities.every((capability) => DEVICE_CAPABILITIES.includes(capability))).toBe(true);
    }
    expect(deviceTypeHasCapability("hub", "ethernet-repeater")).toBe(true);
    expect(deviceTypeHasCapability("hub", "layer2-switching")).toBe(false);
    expect(deviceTypeHasCapability("bridge", "ethernet-bridge")).toBe(true);
    expect(deviceTypeHasCapability("l3-switch", "svi")).toBe(true);
    expect(deviceTypeHasCapability("router", "router-subinterfaces")).toBe(true);
    expect(deviceTypeHasCapability("server", "application-services")).toBe(true);
    expect(deviceTypeHasCapability("firewall", "stateful-firewall")).toBe(true);
    expect(deviceTypeHasCapability("cloud", "network-impairment")).toBe(true);
    expect(deviceTypeHasCapability("traffic-generator", "traffic-generation")).toBe(true);
    expect(deviceTypeHasCapability("access-point", "wireless-bridge")).toBe(true);
    expect(deviceTypeHasCapability("laptop", "wireless-station")).toBe(true);
    expect(deviceTypeHasCapability("smartphone", "wireless-station")).toBe(true);
    expect(deviceTypeHasCapability("wireless-router", "home-wireless-router")).toBe(true);
  });

  it("keeps M1-M9 schema-v1 documents valid and defaults stable", () => {
    const oldDocument = {
      schemaVersion: 1,
      id: "legacy",
      title: "Legacy",
      simulation: { seed: 42 },
      topology: {
        schemaVersion: 1,
        nodes: [{ id: "pc-1", kind: "pc", interfaces: [{ id: "eth0" }] }],
        links: [],
      },
      configurations: {
        "pc-1": { kind: "pc", interfaces: [], dhcpEnabled: false },
      },
    };
    const first = LabDocumentSchema.parse(oldDocument);
    const second = LabDocumentSchema.parse(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(1);
  });

  it("parses every new schema-v1 device configuration without runtime state", () => {
    const document = LabDocumentSchema.parse({
      schemaVersion: 1,
      id: "m10-contracts",
      title: "M10 contracts",
      simulation: { seed: 10 },
      topology: {
        schemaVersion: 1,
        nodes: DEVICE_PROFILE_LIST.map((profile) => ({
          id: profile.type,
          kind: profile.type,
          interfaces: profile.interfaceTemplates,
        })),
        links: [],
      },
      configurations: {
        pc: { kind: "pc" },
        server: { kind: "server" },
        hub: { kind: "hub" },
        bridge: { kind: "bridge" },
        "l2-switch": { kind: "l2-switch" },
        "l3-switch": { kind: "l3-switch" },
        router: { kind: "router" },
        firewall: { kind: "firewall" },
        cloud: { kind: "cloud" },
        "traffic-generator": { kind: "traffic-generator" },
        "access-point": {
          kind: "access-point",
          radio: { band: "2.4ghz", supportedChannels: [1, 6, 11], radioDomainId: "lab", enabled: true },
          accessPoint: {
            ssid: "Lab",
            band: "2.4ghz",
            channel: 6,
            radioDomainId: "lab",
          },
        },
        laptop: {
          kind: "laptop",
          wireless: {
            radio: { band: "2.4ghz", supportedChannels: [1, 6, 11], radioDomainId: "lab", enabled: true },
          },
        },
        smartphone: {
          kind: "smartphone",
          wireless: {
            radio: { band: "2.4ghz", supportedChannels: [1, 6, 11], radioDomainId: "lab", enabled: true },
          },
        },
        "wireless-router": {
          kind: "wireless-router",
          radio: { band: "2.4ghz", supportedChannels: [1, 6, 11], radioDomainId: "lab", enabled: true },
          accessPoint: {
            ssid: "Home",
            band: "2.4ghz",
            channel: 6,
            radioDomainId: "lab",
          },
          lan: {
            address: "192.168.50.1",
            prefixLength: 24,
            dhcpRangeStart: "192.168.50.100",
            dhcpRangeEnd: "192.168.50.150",
          },
          wan: { mode: "dhcp" },
        },
      },
    });
    expect(document.configurations.bridge).toMatchObject({ agingTimeNs: 300_000_000_000 });
    expect(document.configurations.server).toMatchObject({ enabledServices: [], dhcpClientEnabled: false });
    expect(document.configurations["l3-switch"]).toMatchObject({ ipRoutingEnabled: false, svis: [] });
    expect(document.configurations.firewall).toMatchObject({ kind: "firewall", staticRoutes: [] });
    expect(document.configurations.cloud).toMatchObject({ kind: "cloud", staticRoutes: [] });
    expect(document.configurations["traffic-generator"]).toMatchObject({
      kind: "traffic-generator",
      dhcpEnabled: false,
    });
    expect(document.configurations["access-point"]).toMatchObject({
      kind: "access-point",
      accessPoint: { security: { mode: "open" }, maximumClients: 32 },
    });
    expect(document.configurations.laptop).toMatchObject({
      kind: "laptop",
      wireless: { savedNetworks: [], autoConnect: true },
    });
    expect(document.configurations["wireless-router"]).toMatchObject({
      kind: "wireless-router",
      natEnabled: true,
      firewallEnabled: true,
    });
  });

  it("keeps server-only grading schemas out of the browser-safe main export", () => {
    expect("GradingSpecSchema" in browserContracts).toBe(false);
    expect("VerificationRequestSchema" in browserContracts).toBe(false);
  });
});
