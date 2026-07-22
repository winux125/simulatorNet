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
      },
    });
    expect(document.configurations.bridge).toMatchObject({ agingTimeNs: 300_000_000_000 });
    expect(document.configurations.server).toMatchObject({ enabledServices: [], dhcpClientEnabled: false });
    expect(document.configurations["l3-switch"]).toMatchObject({ ipRoutingEnabled: false, svis: [] });
  });

  it("keeps server-only grading schemas out of the browser-safe main export", () => {
    expect("GradingSpecSchema" in browserContracts).toBe(false);
    expect("VerificationRequestSchema" in browserContracts).toBe(false);
  });
});
