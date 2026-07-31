import { createVpnPreSharedKeyVerifier } from "@sim/console-auth";
import type { PasswordVerifier } from "@sim/contracts";
import {
  DEFAULT_VPN_LIMITS,
  IspCloud,
  NS_PER_S,
  Pc,
  Router,
  VpnConfigurationError,
  createSimulationEngine,
  deriveSpi,
  macFromIndex,
  type SimulationEngine,
  type TraceEntry,
} from "@sim/sim-core";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The same LAN A — R1 — ISP — R2 — LAN B underlay as the plain-GRE suite, with
 * Tunnel0 protected by an IPsec profile on both sides. Nothing here claims real
 * cryptography: the PSK verifier is an opaque scope-bound fingerprint and ESP
 * is a structured envelope.
 */
let MATCHING_KEY: PasswordVerifier;
let DIFFERENT_KEY: PasswordVerifier;

beforeAll(async () => {
  MATCHING_KEY = await createVpnPreSharedKeyVerifier("simulatornet-site-vpn");
  DIFFERENT_KEY = await createVpnPreSharedKeyVerifier("a-different-key-42");
});

interface ProtectedLab {
  engine: SimulationEngine;
  r1: Router;
  r2: Router;
  isp: IspCloud;
  pcA: Pc;
  pcB: Pc;
}

/** `undefined` keeps the matching key; `null` configures no key at all. */
type KeyChoice = PasswordVerifier | null | undefined;

interface LabOptions {
  leftKey?: KeyChoice;
  rightKey?: KeyChoice;
  leftEncryption?: "sim-aes128" | "sim-aes256";
  rightEncryption?: "sim-aes128" | "sim-aes256";
  lifetimeSeconds?: number;
  protectRight?: boolean;
  converge?: boolean;
}

function buildProtectedLab(options: LabOptions = {}): ProtectedLab {
  const engine = createSimulationEngine({ seed: 10_910 });
  const r1 = engine.add(new Router("r1", "R1"));
  const r2 = engine.add(new Router("r2", "R2"));
  const isp = engine.add(new IspCloud("isp", "ISP"));
  const pcA = engine.add(new Pc("pcA", "PC-A"));
  const pcB = engine.add(new Pc("pcB", "PC-B"));

  r1.addInterface("Gi0/0", macFromIndex(10));
  r1.addInterface("Gi0/1", macFromIndex(11));
  r2.addInterface("Gi0/0", macFromIndex(20));
  r2.addInterface("Gi0/1", macFromIndex(21));
  isp.addInterface("Eth0/0", macFromIndex(30));
  isp.addInterface("Eth0/1", macFromIndex(31));
  pcA.addInterface("eth0", macFromIndex(1));
  pcB.addInterface("eth0", macFromIndex(2));

  engine.connect("pcA", "eth0", "r1", "Gi0/0");
  engine.connect("r1", "Gi0/1", "isp", "Eth0/0");
  engine.connect("isp", "Eth0/1", "r2", "Gi0/1");
  engine.connect("r2", "Gi0/0", "pcB", "eth0");

  r1.configureInterface("Gi0/0", { ip: "10.1.0.1", mask: 24 });
  r1.configureInterface("Gi0/1", { ip: "203.0.113.1", mask: 30 });
  r2.configureInterface("Gi0/0", { ip: "10.2.0.1", mask: 24 });
  r2.configureInterface("Gi0/1", { ip: "203.0.113.6", mask: 30 });
  isp.configureInterface("Eth0/0", { ip: "203.0.113.2", mask: 30 });
  isp.configureInterface("Eth0/1", { ip: "203.0.113.5", mask: 30 });
  r1.addStaticRoute("203.0.113.4", 30, "203.0.113.2");
  r2.addStaticRoute("203.0.113.0", 30, "203.0.113.5");
  pcA.configure({ ip: "10.1.0.10", mask: 24, gateway: "10.1.0.1" });
  pcB.configure({ ip: "10.2.0.10", mask: 24, gateway: "10.2.0.1" });

  const lifetimeNs = (options.lifetimeSeconds ?? 3_600) * NS_PER_S;
  const chooseKey = (choice: KeyChoice): PasswordVerifier | undefined =>
    choice === null ? undefined : choice ?? MATCHING_KEY;
  const sides = [
    {
      router: r1,
      peerAddress: "203.0.113.6",
      key: chooseKey(options.leftKey),
      encryption: options.leftEncryption ?? "sim-aes256",
      overlay: "10.255.0.1",
      remoteLan: "10.2.0.0",
      remoteOverlay: "10.255.0.2",
      protect: true,
    },
    {
      router: r2,
      peerAddress: "203.0.113.1",
      key: chooseKey(options.rightKey),
      encryption: options.rightEncryption ?? "sim-aes256",
      overlay: "10.255.0.2",
      remoteLan: "10.1.0.0",
      remoteOverlay: "10.255.0.1",
      protect: options.protectRight ?? true,
    },
  ] as const;

  for (const side of sides) {
    side.router.defineIpsecProposal({ id: "IKE-PROP", encryption: side.encryption, integrity: "sim-sha256" });
    side.router.defineIkePeer({
      id: "SITE",
      remoteAddress: side.peerAddress,
      preSharedKeyVerifier: side.key,
      proposalId: "IKE-PROP",
      lifetimeNs,
    });
    side.router.defineIpsecProfile({
      id: "SITE-VPN",
      ikePeerId: "SITE",
      proposalId: "IKE-PROP",
      lifetimeNs,
    });
    side.router.configureTunnel(0, {
      source: { type: "interface", interfaceId: "Gi0/1" },
      destinationAddress: side.peerAddress,
      ipv4Addresses: [{ address: side.overlay, prefixLength: 30 }],
      ipsecProfileId: side.protect ? "SITE-VPN" : undefined,
    });
    side.router.addStaticRoute(side.remoteLan, 24, side.remoteOverlay);
  }

  engine.enableTrace();
  if (options.converge !== false) engine.runUntilIdle();
  return { engine, r1, r2, isp, pcA, pcB };
}

const typesOf = (trace: readonly TraceEntry[]): string[] => trace.map((entry) => entry.type);
const sessionOf = (router: Router) => router.ikeSessionSummaries()[0]!;

describe("IKEv2 negotiation and simulated IPsec protection", () => {
  it("derives deterministic, direction-specific SPIs both peers agree on", () => {
    const outboundAtLeft = deriveSpi("203.0.113.1", "203.0.113.6", 1, "child");
    const inboundAtRight = deriveSpi("203.0.113.1", "203.0.113.6", 1, "child");
    expect(outboundAtLeft).toBe(inboundAtRight);
    expect(deriveSpi("203.0.113.6", "203.0.113.1", 1, "child")).not.toBe(outboundAtLeft);
    expect(deriveSpi("203.0.113.1", "203.0.113.6", 2, "child")).not.toBe(outboundAtLeft);
    expect(outboundAtLeft).toBeGreaterThan(255);
  });

  // --- table-driven SA negotiation -----------------------------------------
  it.each([
    ["matching key and proposal establishes an SA", () => ({}), "ESTABLISHED", undefined],
    [
      "a wrong pre-shared key fails authentication",
      () => ({ rightKey: DIFFERENT_KEY }),
      "FAILED",
      "authentication-failed",
    ],
    [
      "a proposal mismatch fails negotiation",
      () => ({ rightEncryption: "sim-aes128" as const }),
      "FAILED",
      "proposal-mismatch",
    ],
    [
      "a peer with no pre-shared key never negotiates",
      () => ({ leftKey: null }),
      "FAILED",
      "no-pre-shared-key",
    ],
  ] as const)("%s", (_label, options, expectedState, expectedReason) => {
    const lab = buildProtectedLab(options());
    expect(sessionOf(lab.r1).state).toBe(expectedState);
    expect(sessionOf(lab.r1).failureReason).toBe(expectedReason);
    expect(lab.r1.tunnelSummaries()[0]!.operUp).toBe(expectedState === "ESTABLISHED");
  });

  it("establishes a matching SA pair and traces the negotiation without the key", () => {
    const lab = buildProtectedLab();
    const types = typesOf(lab.engine.traceLog);
    expect(types).toEqual(expect.arrayContaining([
      "ike-negotiation-started",
      "ike-proposal-selected",
      "ike-authentication-succeeded",
      "ipsec-sa-established",
    ]));

    const associations = lab.r1.ipsecSecurityAssociations();
    expect(associations.map((entry) => entry.direction).sort()).toEqual(["inbound", "outbound"]);
    const outbound = associations.find((entry) => entry.direction === "outbound")!;
    const remoteInbound = lab.r2.ipsecSecurityAssociations()
      .find((entry) => entry.direction === "inbound")!;
    // One peer's outbound SPI is the other's inbound SPI.
    expect(outbound.spi).toBe(remoteInbound.spi);
    expect(outbound.state).toBe("active");

    // No trace, anywhere, may carry the verifier or its fingerprint.
    const serialized = JSON.stringify(lab.engine.traceLog);
    expect(serialized).not.toContain(MATCHING_KEY.hashBase64);
    expect(serialized).not.toContain(MATCHING_KEY.saltBase64);
    expect(serialized).not.toContain("simulatornet-site-vpn");
  });

  it("carries protected traffic in both directions and counts it on the SA", () => {
    const lab = buildProtectedLab();
    lab.engine.traceLog.length = 0;
    lab.pcA.ping("10.2.0.10", 1);
    lab.engine.runUntilIdle();

    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 1)?.success).toBe(true);
    expect(typesOf(lab.engine.traceLog)).toEqual(expect.arrayContaining([
      "esp-packet-protected",
      "esp-packet-received",
      "esp-packet-unprotected",
      "gre-decapsulated",
    ]));
    const outbound = lab.r1.ipsecSecurityAssociations().find((entry) => entry.direction === "outbound")!;
    expect(outbound.packetCount).toBeGreaterThan(0);
    expect(outbound.byteCount).toBeGreaterThan(0);
    expect(outbound.sequenceNumber).toBeGreaterThan(0);
  });

  it("hides inner transport metadata from an intermediate policy", () => {
    const lab = buildProtectedLab();
    // The provider classifies on destination port 80; a protected packet must
    // never match, because the inner transport is simply not reachable.
    lab.isp.defineQosClassMap({
      id: "WEB",
      matchType: "match-any",
      matches: [{ kind: "destination-port", port: { kind: "eq", port: 80 } }],
    });
    lab.isp.defineQosPolicyMap({ id: "INSPECT", classes: [{ className: "WEB", marking: { dscp: 26 } }] });
    lab.isp.applyServicePolicy("Eth0/1", "output", "INSPECT");
    lab.isp.refreshEgressQueues();
    lab.engine.traceLog.length = 0;

    lab.pcA.connectTcp("10.2.0.10", 80);
    lab.engine.runUntilIdle();

    const espSeen = lab.engine.traceLog.filter((entry) => entry.type === "esp-packet-protected");
    expect(espSeen.length).toBeGreaterThan(0);
    const matched = lab.isp.qosCounters().filter((row) => row.className === "WEB" && row.matchedPackets > 0);
    expect(matched).toEqual([]);
    // The provider only ever saw the ESP outer packet.
    for (const entry of lab.engine.traceLog.filter((row) => row.device === "isp" && row.type === "route")) {
      expect(["203.0.113.1", "203.0.113.6"]).toContain(entry.detail?.dst as string);
    }
  });

  it("drops protected traffic while no SA is active", () => {
    const lab = buildProtectedLab({ rightKey: DIFFERENT_KEY });
    lab.engine.traceLog.length = 0;
    lab.pcA.ping("10.2.0.10", 2);
    lab.engine.runUntilIdle();

    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 2)?.success).not.toBe(true);
    expect(typesOf(lab.engine.traceLog)).not.toContain("esp-packet-protected");
    expect(lab.r1.tunnelSummaries()[0]!.reason).toBe("protection-unavailable");
  });

  // --- anti-replay -----------------------------------------------------------
  it.each([
    ["accepts a fresh sequence number", 12, true],
    ["rejects a duplicate sequence number", 5, false],
    ["rejects a sequence number outside the bounded window", 1, false],
  ] as const)("%s", (_label, sequenceNumber, accepted) => {
    const lab = buildProtectedLab();
    const inbound = lab.r2.ipsecSecurityAssociations().find((entry) => entry.direction === "inbound")!;
    const gre = {
      kind: "gre" as const,
      protocol: "ipv4" as const,
      tunnelId: "Tunnel0",
      innerPacket: {
        kind: "ipv4" as const,
        src: "10.1.0.10",
        dst: "10.2.0.10",
        protocol: 1 as const,
        ttl: 64,
        payload: { kind: "icmp" as const, type: 8 as const, code: 0, identifier: 1, sequence: 1 },
      },
    };
    // Advance the window past the replay threshold first.
    const window = DEFAULT_VPN_LIMITS.replayWindowPackets;
    const anchor = window + 5;
    for (const sequence of [5, anchor]) {
      lab.r2.ipsec.unprotect(
        {
          kind: "esp",
          spi: inbound.spi,
          sequenceNumber: sequence,
          protectedProtocol: "gre",
          protectedPayload: gre,
          integrityTag: integrityTagFor(inbound.spi, sequence, inbound.proposalId, gre),
        },
        "203.0.113.1",
        200,
      );
    }
    const result = lab.r2.ipsec.unprotect(
      {
        kind: "esp",
        spi: inbound.spi,
        sequenceNumber: sequenceNumber === 12 ? anchor + 7 : sequenceNumber,
        protectedProtocol: "gre",
        protectedPayload: gre,
        integrityTag: integrityTagFor(
          inbound.spi,
          sequenceNumber === 12 ? anchor + 7 : sequenceNumber,
          inbound.proposalId,
          gre,
        ),
      },
      "203.0.113.1",
      200,
    );
    expect("payload" in result).toBe(accepted);
    if (!accepted) expect((result as { rejection: string }).rejection).toBe("replay");
  });

  it("rejects an unknown SPI", () => {
    const lab = buildProtectedLab();
    lab.engine.traceLog.length = 0;
    const result = lab.r2.ipsec.unprotect(
      {
        kind: "esp",
        spi: 4_242,
        sequenceNumber: 1,
        protectedProtocol: "gre",
        protectedPayload: {
          kind: "gre",
          protocol: "ipv4",
          tunnelId: "Tunnel0",
          innerPacket: {
            kind: "ipv4",
            src: "10.1.0.10",
            dst: "10.2.0.10",
            protocol: 1,
            ttl: 64,
            payload: { kind: "icmp", type: 8, code: 0, identifier: 1, sequence: 1 },
          },
        },
        integrityTag: "sim-00000000",
      },
      "203.0.113.1",
      200,
    );
    expect(result).toEqual({ rejection: "invalid-spi" });
    expect(typesOf(lab.engine.traceLog)).toContain("esp-invalid-spi");
  });

  // --- lifetime and rekey ----------------------------------------------------
  it("rekeys deterministically before the lifetime expires and keeps carrying traffic", () => {
    const lab = buildProtectedLab({ lifetimeSeconds: 60 });
    const original = lab.r1.ipsecSecurityAssociations()
      .find((entry) => entry.direction === "outbound")!;
    lab.engine.traceLog.length = 0;

    // Advance to just past the rekey point (90% of a 60 s lifetime), measured
    // from when the SA was actually created. IPsec keeps no periodic timer, so
    // the runtime then applies what became due — exactly what the worker does
    // after ADVANCE_TIME.
    lab.engine.advanceTo(original.createdAtNs + 56 * NS_PER_S);
    lab.r1.checkVpnLifetimes();
    lab.r2.checkVpnLifetimes();
    lab.engine.runUntilIdle();

    expect(typesOf(lab.engine.traceLog)).toContain("ipsec-sa-rekeyed");
    const rekeyed = lab.r1.ipsecSecurityAssociations()
      .find((entry) => entry.direction === "outbound" && entry.state === "active")!;
    expect(rekeyed.generation).toBeGreaterThan(original.generation);
    expect(rekeyed.spi).not.toBe(original.spi);
    expect(sessionOf(lab.r1).state).toBe("ESTABLISHED");

    lab.pcA.ping("10.2.0.10", 3);
    lab.engine.runUntilIdle();
    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 3)?.success).toBe(true);
  });

  it("expires the SA and takes protection away when a rekey cannot complete", () => {
    const lab = buildProtectedLab({ lifetimeSeconds: 60 });
    const original = lab.r1.ipsecSecurityAssociations()
      .find((entry) => entry.direction === "outbound")!;
    // Break the underlay so the rekey exchange can never be answered.
    lab.r2.getInterface("Gi0/1")!.shutdown();
    lab.engine.traceLog.length = 0;
    lab.engine.advanceTo(original.createdAtNs + 61 * NS_PER_S);
    lab.r1.checkVpnLifetimes();
    lab.engine.runUntilIdle();
    lab.r1.checkVpnLifetimes();

    expect(typesOf(lab.engine.traceLog)).toContain("ipsec-sa-expired");
    expect(lab.r1.ipsecSecurityAssociations().every((entry) => entry.state !== "active")).toBe(true);
    expect(lab.r1.tunnelSummaries()[0]!.operUp).toBe(false);
  });

  it("re-establishes protection after the correct key is configured", () => {
    const lab = buildProtectedLab({ rightKey: DIFFERENT_KEY });
    expect(sessionOf(lab.r1).state).toBe("FAILED");

    lab.r2.defineIkePeer({
      id: "SITE",
      remoteAddress: "203.0.113.1",
      preSharedKeyVerifier: MATCHING_KEY,
      proposalId: "IKE-PROP",
      lifetimeNs: 3_600 * NS_PER_S,
    });
    lab.r1.resetVpnRuntime();
    lab.engine.runUntilIdle();

    expect(sessionOf(lab.r1).state).toBe("ESTABLISHED");
    lab.pcA.ping("10.2.0.10", 4);
    lab.engine.runUntilIdle();
    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 4)?.success).toBe(true);
  });

  it("lets an ACL block the outer IKE and ESP traffic", () => {
    const lab = buildProtectedLab({ converge: false });
    lab.r1.defineAcl({
      id: "BLOCK-VPN",
      type: "extended",
      rules: [
        { sequence: 10, action: "deny", protocol: 17, source: { kind: "any" }, destination: { kind: "any" }, destinationPort: { kind: "eq", port: 500 } },
        { sequence: 20, action: "permit", protocol: "ip", source: { kind: "any" }, destination: { kind: "any" } },
      ],
    });
    lab.r1.applyAcl("Gi0/1", "out", "BLOCK-VPN");
    lab.engine.runUntilIdle();

    expect(sessionOf(lab.r1).state).not.toBe("ESTABLISHED");
    expect(lab.r1.tunnelSummaries()[0]!.operUp).toBe(false);
    expect(typesOf(lab.engine.traceLog)).toContain("acl-denied");
  });

  // --- configuration validation ---------------------------------------------
  it.each([
    ["rejects an unsupported encryption algorithm", () => ({ id: "P", encryption: "aes256", integrity: "sim-sha256" }), /encryption/iu],
    ["rejects an unsupported integrity algorithm", () => ({ id: "P", encryption: "sim-aes256", integrity: "sha1" }), /integrity/iu],
    ["rejects an empty proposal name", () => ({ id: " ", encryption: "sim-aes256", integrity: "sim-sha256" }), /required/iu],
  ] as const)("%s", (_label, build, expected) => {
    const engine = createSimulationEngine({ seed: 1 });
    const router = engine.add(new Router("r", "R"));
    expect(() => router.defineIpsecProposal(build() as never)).toThrow(expected);
  });

  it.each([
    ["rejects a malformed peer address", { remoteAddress: "203.0.113" }, /valid IPv4/iu],
    ["rejects a lifetime below the floor", { lifetimeNs: 5 * NS_PER_S }, /lifetime/iu],
    ["rejects a lifetime above the ceiling", { lifetimeNs: 200_000 * NS_PER_S }, /lifetime/iu],
  ] as const)("%s", (_label, patch, expected) => {
    const engine = createSimulationEngine({ seed: 1 });
    const router = engine.add(new Router("r", "R"));
    expect(() => router.defineIkePeer({
      id: "PEER",
      remoteAddress: "203.0.113.6",
      proposalId: "P",
      lifetimeNs: 3_600 * NS_PER_S,
      ...patch,
    })).toThrow(VpnConfigurationError);
    expect(() => router.defineIkePeer({
      id: "PEER",
      remoteAddress: "203.0.113.6",
      proposalId: "P",
      lifetimeNs: 3_600 * NS_PER_S,
      ...patch,
    })).toThrow(expected);
  });

  it("keeps every negotiated value out of persistent configuration", () => {
    const lab = buildProtectedLab();
    const [peer] = lab.r1.ikePeerConfigurations();
    const [profile] = lab.r1.ipsecProfileConfigurations();
    const [tunnel] = lab.r1.tunnelConfigurations();

    expect(Object.keys(peer!).sort()).toEqual(
      ["id", "lifetimeNs", "preSharedKeyVerifier", "proposalId", "remoteAddress"],
    );
    expect(Object.keys(profile!).sort()).toEqual(["id", "ikePeerId", "lifetimeNs", "proposalId"]);
    expect(tunnel!.ipsecProfileId).toBe("SITE-VPN");
    // SPIs, sequence numbers and counters live only in the runtime view.
    const serialized = JSON.stringify({ peer, profile, tunnel });
    expect(serialized).not.toMatch(/spi|sequenceNumber|packetCount|byteCount/iu);
    expect(lab.r1.ipsecSecurityAssociations().length).toBeGreaterThan(0);
  });
});

/** Mirror of the engine's deterministic integrity label, for replay fixtures. */
function integrityTagFor(
  spi: number,
  sequenceNumber: number,
  proposalId: string,
  payload: { tunnelId: string; protocol: string; innerPacket: { src: string; dst: string } },
): string {
  let hash = 2_166_136_261;
  const material = [
    spi,
    sequenceNumber,
    proposalId,
    payload.tunnelId,
    payload.protocol,
    payload.innerPacket.src,
    payload.innerPacket.dst,
  ].join("|");
  for (const character of material) hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0;
  return `sim-${hash.toString(16).padStart(8, "0")}`;
}
