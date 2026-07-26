import type { LabDocument, LabMetadata } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "m10-4", title: "M10.4 control protocols" };

function document(
  nodes: LabDocument["topology"]["nodes"],
  links: LabDocument["topology"]["links"],
  configurations: LabDocument["configurations"],
): LabDocument {
  return {
    schemaVersion: 1,
    ...metadata,
    simulation: { seed: 404 },
    topology: { schemaVersion: 1, nodes, links },
    configurations,
  };
}

function switchNode(id: string, ports = 4) {
  return {
    id,
    kind: "l2-switch" as const,
    name: id.toUpperCase(),
    interfaces: Array.from({ length: ports }, (_, index) => ({ id: `Gi0/${index + 1}` })),
  };
}

function routerNode(id: string, ports = 2) {
  return {
    id,
    kind: "router" as const,
    name: id.toUpperCase(),
    interfaces: Array.from({ length: ports }, (_, index) => ({ id: `Gi0/${index}` })),
  };
}

/** Canonicalize, build, serialize, rebuild: the document must be a fixed point. */
function roundTrip(input: LabDocument) {
  const canonical = canonicalizeLabDocument(input);
  const built = buildLabFromDocument(canonical);
  const serialized = serializeLabDocument(built, metadata);
  expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
  return { canonical, built, serialized };
}

describe("Spanning-tree configuration round trip", () => {
  it("preserves mode, timers, VLAN priorities and port configuration", () => {
    const input = document(
      [switchNode("sw1"), switchNode("sw2")],
      [
        { id: "l1", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
      ],
      {
        sw1: {
          kind: "l2-switch",
          hostname: "SW1",
          vlans: [{ id: 10, name: "DATA" }],
          interfaces: [],
          spanningTree: {
            mode: "rstp",
            helloTimeSeconds: 2,
            maxAgeSeconds: 20,
            forwardDelaySeconds: 15,
            vlans: [{ vlanId: 10, priority: 4_096 }],
            ports: [
              { interfaceId: "Gi0/2", priority: 64, portFast: false, bpduGuard: false, cost: 19 },
              { interfaceId: "Gi0/1", priority: 128, portFast: true, bpduGuard: true },
            ],
          },
          etherChannels: [],
          discovery: {},
        },
        sw2: { kind: "l2-switch", hostname: "SW2", vlans: [], interfaces: [] },
      } as unknown as LabDocument["configurations"],
    );

    const { canonical, serialized } = roundTrip(input);
    const sw1 = serialized.configurations.sw1!;
    if (sw1.kind !== "l2-switch") throw new Error("expected an L2 switch");
    expect(sw1.spanningTree.mode).toBe("rstp");
    expect(sw1.spanningTree.vlans).toEqual([{ vlanId: 10, priority: 4_096 }]);
    // Canonical order: ports sorted by interface id, not by insertion order.
    expect(sw1.spanningTree.ports.map((port) => port.interfaceId)).toEqual(["Gi0/1", "Gi0/2"]);
    expect(sw1.spanningTree.ports[0]).toMatchObject({ portFast: true, bpduGuard: true });
    expect(sw1.spanningTree.ports[1]).toMatchObject({ cost: 19, priority: 64 });
    const canonicalSw1 = canonical.configurations.sw1!;
    if (canonicalSw1.kind !== "l2-switch") throw new Error("expected an L2 switch");
    expect(canonicalSw1.spanningTree.ports.map((port) => port.interfaceId)).toEqual(["Gi0/1", "Gi0/2"]);
  });

  it("never persists elected roots, port roles or error-disabled state", () => {
    const input = document(
      [switchNode("sw1"), switchNode("sw2")],
      [{ id: "l1", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } }],
      {
        sw1: {
          kind: "l2-switch",
          hostname: "SW1",
          vlans: [],
          interfaces: [],
          spanningTree: { mode: "stp" },
        },
        sw2: {
          kind: "l2-switch",
          hostname: "SW2",
          vlans: [],
          interfaces: [],
          spanningTree: { mode: "stp", ports: [{ interfaceId: "Gi0/1", portFast: true, bpduGuard: true }] },
        },
      } as unknown as LabDocument["configurations"],
    );

    const { built } = roundTrip(input);
    built.engine.runUntilIdle();
    const sw2 = built.getSwitch("sw2")!;
    expect(sw2.spanningTree.isErrorDisabled("Gi0/1")).toBe(true);

    const afterRun = serializeLabDocument(built, metadata);
    const text = stringifyLabDocument(afterRun);
    for (const runtimeField of ["rootId", "designated", "alternate", "errorDisabled", "forwarding", "blocking"]) {
      expect(text).not.toContain(runtimeField);
    }
  });
});

describe("EtherChannel configuration round trip", () => {
  it("preserves channels, members and the Port-channel switchport", () => {
    const input = document(
      [switchNode("sw1"), switchNode("sw2")],
      [
        { id: "l1", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "sw2", iface: "Gi0/1" } },
        { id: "l2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "sw2", iface: "Gi0/2" } },
      ],
      {
        sw1: {
          kind: "l2-switch",
          hostname: "SW1",
          vlans: [{ id: 10, name: "DATA" }, { id: 20, name: "VOICE" }],
          interfaces: [],
          etherChannels: [{
            channelId: 1,
            mode: "active",
            members: ["Gi0/2", "Gi0/1"],
            switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [20, 10] },
          }],
        },
        sw2: {
          kind: "l2-switch",
          hostname: "SW2",
          vlans: [{ id: 10, name: "DATA" }, { id: 20, name: "VOICE" }],
          interfaces: [],
          etherChannels: [{
            channelId: 1,
            mode: "passive",
            members: ["Gi0/1", "Gi0/2"],
            switchport: { mode: "trunk", accessVlan: 1, nativeVlan: 1, allowedVlans: [10, 20] },
          }],
        },
      } as unknown as LabDocument["configurations"],
    );

    const { serialized, built } = roundTrip(input);
    const sw1 = serialized.configurations.sw1!;
    if (sw1.kind !== "l2-switch") throw new Error("expected an L2 switch");
    expect(sw1.etherChannels).toHaveLength(1);
    // Members and allowed VLANs are canonically ordered.
    expect(sw1.etherChannels[0]!.members).toEqual(["Gi0/1", "Gi0/2"]);
    expect(sw1.etherChannels[0]!.switchport?.allowedVlans).toEqual([10, 20]);

    built.engine.runUntilIdle();
    expect(built.getSwitch("sw1")!.etherChannelSummaries()[0]!.status).toBe("up");
    const text = stringifyLabDocument(serializeLabDocument(built, metadata));
    for (const runtimeField of ["distributing", "partnerSystemId", "selectedFrames"]) {
      expect(text).not.toContain(runtimeField);
    }
  });
});

describe("Discovery configuration round trip", () => {
  it("preserves global and per-interface discovery settings", () => {
    const input = document(
      [switchNode("sw1"), routerNode("r1")],
      [{ id: "l1", a: { node: "sw1", iface: "Gi0/1" }, b: { node: "r1", iface: "Gi0/0" } }],
      {
        sw1: {
          kind: "l2-switch",
          hostname: "SW1",
          vlans: [],
          interfaces: [],
          discovery: {
            cdpEnabled: true,
            lldpEnabled: true,
            cdpIntervalSeconds: 30,
            cdpHoldTimeSeconds: 90,
            interfaces: [
              { interfaceId: "Gi0/3", cdpEnabled: false, lldpTransmit: true, lldpReceive: true },
              { interfaceId: "Gi0/2", cdpEnabled: true, lldpTransmit: false, lldpReceive: true },
            ],
          },
        },
        r1: {
          kind: "router",
          hostname: "R1",
          interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.0.1", prefixLength: 24 } }],
          discovery: { cdpEnabled: true },
        },
      } as unknown as LabDocument["configurations"],
    );

    const { serialized, built } = roundTrip(input);
    const sw1 = serialized.configurations.sw1!;
    if (sw1.kind !== "l2-switch") throw new Error("expected an L2 switch");
    expect(sw1.discovery).toMatchObject({ cdpEnabled: true, lldpEnabled: true, cdpIntervalSeconds: 30 });
    expect(sw1.discovery.interfaces.map((iface) => iface.interfaceId)).toEqual(["Gi0/2", "Gi0/3"]);

    built.engine.runUntilIdle();
    expect(built.getSwitch("sw1")!.discovery.neighborTable().length).toBeGreaterThan(0);
    const text = stringifyLabDocument(serializeLabDocument(built, metadata));
    expect(text).not.toContain("lastSeenNs");
    expect(text).not.toContain("expiresAtNs");
  });
});

describe("Loopback and OSPF configuration round trip", () => {
  it("preserves loopbacks, the process and the interface configuration", () => {
    const input = document(
      [routerNode("r1"), routerNode("r2")],
      [{ id: "l1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }],
      {
        r1: {
          kind: "router",
          hostname: "R1",
          interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.12.1", prefixLength: 24 } }],
          loopbacks: [
            { id: 1, shutdown: false, ipv4: { address: "1.1.1.2", prefixLength: 32 } },
            { id: 0, shutdown: false, ipv4: { address: "1.1.1.1", prefixLength: 32 } },
          ],
          ospf: {
            processId: 1,
            routerId: "1.1.1.1",
            networks: [
              { network: "10.0.12.0", wildcard: "0.0.0.255", area: 0 },
              { network: "1.1.1.0", wildcard: "0.0.0.255", area: 0 },
            ],
            passiveInterfaces: ["Loopback1", "Loopback0"],
            interfaces: [{ interfaceId: "Gi0/0", cost: 25, networkType: "point-to-point" }],
          },
        },
        r2: {
          kind: "router",
          hostname: "R2",
          interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.12.2", prefixLength: 24 } }],
          loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "2.2.2.2", prefixLength: 32 } }],
          ospf: {
            processId: 1,
            routerId: "2.2.2.2",
            networks: [{ network: "0.0.0.0", wildcard: "255.255.255.255", area: 0 }],
            passiveInterfaces: ["Loopback0"],
            interfaces: [{ interfaceId: "Gi0/0", cost: 25, networkType: "point-to-point" }],
          },
        },
      } as unknown as LabDocument["configurations"],
    );

    const { serialized, built } = roundTrip(input);
    const r1 = serialized.configurations.r1!;
    if (r1.kind !== "router") throw new Error("expected a router");
    // Loopbacks by numeric id, networks by address, passive interfaces sorted.
    expect(r1.loopbacks.map((loopback) => loopback.id)).toEqual([0, 1]);
    expect(r1.ospf?.networks.map((statement) => statement.network)).toEqual(["1.1.1.0", "10.0.12.0"]);
    expect(r1.ospf?.passiveInterfaces).toEqual(["Loopback0", "Loopback1"]);
    expect(r1.ospf?.interfaces[0]).toMatchObject({ interfaceId: "Gi0/0", cost: 25 });

    built.engine.runUntilIdle();
    const router1 = built.getRouter("r1")!;
    expect(router1.ospf.neighborSummaries()[0]).toMatchObject({ neighborRouterId: "2.2.2.2", state: "full" });
    expect(router1.routingTable().some((route) => route.kind === "ospf" && route.network === "2.2.2.2")).toBe(true);

    const text = stringifyLabDocument(serializeLabDocument(built, metadata));
    for (const runtimeField of ["\"full\"", "designatedRouter", "checksum", "linkStateId", "spfRuns"]) {
      expect(text).not.toContain(runtimeField);
    }
  });
});

describe("Semantic validation of control protocols", () => {
  const base = (configuration: Record<string, unknown>): LabDocument => document(
    [switchNode("sw1")],
    [],
    { sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [], ...configuration } } as unknown as
      LabDocument["configurations"],
  );

  it("rejects a spanning-tree VLAN that does not exist", () => {
    expect(() => canonicalizeLabDocument(base({
      spanningTree: { mode: "stp", vlans: [{ vlanId: 99, priority: 4_096 }] },
    }))).toThrowError(/undefined VLAN 99/);
  });

  it("rejects BPDU Guard without PortFast", () => {
    expect(() => canonicalizeLabDocument(base({
      spanningTree: { mode: "stp", ports: [{ interfaceId: "Gi0/1", bpduGuard: true }] },
    }))).toThrowError(/enable PortFast/);
  });

  it("rejects a channel member that belongs to another channel", () => {
    expect(() => canonicalizeLabDocument(base({
      etherChannels: [
        { channelId: 1, mode: "on", members: ["Gi0/1"] },
        { channelId: 2, mode: "on", members: ["Gi0/1"] },
      ],
    }))).toThrowError(/already belongs to Port-channel1/);
  });

  it("rejects an unknown channel member and an impossible minimum-links", () => {
    expect(() => canonicalizeLabDocument(base({
      etherChannels: [{ channelId: 1, mode: "on", members: ["Gi9/9"] }],
    }))).toThrowError(/Unknown interface 'Gi9\/9'/);
    expect(() => canonicalizeLabDocument(base({
      etherChannels: [{ channelId: 1, mode: "on", members: ["Gi0/1"], minimumLinks: 4 }],
    }))).toThrowError(/cannot exceed the number of members/);
  });

  it("rejects discovery on an unknown interface and an invalid hold time", () => {
    expect(() => canonicalizeLabDocument(base({
      discovery: { cdpEnabled: true, interfaces: [{ interfaceId: "Gi9/9" }] },
    }))).toThrowError(/Unknown interface 'Gi9\/9'/);
    expect(() => canonicalizeLabDocument(base({
      discovery: { cdpEnabled: true, cdpIntervalSeconds: 60, cdpHoldTimeSeconds: 30 },
    }))).toThrowError(/hold time must exceed the interval/);
  });

  it("rejects CDP on a vendor-neutral server", () => {
    const input = document(
      [{ id: "srv1", kind: "server", name: "SRV1", interfaces: [{ id: "eth0" }] }],
      [],
      {
        srv1: {
          kind: "server",
          hostname: "SRV1",
          interfaces: [],
          enabledServices: [],
          discovery: { cdpEnabled: true },
        },
      } as unknown as LabDocument["configurations"],
    );
    expect(() => canonicalizeLabDocument(input)).toThrowError(/does not speak CDP/);
  });

  it("rejects a non-zero OSPF area and a non-contiguous wildcard", () => {
    const withOspf = (ospf: Record<string, unknown>): LabDocument => document(
      [routerNode("r1")],
      [],
      {
        r1: {
          kind: "router",
          hostname: "R1",
          interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.0.1", prefixLength: 24 } }],
          ospf: { processId: 1, ...ospf },
        },
      } as unknown as LabDocument["configurations"],
    );
    expect(() => canonicalizeLabDocument(withOspf({
      networks: [{ network: "10.0.0.0", wildcard: "0.0.0.255", area: 1 }],
    }))).toThrowError();
    expect(() => canonicalizeLabDocument(withOspf({
      networks: [{ network: "10.0.0.0", wildcard: "0.1.0.255", area: 0 }],
    }))).toThrowError(/not a contiguous wildcard mask/);
    expect(() => canonicalizeLabDocument(withOspf({
      networks: [],
      passiveInterfaces: ["Loopback9"],
    }))).toThrowError(/Unknown L3 interface 'Loopback9'/);
  });

  it("keeps an M10.3 document without any protocol configuration valid", () => {
    const legacy = document(
      [switchNode("sw1")],
      [],
      { sw1: { kind: "l2-switch", hostname: "SW1", vlans: [], interfaces: [] } } as unknown as
        LabDocument["configurations"],
    );
    const canonical = canonicalizeLabDocument(legacy);
    const sw1 = canonical.configurations.sw1!;
    if (sw1.kind !== "l2-switch") throw new Error("expected an L2 switch");
    expect(sw1.spanningTree.mode).toBe("disabled");
    expect(sw1.etherChannels).toEqual([]);
    expect(sw1.discovery.cdpEnabled).toBe(false);
  });
});
