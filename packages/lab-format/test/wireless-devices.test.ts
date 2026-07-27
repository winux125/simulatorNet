import { LabDocumentSchema, type LabMetadata } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "wireless", title: "Wireless devices" };

describe("wireless device lab-format integration", () => {
  it("builds and round-trips a WLAN without persisting runtime association", () => {
    const canonical = canonicalizeLabDocument(LabDocumentSchema.parse({
      schemaVersion: 1,
      ...metadata,
      simulation: { seed: 106 },
      topology: {
        schemaVersion: 1,
        nodes: [
          {
            id: "ap",
            kind: "access-point",
            name: "AP1",
            interfaces: [{ id: "wlan0" }, { id: "eth0" }],
          },
          {
            id: "laptop",
            kind: "laptop",
            name: "LAP1",
            interfaces: [{ id: "wlan0" }, { id: "eth0" }],
          },
          {
            id: "server",
            kind: "server",
            name: "SERVER",
            interfaces: [{ id: "eth0" }],
          },
        ],
        links: [{
          id: "ap-server",
          a: { node: "ap", iface: "eth0" },
          b: { node: "server", iface: "eth0" },
        }],
      },
      configurations: {
        ap: {
          kind: "access-point",
          radio: {
            enabled: true,
            band: "2.4ghz",
            supportedChannels: [1, 6, 11],
            radioDomainId: "lab",
          },
          accessPoint: {
            ssid: "Lab WLAN",
            band: "2.4ghz",
            channel: 6,
            radioDomainId: "lab",
          },
        },
        laptop: {
          kind: "laptop",
          ipv4: { address: "192.168.60.10", prefixLength: 24 },
          wireless: {
            radio: {
              enabled: true,
              band: "2.4ghz",
              supportedChannels: [1, 6, 11],
              radioDomainId: "lab",
            },
            preferredSsid: "Lab WLAN",
          },
        },
        server: {
          kind: "server",
          interfaces: [{
            id: "eth0",
            ipv4: { address: "192.168.60.20", prefixLength: 24 },
          }],
        },
      },
    }));
    const built = buildLabFromDocument(canonical);
    const laptop = built.getLaptop("laptop")!;
    laptop.connectWireless();
    built.engine.runUntilIdle();
    laptop.ping("192.168.60.20", 1);
    built.engine.runUntilIdle();

    const serialized = serializeLabDocument(built, metadata);

    expect(laptop.pingResults.at(-1)).toMatchObject({ success: true });
    expect(built.getAccessPoint("ap")?.associatedClients()).toHaveLength(1);
    expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
    expect(JSON.stringify(serialized)).not.toMatch(/associatedAtNs|scanResults|wireless-associated/);
  });

  it("keeps home-router internal components out of the domain document", () => {
    const canonical = canonicalizeLabDocument(LabDocumentSchema.parse({
      schemaVersion: 1,
      id: "home-router",
      title: "Home router",
      simulation: { seed: 106 },
      topology: {
        schemaVersion: 1,
        nodes: [{
          id: "wrt",
          kind: "wireless-router",
          interfaces: [
            { id: "wlan0" },
            { id: "LAN1" },
            { id: "LAN2" },
            { id: "LAN3" },
            { id: "LAN4" },
            { id: "WAN" },
          ],
        }],
        links: [],
      },
      configurations: {
        wrt: {
          kind: "wireless-router",
          radio: {
            enabled: true,
            band: "2.4ghz",
            supportedChannels: [1, 6, 11],
            radioDomainId: "home",
          },
          accessPoint: {
            ssid: "Home",
            band: "2.4ghz",
            channel: 6,
            radioDomainId: "home",
          },
          lan: {
            address: "192.168.50.1",
            prefixLength: 24,
            dhcpRangeStart: "192.168.50.100",
            dhcpRangeEnd: "192.168.50.150",
          },
          wan: {
            mode: "static",
            address: "203.0.113.2",
            prefixLength: 24,
            defaultGateway: "203.0.113.1",
          },
        },
      },
    }));
    const built = buildLabFromDocument(canonical);
    const serialized = serializeLabDocument(built, {
      id: canonical.id,
      title: canonical.title,
    });

    expect(built.getWirelessRouter("wrt")).toBeDefined();
    expect(built.engine.devices.size).toBeGreaterThan(1);
    expect(serialized.topology.nodes).toHaveLength(1);
    expect(serialized.configurations.wrt?.kind).toBe("wireless-router");
    expect(JSON.stringify(serialized)).not.toContain("__wireless-router:");
  });

  it("rejects a physical cable attached to wlan0", () => {
    expect(() => canonicalizeLabDocument(LabDocumentSchema.parse({
      schemaVersion: 1,
      id: "invalid-wireless-cable",
      title: "Invalid wireless cable",
      simulation: { seed: 106 },
      topology: {
        schemaVersion: 1,
        nodes: [
          { id: "laptop", kind: "laptop", interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
          { id: "pc", kind: "pc", interfaces: [{ id: "eth0" }] },
        ],
        links: [{
          id: "bad",
          a: { node: "laptop", iface: "wlan0" },
          b: { node: "pc", iface: "eth0" },
        }],
      },
      configurations: {
        laptop: {
          kind: "laptop",
          wireless: {
            radio: {
              enabled: true,
              band: "2.4ghz",
              supportedChannels: [1, 6, 11],
              radioDomainId: "lab",
            },
          },
        },
        pc: { kind: "pc" },
      },
    }))).toThrow(/connects through its radio configuration/);
  });
});
