import type { LabDocument } from "@sim/contracts";
import {
  LabSemanticError,
  LabValidationError,
  parseLabDocument,
  UnsupportedSchemaVersionError,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

function validDocument(): LabDocument {
  return {
    schemaVersion: 1,
    id: "validation",
    title: "Validation",
    simulation: { seed: 1 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "pc1", kind: "pc", interfaces: [{ id: "eth0" }] },
        { id: "sw1", kind: "l2-switch", interfaces: [{ id: "Gi0/1" }] },
      ],
      links: [{ id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "Gi0/1" } }],
    },
    configurations: {
      pc1: { kind: "pc", interfaces: [], dhcpEnabled: false },
      sw1: { kind: "l2-switch", interfaces: [], vlans: [] },
    },
  };
}

function clone(): LabDocument {
  return JSON.parse(JSON.stringify(validDocument())) as LabDocument;
}

describe("schema and semantic validation", () => {
  it("accepts object and JSON string inputs", () => {
    expect(parseLabDocument(validDocument()).id).toBe("validation");
    expect(parseLabDocument(JSON.stringify(validDocument())).id).toBe("validation");
  });

  it("rejects an unknown node reference with path/context", () => {
    const document = clone();
    document.topology.links[0]!.a.node = "missing";
    expect(() => parseLabDocument(document)).toThrowError(expect.objectContaining({
      name: "LabSemanticError",
      code: "unknown-node",
      path: "topology.links[0].a.node",
    }));
  });

  it("rejects an unknown interface", () => {
    const document = clone();
    document.topology.links[0]!.a.iface = "eth9";
    expect(() => parseLabDocument(document)).toThrowError(expect.objectContaining({ code: "unknown-interface" }));
  });

  it("rejects duplicate node and link ids", () => {
    const duplicateNode = clone();
    duplicateNode.topology.nodes.push({ ...duplicateNode.topology.nodes[0]! });
    expect(() => parseLabDocument(duplicateNode)).toThrowError(expect.objectContaining({ code: "duplicate-id" }));

    const duplicateLink = clone();
    duplicateLink.topology.links.push({ ...duplicateLink.topology.links[0]! });
    expect(() => parseLabDocument(duplicateLink)).toThrowError(expect.objectContaining({ code: "duplicate-id" }));
  });

  it("rejects a future schema version with a typed error", () => {
    const document = { ...clone(), schemaVersion: 2 };
    expect(() => parseLabDocument(document)).toThrow(UnsupportedSchemaVersionError);
  });

  it("rejects invalid VLAN ids at the schema boundary", () => {
    const document = clone();
    document.configurations.sw1 = {
      kind: "l2-switch",
      interfaces: [],
      vlans: [{ id: 5000, name: "BAD" }],
    };
    expect(() => parseLabDocument(document)).toThrow(LabValidationError);
  });

  it("rejects an invalid subinterface parent", () => {
    const document = clone();
    document.topology.nodes.push({ id: "r1", kind: "router", interfaces: [{ id: "Gi0/0" }] });
    document.configurations.r1 = {
      kind: "router",
      interfaces: [],
      subinterfaces: [{ id: "Gi0/9.10", parentInterface: "Gi0/9", vlan: 10, native: false }],
      staticRoutes: [],
      dhcpPools: [],
    };
    expect(() => parseLabDocument(document)).toThrowError(expect.objectContaining({ code: "invalid-subinterface-parent" }));
  });

  it("rejects a device/configuration kind mismatch", () => {
    const document = clone();
    document.configurations.pc1 = { kind: "l2-switch", interfaces: [], vlans: [] };
    expect(() => parseLabDocument(document)).toThrowError(expect.objectContaining({ code: "configuration-type-mismatch" }));
  });

  it("rejects self-links and interfaces connected more than once", () => {
    const self = clone();
    self.topology.links[0]!.b = { node: "pc1", iface: "eth0" };
    expect(() => parseLabDocument(self)).toThrowError(expect.objectContaining({ code: "self-link" }));

    const repeated = clone();
    repeated.topology.nodes.push({ id: "pc2", kind: "pc", interfaces: [{ id: "eth0" }] });
    repeated.topology.links.push({ id: "l2", a: { node: "pc1", iface: "eth0" }, b: { node: "pc2", iface: "eth0" } });
    expect(() => parseLabDocument(repeated)).toThrowError(expect.objectContaining({ code: "interface-already-connected" }));
  });

  it("rejects impossible static routes and overlapping DHCP pools", () => {
    const route = clone();
    route.topology.nodes.push({ id: "r1", kind: "router", interfaces: [{ id: "Gi0/0" }] });
    route.configurations.r1 = {
      kind: "router",
      interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address: "10.0.0.1", prefixLength: 24 } }],
      subinterfaces: [],
      staticRoutes: [{ network: "172.16.0.0", prefixLength: 16, nextHop: "192.168.9.1" }],
      dhcpPools: [],
    };
    expect(() => parseLabDocument(route)).toThrowError(expect.objectContaining({ code: "unreachable-static-next-hop" }));

    const pools = clone();
    pools.topology.nodes.push({ id: "r1", kind: "router", interfaces: [{ id: "Gi0/0" }] });
    pools.configurations.r1 = {
      kind: "router",
      interfaces: [],
      subinterfaces: [],
      staticRoutes: [],
      dhcpPools: [
        { id: "a", network: "10.0.0.0", prefixLength: 24, rangeStart: "10.0.0.10", rangeEnd: "10.0.0.20", leaseSeconds: 100 },
        { id: "b", network: "10.0.0.0", prefixLength: 24, rangeStart: "10.0.0.20", rangeEnd: "10.0.0.30", leaseSeconds: 100 },
      ],
    };
    expect(() => parseLabDocument(pools)).toThrowError(expect.objectContaining({ code: "overlapping-dhcp-pools" }));
  });

  it("exports typed semantic errors", () => {
    expect(LabSemanticError.prototype).toBeInstanceOf(Error);
    expect(LabValidationError.prototype).toBeInstanceOf(Error);
  });
});
