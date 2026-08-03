import type { LabDocument, LabMetadata } from "@sim/contracts";
import { buildLabFromDocument, canonicalizeLabDocument, parseLabDocument, serializeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "bgp-format", title: "BGP format" };

function bgpLab(): LabDocument {
  const router = (hostname: string, address: string, localAs: number, remoteAddress: string, remoteAs: number) => ({
    kind: "router" as const, hostname,
    interfaces: [{ id: "Gi0/0", routed: true, shutdown: false, ipv4: { address, prefixLength: 30 } }],
    subinterfaces: [], staticRoutes: [], dhcpPools: [], acls: [], aclBindings: [], natPools: [], natRules: [], natInterfaceRoles: [],
    loopbacks: [{ id: 0, shutdown: false, ipv4: { address: localAs === 65_001 ? "10.1.0.1" : "10.2.0.1", prefixLength: 24 } }],
    prefixLists: [{ id: "CUSTOMER", entries: [{ sequence: 10, action: "permit" as const, prefix: "10.0.0.0", prefixLength: 8, le: 24 }] }],
    routeMaps: [{ id: "PEER-IN", sequences: [{ sequence: 10, action: "permit" as const, match: { prefixListIds: ["CUSTOMER"] }, set: { localPreference: 150 } }] }],
    bgp: { localAs, routerId: localAs === 65_001 ? "1.1.1.1" : "2.2.2.2", neighbors: [{ address: remoteAddress, remoteAs, enabled: true, routeMapIn: "PEER-IN" }], networks: [{ network: localAs === 65_001 ? "10.1.0.0" : "10.2.0.0", prefixLength: 24 }] },
  });
  return {
    schemaVersion: 1, ...metadata, simulation: { seed: 10_110 },
    topology: { schemaVersion: 1, nodes: [
      { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }] },
      { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }] },
    ], links: [{ id: "r1-r2", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } }] },
    configurations: { r1: router("R1", "192.0.2.1", 65_001, "192.0.2.2", 65_002), r2: router("R2", "192.0.2.2", 65_002, "192.0.2.1", 65_001) },
  } as unknown as LabDocument;
}

describe("BGP LabDocument integration", () => {
  it("round-trips process, policy and neighbor bindings canonically", () => {
    const canonical = canonicalizeLabDocument(bgpLab());
    const built = buildLabFromDocument(canonical);
    const serialized = serializeLabDocument(built, metadata);
    const rebuilt = buildLabFromDocument(serialized);
    expect(stringifyLabDocument(serializeLabDocument(rebuilt, metadata))).toBe(stringifyLabDocument(serialized));
    const r1 = serialized.configurations.r1;
    expect(r1 && "bgp" in r1 ? r1.bgp?.neighbors[0]?.routeMapIn : undefined).toBe("PEER-IN");
  });

  it("does not serialize learned RIBs, sessions or policy counters", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(bgpLab()));
    built.engine.runUntilIdle();
    expect(built.getRouter("r1")?.bgp.adjRibInEntries().length).toBeGreaterThan(0);
    const json = stringifyLabDocument(serializeLabDocument(built, metadata));
    expect(json).not.toMatch(/adjRib|locRib|established|policyCounters|messagesReceived/i);
  });

  it("opens old schema-v1 routed labs without BGP or route-policy fields", () => {
    const old = bgpLab();
    for (const config of Object.values(old.configurations)) {
      if ("bgp" in config) { delete config.bgp; delete config.prefixLists; delete config.routeMaps; }
    }
    const parsed = parseLabDocument(old);
    expect(parsed.configurations.r1 && "bgp" in parsed.configurations.r1 ? parsed.configurations.r1.bgp : undefined).toBeUndefined();
  });

  it("rejects a missing neighbor policy reference before build", () => {
    const input = bgpLab();
    const r1 = input.configurations.r1;
    if (!r1 || !("bgp" in r1) || !r1.bgp) throw new Error("fixture");
    r1.bgp.neighbors[0]!.routeMapIn = "MISSING";
    expect(() => parseLabDocument(input)).toThrow(/Unknown BGP policy 'MISSING'/);
  });

  it("rejects an unknown update-source and duplicate network statement", () => {
    const source = bgpLab();
    const r1 = source.configurations.r1;
    if (!r1 || !("bgp" in r1) || !r1.bgp) throw new Error("fixture");
    r1.bgp.neighbors[0]!.updateSource = "Loopback99";
    expect(() => parseLabDocument(source)).toThrow(/Unknown BGP update-source/);

    const duplicate = bgpLab();
    const next = duplicate.configurations.r1;
    if (!next || !("bgp" in next) || !next.bgp) throw new Error("fixture");
    next.bgp.networks.push({ ...next.bgp.networks[0]! });
    expect(() => parseLabDocument(duplicate)).toThrow(/Duplicate BGP network statement/);
  });
});
