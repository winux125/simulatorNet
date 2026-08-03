import type { LabDocument } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  validateLabSemantics,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const document: LabDocument = {
  schemaVersion: 1,
  id: "mpls-persistence",
  title: "MPLS persistence",
  simulation: { seed: 10_111 },
  topology: {
    schemaVersion: 1,
    nodes: [{ id: "pe1", kind: "router", name: "PE1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] }],
    links: [],
  },
  configurations: {
    pe1: {
      kind: "router",
      hostname: "PE1",
      interfaces: [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "192.0.2.1", prefixLength: 30 }, mplsEnabled: true },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "10.1.1.1", prefixLength: 24 }, vrfId: "blue" },
      ],
      subinterfaces: [],
      loopbacks: [{ id: 0, shutdown: false, ipv4: { address: "1.1.1.1", prefixLength: 32 } }],
      staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
      ldp: { routerIdInterface: "Loopback0" },
      vrfs: [{
        id: "blue", name: "BLUE", routeDistinguisher: "65000:100",
        importRouteTargets: ["65000:100"], exportRouteTargets: ["65000:100"],
        staticRoutes: [{ network: "10.2.0.0", prefixLength: 24, nextHop: "10.1.1.2" }],
      }],
      bgp: {
        localAs: 65_000, routerId: "1.1.1.1", neighbors: [], networks: [],
        vrfAddressFamilies: [{ vrfId: "blue", redistributeConnected: true, redistributeStatic: true }],
      },
    },
  },
};

describe("MPLS and L3VPN LabDocument persistence", () => {
  it("round-trips MPLS interfaces, LDP, VRFs and VPNv4 address families", () => {
    const canonical = canonicalizeLabDocument(document);
    const serialized = serializeLabDocument(buildLabFromDocument(canonical), canonical);
    expect(serialized.configurations.pe1).toMatchObject({
      kind: "router",
      ldp: { routerIdInterface: "Loopback0" },
      interfaces: expect.arrayContaining([
        expect.objectContaining({ id: "Gi0/0", mplsEnabled: true }),
        expect.objectContaining({ id: "Gi0/1", vrfId: "blue" }),
      ]),
      vrfs: [expect.objectContaining({ id: "blue", routeDistinguisher: "65000:100" })],
      bgp: expect.objectContaining({ vrfAddressFamilies: [{ vrfId: "blue", redistributeConnected: true, redistributeStatic: true }] }),
    });
    const rebuilt = buildLabFromDocument(serialized);
    expect(canonicalizeLabDocument(serializeLabDocument(rebuilt, serialized))).toEqual(canonicalizeLabDocument(serialized));
  });

  it("never serializes LFIB, LDP sessions, learned VPN routes or dynamic labels", () => {
    const built = buildLabFromDocument(document);
    const router = built.getRouter("pe1")!;
    router.installMplsForwardingEntry({ incomingLabel: 99, fec: "runtime-only", operation: { type: "pop" }, source: "local" });
    const serialized = JSON.stringify(serializeLabDocument(built, document));
    expect(serialized).not.toContain("runtime-only");
    expect(serialized).not.toContain("forwardingTable");
    expect(serialized).not.toContain("ldpNeighbors");
    expect(serialized).not.toContain("vpnLabelBindings");
  });

  it("opens an old schema-v1 Router with MPLS fields absent", () => {
    const legacy = structuredClone(document);
    const config = legacy.configurations.pe1;
    if (config?.kind === "router") {
      delete config.ldp;
      delete config.vrfs;
      delete config.bgp;
      for (const iface of config.interfaces) { delete iface.mplsEnabled; delete iface.vrfId; }
    }
    expect(() => parseLabDocument(legacy)).not.toThrow();
    expect(parseLabDocument(legacy).configurations.pe1).toMatchObject({ kind: "router" });
  });

  it("rejects MPLS configuration on a non-Router device", () => {
    const invalid = structuredClone(document) as unknown as Record<string, unknown>;
    const configs = (invalid.configurations as Record<string, Record<string, unknown>>);
    configs.pe1 = { ...configs.pe1, kind: "l3-switch" };
    expect(() => parseLabDocument(invalid)).toThrow();
  });

  it("reports an interface reference to an unknown VRF", () => {
    const invalid = structuredClone(document);
    const config = invalid.configurations.pe1;
    if (config?.kind === "router") config.interfaces[1]!.vrfId = "missing";
    expect(() => validateLabSemantics(parseLabDocument(invalid))).toThrow(/Unknown VRF/u);
  });
});
