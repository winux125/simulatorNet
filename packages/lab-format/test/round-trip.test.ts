import type { LabDocument, LabMetadata } from "@sim/contracts";
import { createCliSession } from "@sim/cli-engine";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "lab-1", title: "Round trip lab", description: "M4 fixture" };

function documentOf(
  nodes: LabDocument["topology"]["nodes"],
  links: LabDocument["topology"]["links"],
  configurations: LabDocument["configurations"],
  seed = 7,
): LabDocument {
  return {
    schemaVersion: 1,
    ...metadata,
    simulation: { seed },
    topology: { schemaVersion: 1, nodes, links },
    configurations,
  };
}

function pc(id: string, name: string, ip?: string, gateway?: string) {
  return {
    node: { id, kind: "pc" as const, name, interfaces: [{ id: "eth0" }] },
    config: {
      kind: "pc" as const,
      hostname: name,
      interfaces: [],
      ipv4: ip ? { address: ip, prefixLength: 24, defaultGateway: gateway } : undefined,
      dhcpEnabled: false,
    },
  };
}

function roundTrip(document: LabDocument) {
  const canonical = canonicalizeLabDocument(document);
  const first = buildLabFromDocument(canonical);
  const serialized = serializeLabDocument(first, metadata);
  const second = buildLabFromDocument(serialized);
  expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
  return { canonical, first, serialized, second };
}

describe("lab-format data-plane round trips", () => {
  it("rebuilds a basic PC-switch-PC lab with identical canonical JSON", () => {
    const pc1 = pc("pc1", "PC1", "192.168.1.10");
    const pc2 = pc("pc2", "PC2", "192.168.1.11");
    const document = documentOf(
      [
        pc2.node,
        { id: "sw1", kind: "l2-switch", name: "SW1", position: { x: 100, y: 20 }, interfaces: [{ id: "Gi0/2" }, { id: "Gi0/1" }] },
        pc1.node,
      ],
      [
        { id: "link-2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "pc2", iface: "eth0" } },
        { id: "link-1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
      ],
      {
        pc1: pc1.config,
        pc2: pc2.config,
        sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
      },
    );

    const { first, second } = roundTrip(document);
    for (const [built, sequence] of [[first, 1], [second, 2]] as const) {
      const source = built.getPc("pc1")!;
      source.ping("192.168.1.11", sequence);
      built.engine.runUntilIdle();
      expect(source.pingResults.at(-1)).toMatchObject({ sequence, success: true });
    }
  });

  it("preserves access VLANs, trunk scope, native VLAN and isolation", () => {
    const pc1 = pc("pc1", "PC1", "192.168.10.11");
    const pc2 = pc("pc2", "PC2", "192.168.10.12");
    const pc3 = pc("pc3", "PC3", "192.168.10.13");
    const switchConfig = (hostname: string, access: Array<[string, number]>) => ({
      kind: "l2-switch" as const,
      hostname,
      vlans: [{ id: 10, name: "USERS" }, { id: 20, name: "GUESTS" }, { id: 99, name: "NATIVE" }],
      interfaces: [
        ...access.map(([id, accessVlan]) => ({ id, mode: "access" as const, accessVlan, nativeVlan: 1, shutdown: false })),
        { id: "Gi0/24", mode: "trunk" as const, accessVlan: 1, nativeVlan: 99, allowedVlans: [20, 10, 99], shutdown: false },
      ],
    });
    const document = documentOf(
      [
        pc1.node,
        pc2.node,
        pc3.node,
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/24" }] },
        { id: "sw2", kind: "l2-switch", name: "SW2", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/24" }] },
      ],
      [
        { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/24" }, b: { node: "sw2", iface: "Gi0/24" } },
        { id: "l3", a: { node: "sw2", iface: "Gi0/1" }, b: { node: "pc2", iface: "eth0" } },
        { id: "l4", a: { node: "sw2", iface: "Gi0/2" }, b: { node: "pc3", iface: "eth0" } },
      ],
      {
        pc1: pc1.config,
        pc2: pc2.config,
        pc3: pc3.config,
        sw1: switchConfig("SW1", [["Gi0/1", 10]]),
        sw2: switchConfig("SW2", [["Gi0/1", 10], ["Gi0/2", 20]]),
      },
    );

    const { second } = roundTrip(document);
    expect(second.getSwitch("sw1")!.trunkSummary()[0]).toEqual({ port: "Gi0/24", nativeVlan: 99, allowedVlans: [10, 20, 99] });
    const source = second.getPc("pc1")!;
    source.ping("192.168.10.12", 1);
    source.ping("192.168.10.13", 2);
    second.engine.runUntilIdle();
    expect(source.pingResults).toEqual([
      expect.objectContaining({ sequence: 1, success: true }),
      expect.objectContaining({ sequence: 2, success: false }),
    ]);
  });

  it("preserves router-on-a-stick inter-VLAN routing", () => {
    const document = routerOnAStickDocument();
    const { first, second } = roundTrip(document);
    for (const [built, sequence] of [[first, 1], [second, 2]] as const) {
      const source = built.getPc("pc1")!;
      source.ping("192.168.20.10", sequence);
      built.engine.runUntilIdle();
      expect(source.pingResults.at(-1)).toMatchObject({ sequence, success: true });
    }
    expect(second.getRouter("r1")!.interfaceSummaries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Gi0/0.10", vlan: 10, ip: "192.168.10.1" }),
      expect.objectContaining({ name: "Gi0/0.20", vlan: 20, ip: "192.168.20.1" }),
    ]));
  });

  it("reruns deterministic DHCP DORA without persisting old leases", () => {
    const client = pc("pc1", "PC1");
    client.config.dhcpEnabled = true;
    const document = documentOf(
      [
        client.node,
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      ],
      [{ id: "cable", a: { node: "pc1", iface: "eth0" }, b: { node: "r1", iface: "Gi0/0" } }],
      {
        pc1: client.config,
        r1: {
          kind: "router",
          hostname: "R1",
          interfaces: [{ id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "192.168.1.1", prefixLength: 24 } }],
          subinterfaces: [],
          staticRoutes: [],
          dhcpPools: [{
            id: "LAN",
            network: "192.168.1.0",
            prefixLength: 24,
            defaultGateway: "192.168.1.1",
            rangeStart: "192.168.1.10",
            rangeEnd: "192.168.1.20",
            leaseSeconds: 3600,
          }],
        },
      },
      123,
    );

    const first = buildLabFromDocument(document);
    first.getPc("pc1")!.requestDhcp();
    first.engine.runUntilIdle();
    expect(first.getPc("pc1")!.lease?.ip).toBe("192.168.1.10");

    const serialized = serializeLabDocument(first, metadata);
    expect(JSON.stringify(serialized)).not.toContain("leases");
    expect(serialized.configurations.pc1).toMatchObject({ kind: "pc", dhcpEnabled: true, ipv4: undefined });
    const second = buildLabFromDocument(serialized);
    expect(second.getPc("pc1")!.ip).toBeUndefined();
    second.getPc("pc1")!.requestDhcp();
    second.engine.runUntilIdle();
    expect(second.getPc("pc1")!.lease?.ip).toBe("192.168.1.10");
    expect(stringifyLabDocument(serializeLabDocument(second, metadata))).toBe(stringifyLabDocument(serialized));
  });

  it("preserves IPv6 host configuration but rebuilds NDP runtime state", () => {
    const firstPc = pc("pc1", "PC1");
    const secondPc = pc("pc2", "PC2");
    const firstPcConfig = { ...firstPc.config, ipv6: { mode: "static" as const, address: "2001:db8:10::10", prefixLength: 64 } };
    const secondPcConfig = { ...secondPc.config, ipv6: { mode: "static" as const, address: "2001:db8:10::20", prefixLength: 64 } };
    const document = documentOf(
      [
        firstPc.node,
        secondPc.node,
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
      ],
      [
        { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "pc2", iface: "eth0" } },
      ],
      {
        pc1: firstPcConfig,
        pc2: secondPcConfig,
        sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] },
      },
    );
    const { first, serialized, second } = roundTrip(document);
    first.engine.runUntilIdle();
    first.getPc("pc1")!.ping6("2001:db8:10::20", 1);
    first.engine.runUntilIdle();
    expect(first.getPc("pc1")!.ipv6PingResults.at(-1)).toMatchObject({ success: true });
    expect(JSON.stringify(serialized)).not.toMatch(/neighborCache|dadState|dhcpv6Lease/i);
    expect(second.getPc("pc1")!.ipv6NeighborEntries()).toEqual([]);
    second.engine.runUntilIdle();
    second.getPc("pc1")!.ping6("2001:db8:10::20", 2);
    second.engine.runUntilIdle();
    expect(second.getPc("pc1")!.ipv6PingResults.at(-1)).toMatchObject({ success: true });
  });
});

describe("CLI-created structured configuration", () => {
  it("serializes public sim-core state and rebuilds without replaying commands", () => {
    const document = routerOnAStickDocument(false);
    const built = buildLabFromDocument(document);
    const swCli = createCliSession(built.getSwitch("sw1")!, built.engine);
    for (const line of [
      "enable", "configure terminal", "hostname EDGE-SW", "vlan 10", "name USERS", "exit",
      "vlan 20", "name SERVERS", "exit", "interface Gi0/1", "description user access",
      "switchport mode access", "switchport access vlan 10", "exit", "interface Gi0/2",
      "switchport mode access", "switchport access vlan 20", "exit", "interface Gi0/24",
      "switchport mode trunk", "switchport trunk allowed vlan 10,20", "end",
    ]) swCli.execute(line);
    const routerCli = createCliSession(built.getRouter("r1")!, built.engine);
    for (const line of [
      "enable", "configure terminal", "hostname EDGE-R", "interface Gi0/0.10", "encapsulation dot1Q 10",
      "ip address 192.168.10.1 255.255.255.0", "exit", "interface Gi0/0.20", "encapsulation dot1Q 20",
      "ip address 192.168.20.1 255.255.255.0", "exit",
      "ip route 172.16.0.0 255.255.0.0 192.168.10.2", "end",
    ]) routerCli.execute(line);

    const source = built.getPc("pc1")!;
    source.ping("192.168.20.10", 1);
    built.engine.runUntilIdle();
    expect(source.pingResults.at(-1)).toMatchObject({ success: true });
    const beforeSwitch = swCli.execute("show running-config");
    const beforeRouter = routerCli.execute("show running-config");

    const serialized = serializeLabDocument(built, metadata);
    expect(JSON.stringify(serialized)).not.toContain("runningConfig");
    const rebuilt = buildLabFromDocument(serialized);
    expect(createCliSession(rebuilt.getSwitch("sw1")!, rebuilt.engine).execute("show running-config")).toBe(beforeSwitch);
    expect(createCliSession(rebuilt.getRouter("r1")!, rebuilt.engine).execute("show running-config")).toBe(beforeRouter);
    rebuilt.getPc("pc1")!.ping("192.168.20.10", 2);
    rebuilt.engine.runUntilIdle();
    expect(rebuilt.getPc("pc1")!.pingResults.at(-1)).toMatchObject({ success: true });
  });

  it("round-trips CLI-created IPv6 routing, OSPFv3 and ACL configuration", () => {
    const document = documentOf(
      [{ id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] }],
      [],
      {
        r1: {
          kind: "router",
          hostname: "R1",
          interfaces: [{ id: "Gi0/0", routed: true, shutdown: false }],
          subinterfaces: [],
          staticRoutes: [],
          dhcpPools: [],
        },
      },
    );
    const built = buildLabFromDocument(document);
    const cli = createCliSession(built.getRouter("r1")!, built.engine);
    for (const command of [
      "enable",
      "configure terminal",
      "ipv6 unicast-routing",
      "interface Gi0/0",
      "ipv6 address 2001:db8:10::1/64",
      "ipv6 ospf 1 area 0",
      "ipv6 ospf cost 10",
      "exit",
      "ipv6 route 2001:db8:20::/64 2001:db8:10::2",
      "ipv6 router ospf 1",
      "router-id 1.1.1.1",
      "exit",
      "ipv6 access-list WEB6",
      "permit tcp 2001:db8:10::/64 host 2001:db8:20::10 eq 80",
      "deny ipv6 any any",
      "exit",
      "interface Gi0/0",
      "ipv6 traffic-filter WEB6 in",
      "end",
    ]) expect(cli.execute(command)).not.toContain("% Invalid");

    const serialized = serializeLabDocument(built, metadata);
    expect(serialized.configurations.r1).toMatchObject({
      kind: "router",
      ipv6UnicastRoutingEnabled: true,
      interfaces: [expect.objectContaining({
        id: "Gi0/0",
        ipv6: [{ address: "2001:db8:10::1", prefixLength: 64 }],
      })],
      ipv6StaticRoutes: [{
        network: "2001:db8:20::",
        prefixLength: 64,
        nextHop: "2001:db8:10::2",
      }],
      ospfv3: expect.objectContaining({ processId: 1, routerId: "1.1.1.1" }),
      ipv6Acls: [expect.objectContaining({ id: "WEB6", rules: expect.any(Array) })],
      ipv6AclBindings: [{ interfaceName: "Gi0/0", direction: "in", aclId: "WEB6" }],
    });
    const rebuilt = buildLabFromDocument(serialized).getRouter("r1")!;
    expect(rebuilt.ipv6StaticRouteConfigurations()).toEqual([{
      network: "2001:db8:20::",
      prefixLength: 64,
      nextHop: "2001:db8:10::2",
    }]);
    expect(rebuilt.ospfv3.configuration()).toMatchObject({ processId: 1, routerId: "1.1.1.1" });
    expect(rebuilt.ipv6AclConfigurations()[0]?.rules).toHaveLength(2);
  });
});

describe("deterministic rebuild", () => {
  it("produces an identical golden trace from the same canonical document", () => {
    const document = canonicalizeLabDocument(routerOnAStickDocument());
    const run = () => {
      const built = buildLabFromDocument(document);
      built.engine.enableTrace();
      built.getPc("pc1")!.ping("192.168.20.10", 77);
      built.engine.runUntilIdle();
      return built.engine.traceLog;
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(first.some((entry) => entry.type === "ping-success")).toBe(true);
  });
});

function routerOnAStickDocument(configured = true): LabDocument {
  const pc1 = pc("pc1", "PC1", "192.168.10.10", "192.168.10.1");
  const pc2 = pc("pc2", "PC2", "192.168.20.10", "192.168.20.1");
  return documentOf(
    [
      pc1.node,
      pc2.node,
      { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/24" }] },
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
    ],
    [
      { id: "a", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } },
      { id: "b", a: { node: "pc2", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/2" } },
      { id: "c", a: { node: "sw1", iface: "Gi0/24" }, b: { node: "r1", iface: "Gi0/0" } },
    ],
    {
      pc1: pc1.config,
      pc2: pc2.config,
      sw1: {
        kind: "l2-switch",
        hostname: "SW1",
        vlans: configured ? [{ id: 10, name: "USERS" }, { id: 20, name: "SERVERS" }] : [],
        interfaces: configured ? [
          { id: "Gi0/1", mode: "access", accessVlan: 10, nativeVlan: 1, shutdown: false },
          { id: "Gi0/2", mode: "access", accessVlan: 20, nativeVlan: 1, shutdown: false },
          { id: "Gi0/24", mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20], shutdown: false },
        ] : [],
      },
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [],
        subinterfaces: configured ? [
          { id: "Gi0/0.10", parentInterface: "Gi0/0", vlan: 10, native: false, ipv4: { address: "192.168.10.1", prefixLength: 24 } },
          { id: "Gi0/0.20", parentInterface: "Gi0/0", vlan: 20, native: false, ipv4: { address: "192.168.20.1", prefixLength: 24 } },
        ] : [],
        staticRoutes: [],
        dhcpPools: [],
      },
    },
    55,
  );
}
