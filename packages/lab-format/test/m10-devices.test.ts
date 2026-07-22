import type { LabDocument, LabMetadata } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "m10", title: "M10 devices" };
const host = (id: string, ip: string, gateway?: string) => ({
  node: { id, kind: "pc" as const, name: id.toUpperCase(), interfaces: [{ id: "eth0" }] },
  config: {
    kind: "pc" as const,
    hostname: id.toUpperCase(),
    interfaces: [],
    ipv4: { address: ip, prefixLength: 24, defaultGateway: gateway },
    dhcpEnabled: false,
  },
});

function document(
  nodes: LabDocument["topology"]["nodes"],
  links: LabDocument["topology"]["links"],
  configurations: LabDocument["configurations"],
): LabDocument {
  return {
    schemaVersion: 1,
    ...metadata,
    simulation: { seed: 101 },
    topology: { schemaVersion: 1, nodes, links },
    configurations,
  };
}

function rebuild(input: LabDocument) {
  const canonical = canonicalizeLabDocument(input);
  const first = buildLabFromDocument(canonical);
  const serialized = serializeLabDocument(first, metadata);
  const second = buildLabFromDocument(serialized);
  expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
  return { canonical, first, serialized, second };
}

describe("M10 device lab-format integration", () => {
  it("round-trips a hub without introducing learned state", () => {
    const a = host("a", "192.168.1.10");
    const b = host("b", "192.168.1.11");
    const lab = document(
      [a.node, b.node, { id: "hub", kind: "hub", interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] }],
      [
        { id: "a-hub", a: { node: "a", iface: "eth0" }, b: { node: "hub", iface: "Eth0/1" } },
        { id: "b-hub", a: { node: "b", iface: "eth0" }, b: { node: "hub", iface: "Eth0/2" } },
      ],
      { a: a.config, b: b.config, hub: { kind: "hub", interfaces: [] } },
    );
    const { second, serialized } = rebuild(lab);
    second.getPc("a")!.ping("192.168.1.11", 1);
    second.engine.runUntilIdle();
    expect(second.getPc("a")!.pingResults[0]).toMatchObject({ success: true });
    expect(JSON.stringify(serialized)).not.toContain("repeatedFrameCount");
  });

  it("round-trips bridge aging config and resets its runtime forwarding table", () => {
    const a = host("a", "192.168.2.10");
    const b = host("b", "192.168.2.11");
    const lab = document(
      [a.node, b.node, { id: "bridge", kind: "bridge", interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] }],
      [
        { id: "a-br", a: { node: "a", iface: "eth0" }, b: { node: "bridge", iface: "Eth0/1" } },
        { id: "b-br", a: { node: "b", iface: "eth0" }, b: { node: "bridge", iface: "Eth0/2" } },
      ],
      { a: a.config, b: b.config, bridge: { kind: "bridge", interfaces: [], agingTimeNs: 123_000_000_000 } },
    );
    const first = buildLabFromDocument(lab);
    first.getPc("a")!.ping("192.168.2.11", 1);
    first.engine.runUntilIdle();
    expect(first.getBridge("bridge")!.macAddressTable().length).toBeGreaterThan(0);
    const serialized = serializeLabDocument(first, metadata);
    const second = buildLabFromDocument(serialized);
    expect(second.getBridge("bridge")!.agingTimeNs).toBe(123_000_000_000);
    expect(second.getBridge("bridge")!.macAddressTable()).toEqual([]);
  });

  it("round-trips server host configuration and connectivity", () => {
    const client = host("client", "10.0.0.20");
    const lab = document(
      [client.node, { id: "server", kind: "server", interfaces: [{ id: "eth0" }, { id: "eth1" }] }],
      [{ id: "direct", a: { node: "client", iface: "eth0" }, b: { node: "server", iface: "eth0" } }],
      {
        client: client.config,
        server: {
          kind: "server",
          interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.0.0.10", prefixLength: 24 } }],
          defaultGateway: undefined,
          dhcpClientEnabled: false,
          enabledServices: [],
        },
      },
    );
    const { second } = rebuild(lab);
    second.getPc("client")!.ping("10.0.0.10", 1);
    second.engine.runUntilIdle();
    expect(second.getPc("client")!.pingResults[0]).toMatchObject({ success: true });
    expect(second.getServer("server")!.primary.name).toBe("eth0");
  });

  it("round-trips L3 switch SVIs, routed state, and inter-VLAN behaviour", () => {
    const a = host("a", "192.168.10.10", "192.168.10.1");
    const b = host("b", "192.168.20.10", "192.168.20.1");
    const lab = document(
      [a.node, b.node, { id: "l3", kind: "l3-switch", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/8" }] }],
      [
        { id: "a-l3", a: { node: "a", iface: "eth0" }, b: { node: "l3", iface: "Gi0/1" } },
        { id: "b-l3", a: { node: "b", iface: "eth0" }, b: { node: "l3", iface: "Gi0/2" } },
      ],
      {
        a: a.config,
        b: b.config,
        l3: {
          kind: "l3-switch",
          vlans: [{ id: 10, name: "USERS" }, { id: 20, name: "SERVERS" }],
          interfaces: [
            { id: "Gi0/1", shutdown: false, mode: "access", accessVlan: 10, nativeVlan: 1 },
            { id: "Gi0/2", shutdown: false, mode: "access", accessVlan: 20, nativeVlan: 1 },
            { id: "Gi0/8", shutdown: false, mode: "routed", ipv4: { address: "10.255.0.1", prefixLength: 30 } },
          ],
          svis: [
            { vlanId: 10, ipAddress: "192.168.10.1", prefixLength: 24, adminUp: true },
            { vlanId: 20, ipAddress: "192.168.20.1", prefixLength: 24, adminUp: true },
          ],
          staticRoutes: [],
          ipRoutingEnabled: true,
        },
      },
    );
    const { second } = rebuild(lab);
    const source = second.getPc("a")!;
    source.ping("192.168.20.10", 1);
    second.engine.runUntilIdle();
    expect(source.pingResults[0]).toMatchObject({ success: true });
    expect(second.getLayer3Switch("l3")!.isRoutedPort("Gi0/8")).toBe(true);
  });

  it("rejects invalid bridge, server, and SVI semantics with stable codes", () => {
    const base = document([], [], {});
    const invalidBridge = structuredClone(base);
    invalidBridge.topology.nodes.push({ id: "br", kind: "bridge", interfaces: [{ id: "Eth0/1" }] });
    invalidBridge.configurations.br = { kind: "bridge", interfaces: [], agingTimeNs: 100 };
    expect(() => parseLabDocument(invalidBridge)).toThrowError(expect.objectContaining({ code: "invalid-bridge-interface-count" }));

    const invalidSvi = structuredClone(base);
    invalidSvi.topology.nodes.push({ id: "l3", kind: "l3-switch", interfaces: [{ id: "Gi0/1" }] });
    invalidSvi.configurations.l3 = {
      kind: "l3-switch",
      vlans: [],
      interfaces: [],
      svis: [{ vlanId: 10, ipAddress: "10.0.0.1", prefixLength: 24, adminUp: true }],
      staticRoutes: [],
      ipRoutingEnabled: true,
    };
    expect(() => parseLabDocument(invalidSvi)).toThrowError(expect.objectContaining({ code: "unknown-svi-vlan" }));
  });
});
