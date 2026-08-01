import { createVpnPreSharedKeyVerifier } from "@sim/console-auth";
import type { LabDocument, LabDocumentDraft } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  LabSemanticError,
  serializeLabDocument,
} from "@sim/lab-format";
import { beforeAll, describe, expect, it } from "vitest";

let KEY: Awaited<ReturnType<typeof createVpnPreSharedKeyVerifier>>;

beforeAll(async () => {
  KEY = await createVpnPreSharedKeyVerifier("simulatornet-site-vpn");
});

function draft(overrides: {
  vpn?: unknown;
  /** Explicitly omit the whole block, to prove a pre-M10.9 lab still opens. */
  withoutVpn?: boolean;
  staticRoutes?: unknown;
} = {}): LabDocumentDraft {
  return {
    schemaVersion: 1,
    id: "vpn-round-trip",
    title: "VPN round trip",
    simulation: { seed: 5 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      ],
      links: [{ id: "wan", a: { node: "r1", iface: "Gi0/1" }, b: { node: "r2", iface: "Gi0/1" } }],
    },
    configurations: {
      r1: {
        kind: "router",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.1.0.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
        ],
        staticRoutes: (overrides.staticRoutes as never) ?? [],
        vpn: overrides.withoutVpn ? undefined : (overrides.vpn as never) ?? {
          tunnels: [{
            id: 0,
            shutdown: false,
            source: { type: "interface", interfaceId: "Gi0/1" },
            destinationAddress: "203.0.113.2",
            mode: "gre-ipv4",
            ipv4: { address: "10.255.0.1", prefixLength: 30 },
            ipv6: [{ address: "2001:db8:ffff::1", prefixLength: 64 }],
            mtu: 1_400,
            ttl: 64,
            ipsecProfileId: "SITE-VPN",
          }],
          proposals: [{ id: "IKE-PROP", encryption: "sim-aes256", integrity: "sim-sha256" }],
          ikePeers: [{
            id: "BRANCH",
            address: "203.0.113.2",
            preSharedKeyVerifier: KEY,
            proposalId: "IKE-PROP",
            lifetimeSeconds: 600,
          }],
          ipsecProfiles: [{
            id: "SITE-VPN",
            ikePeerId: "BRANCH",
            proposalId: "IKE-PROP",
            lifetimeSeconds: 600,
          }],
        },
      },
      // The far end mirrors the tunnel, so the lab really negotiates and there
      // is live runtime for the round-trip tests to prove is discarded.
      r2: {
        kind: "router",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.2.0.1", prefixLength: 24 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "203.0.113.2", prefixLength: 30 } },
        ],
        vpn: overrides.withoutVpn ? undefined : {
          tunnels: [{
            id: 0,
            shutdown: false,
            source: { type: "interface", interfaceId: "Gi0/1" },
            destinationAddress: "203.0.113.1",
            mode: "gre-ipv4",
            ipv4: { address: "10.255.0.2", prefixLength: 30 },
            mtu: 1_400,
            ttl: 64,
            ipsecProfileId: "SITE-VPN",
          }],
          proposals: [{ id: "IKE-PROP", encryption: "sim-aes256", integrity: "sim-sha256" }],
          ikePeers: [{
            id: "HQ",
            address: "203.0.113.1",
            preSharedKeyVerifier: KEY,
            proposalId: "IKE-PROP",
            lifetimeSeconds: 600,
          }],
          ipsecProfiles: [{
            id: "SITE-VPN",
            ikePeerId: "HQ",
            proposalId: "IKE-PROP",
            lifetimeSeconds: 600,
          }],
        },
      },
    },
  } as LabDocumentDraft;
}

describe("site-to-site VPN persistence", () => {
  it("round-trips tunnels, proposals, peers and profiles unchanged", () => {
    const canonical = canonicalizeLabDocument(draft());
    const built = buildLabFromDocument(canonical);
    const serialized = serializeLabDocument(built, { id: canonical.id, title: canonical.title });
    expect(serialized.configurations).toEqual(canonical.configurations);
  });

  it("discards every runtime value and rebuilds it from configuration alone", () => {
    const canonical = canonicalizeLabDocument(draft());
    const built = buildLabFromDocument(canonical);
    built.engine.runUntilIdle();
    // The lab negotiated: there is live runtime to lose.
    expect(built.getRouter("r1")!.ipsecSecurityAssociations().length).toBeGreaterThan(0);

    const serialized = serializeLabDocument(built, { id: canonical.id, title: canonical.title });
    const text = JSON.stringify(serialized.configurations);
    for (const runtimeField of ["spi", "sequenceNumber", "packetCount", "byteCount", "createdAtNs", "expiresAtNs"]) {
      expect(text).not.toContain(runtimeField);
    }
    // Rebuilding from the serialized document reaches the same state again.
    const rebuilt = buildLabFromDocument(serialized);
    rebuilt.engine.runUntilIdle();
    expect(rebuilt.getRouter("r1")!.ikeSessionSummaries()[0]!.state)
      .toBe(built.getRouter("r1")!.ikeSessionSummaries()[0]!.state);
  });

  it("stores only the verifier, never a plaintext pre-shared key", () => {
    const canonical = canonicalizeLabDocument(draft());
    const text = JSON.stringify(canonical.configurations);
    expect(text).not.toContain("simulatornet-site-vpn");
    expect(text).toContain(KEY.hashBase64);
  });

  it("opens a schema-v1 lab written before M10.9 with no vpn block", () => {
    const canonical = canonicalizeLabDocument(draft({ withoutVpn: true }));
    expect((canonical.configurations.r1 as { vpn?: unknown }).vpn).toBeUndefined();
    const built = buildLabFromDocument(canonical);
    expect(built.getRouter("r1")!.tunnelConfigurations()).toEqual([]);
  });

  it("accepts a static route through a tunnel overlay next hop", () => {
    const canonical = canonicalizeLabDocument(draft({
      staticRoutes: [{ network: "10.2.0.0", prefixLength: 24, nextHop: "10.255.0.2" }],
    }));
    expect(canonical.configurations.r1).toBeDefined();
  });

  // --- table-driven semantic validation ------------------------------------
  const base = () => (draft().configurations.r1 as { vpn: Record<string, unknown> }).vpn;

  it.each([
    [
      "rejects duplicate tunnel ids",
      () => ({ ...base(), tunnels: [...(base().tunnels as unknown[]), (base().tunnels as unknown[])[0]] }),
      /Duplicate tunnel id/u,
    ],
    [
      "rejects a tunnel source interface the device does not have",
      () => ({
        ...base(),
        tunnels: [{ ...(base().tunnels as Record<string, unknown>[])[0], source: { type: "interface", interfaceId: "Gi9/9" } }],
      }),
      /Unknown tunnel source interface/u,
    ],
    [
      "rejects a tunnel source address the device does not own",
      () => ({
        ...base(),
        tunnels: [{ ...(base().tunnels as Record<string, unknown>[])[0], source: { type: "address", address: "198.51.100.9" } }],
      }),
      /is not configured on this device/u,
    ],
    [
      "rejects a destination inside the tunnel's own overlay subnet",
      () => ({
        ...base(),
        tunnels: [{ ...(base().tunnels as Record<string, unknown>[])[0], destinationAddress: "10.255.0.2" }],
      }),
      /inside its own overlay subnet/u,
    ],
    [
      "rejects a tunnel bound to an undefined IPsec profile",
      () => ({
        ...base(),
        tunnels: [{ ...(base().tunnels as Record<string, unknown>[])[0], ipsecProfileId: "MISSING" }],
      }),
      /Unknown IPsec profile/u,
    ],
    [
      "rejects a peer naming an undefined proposal",
      () => ({
        ...base(),
        ikePeers: [{ ...(base().ikePeers as Record<string, unknown>[])[0], proposalId: "MISSING" }],
      }),
      /Unknown IKEv2 proposal/u,
    ],
    [
      "rejects a profile naming an undefined peer",
      () => ({
        ...base(),
        ipsecProfiles: [{ ...(base().ipsecProfiles as Record<string, unknown>[])[0], ikePeerId: "MISSING" }],
      }),
      /Unknown IKEv2 peer/u,
    ],
  ] as const)("%s", (_label, mutate, expected) => {
    expect(() => canonicalizeLabDocument(draft({ vpn: mutate() })))
      .toThrow(expected);
  });

  /**
   * A Cloud reuses the router configuration shape, so a `vpn` block is
   * *expressible* there — the semantic layer is what refuses it, because the
   * Cloud device profile does not carry the `vpn-tunnel` capability. (An L3
   * Switch cannot even express one: its schema has no `vpn` field.)
   */
  it("rejects a VPN on a device kind that does not terminate tunnels", () => {
    const document = draft() as unknown as LabDocument;
    const withCloud = {
      ...document,
      topology: {
        ...document.topology,
        nodes: [
          ...document.topology.nodes,
          {
            id: "isp",
            kind: "cloud" as const,
            name: "ISP",
            interfaces: [{ id: "Eth0/0" }, { id: "Eth0/1" }, { id: "Eth0/2" }, { id: "Eth0/3" }],
          },
        ],
      },
      configurations: {
        ...document.configurations,
        isp: {
          kind: "cloud" as const,
          interfaces: [
            { id: "Eth0/0", routed: true, ipv4: { address: "203.0.113.9", prefixLength: 30 } },
            { id: "Eth0/1" },
            { id: "Eth0/2" },
            { id: "Eth0/3" },
          ],
          vpn: {
            tunnels: [{
              id: 0,
              shutdown: false,
              source: { type: "interface" as const, interfaceId: "Eth0/0" },
              destinationAddress: "203.0.113.1",
              mode: "gre-ipv4" as const,
              mtu: 1_400,
              ttl: 64,
            }],
            proposals: [],
            ikePeers: [],
            ipsecProfiles: [],
          },
        },
      },
    } as unknown as LabDocumentDraft;
    expect(() => canonicalizeLabDocument(withCloud))
      .toThrow(/does not terminate GRE tunnels/u);
  });

  it("names the semantic error path for an unresolvable reference", () => {
    try {
      canonicalizeLabDocument(draft({
        vpn: { ...base(), ipsecProfiles: [] },
      }));
      expect.unreachable("expected a semantic error");
    } catch (error) {
      expect(error).toBeInstanceOf(LabSemanticError);
      expect((error as LabSemanticError).path).toMatch(/vpn\.tunnels\[0\]\.ipsecProfileId/u);
    }
  });
});
