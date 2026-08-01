import { createVpnPreSharedKeyVerifier } from "@sim/console-auth";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  DEMO_PRE_SHARED_KEY_HINT,
  GRE_OVER_IPSEC_DEMO,
  GRE_SITE_TO_SITE_DEMO,
  VPN_DEMO_LABS,
  VPN_FAILURE_AND_REKEY_DEMO,
} from "./vpn-demo-labs";

/**
 * Virtual nanoseconds per second. Declared locally on purpose: the web main
 * thread must not import `@sim/sim-core` — only the worker reaches the engine.
 */
const NS_PER_S = 1_000_000_000;

describe("VPN demo labs", () => {
  it.each(VPN_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s canonicalizes, builds and round-trips",
    (_title, document) => {
      const canonical = canonicalizeLabDocument(document);
      const built = buildLabFromDocument(canonical);
      const serialized = serializeLabDocument(built, {
        id: canonical.id,
        title: canonical.title,
        description: canonical.description,
        instructions: canonical.instructions,
        expectedOutcome: canonical.expectedOutcome,
      });
      expect(serialized.configurations).toEqual(canonical.configurations);
      expect(serialized.topology.links).toEqual(canonical.topology.links);
    },
  );

  it.each(VPN_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s documents its objective, addressing, steps and troubleshooting hints",
    (_title, document) => {
      expect(document.description).toMatch(/Objective:/);
      expect(document.instructions).toMatch(/Underlay addressing:/);
      expect(document.instructions).toMatch(/Overlay addressing:/);
      expect(document.instructions).toMatch(/Configuration steps/);
      expect(document.instructions).toMatch(/Expected result:/);
      expect(document.instructions).toMatch(/Troubleshooting hints:/);
      expect(document.expectedOutcome).toBeTruthy();
    },
  );

  it("never stores a plaintext pre-shared key in a demo document", () => {
    for (const document of VPN_DEMO_LABS) {
      // The teaching key may appear in Instructions, where a learner reads it —
      // but never in the configuration a lab actually stores.
      expect(JSON.stringify(document.configurations)).not.toContain(DEMO_PRE_SHARED_KEY_HINT);
    }
  });

  it("carries IPv4 and IPv6 across a plain GRE tunnel", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(GRE_SITE_TO_SITE_DEMO));
    built.engine.enableTrace();
    built.engine.runUntilIdle();
    expect(built.getRouter("r1")!.tunnelSummaries()[0]!.operUp).toBe(true);

    const pcA = built.getPc("pc-a")!;
    pcA.ping("10.2.0.10", 1);
    built.engine.runUntilIdle();
    expect(pcA.pingResults.find((entry) => entry.sequence === 1)?.success).toBe(true);

    pcA.ping6("2001:db8:2::10", 2);
    built.engine.runUntilIdle();
    expect(pcA.ipv6PingResults.find((entry) => entry.sequence === 2)?.success).toBe(true);

    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types.has("gre-encapsulation-started")).toBe(true);
    expect(types.has("gre-decapsulated")).toBe(true);
    // The provider only ever routes the outer addresses.
    for (const entry of built.engine.traceLog.filter((row) => row.device === "isp" && row.type === "route")) {
      expect(String(entry.detail?.dst)).toMatch(/^203\.0\.113\./u);
    }
  });

  it("establishes an SA and hides the inner HTTP exchange from the provider", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(GRE_OVER_IPSEC_DEMO));
    built.engine.enableTrace();
    built.engine.runUntilIdle();

    const r1 = built.getRouter("r1")!;
    expect(r1.ikeSessionSummaries()[0]!.state).toBe("ESTABLISHED");
    expect(r1.ipsecSecurityAssociations().filter((sa) => sa.state === "active")).toHaveLength(2);

    const pcA = built.getPc("pc-a")!;
    pcA.applications.httpGet("http://10.2.0.10/");
    built.engine.runUntilIdle();
    expect(pcA.applications.httpResults.at(-1)).toMatchObject({ status: "completed", statusCode: 200 });

    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types.has("esp-packet-protected")).toBe(true);
    expect(types.has("esp-packet-unprotected")).toBe(true);
    // The provider never saw an inner transport port.
    const ispDetail = JSON.stringify(built.engine.traceLog.filter((entry) => entry.device === "isp"));
    expect(ispDetail).not.toContain("10.1.0.10");
    expect(ispDetail).not.toContain("10.2.0.10");
  });

  it("starts broken, establishes once the key matches, and then rekeys", async () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(VPN_FAILURE_AND_REKEY_DEMO));
    built.engine.enableTrace();
    built.engine.runUntilIdle();

    const r1 = built.getRouter("r1")!;
    const r2 = built.getRouter("r2")!;
    // The branch ships without a key, so the tunnel cannot protect anything.
    expect(r2.ikeSessionSummaries()[0]!.failureReason).toBe("no-pre-shared-key");
    expect(r1.tunnelSummaries()[0]!.operUp).toBe(false);

    // Step 2: the learner types the teaching key; only the verifier is stored.
    r2.ipsec.updatePeer("HQ", {
      preSharedKeyVerifier: await createVpnPreSharedKeyVerifier(DEMO_PRE_SHARED_KEY_HINT),
    });
    r1.resetVpnRuntime();
    built.engine.runUntilIdle();
    expect(r1.ikeSessionSummaries()[0]!.state).toBe("ESTABLISHED");

    const pcA = built.getPc("pc-a")!;
    pcA.ping("10.2.0.10", 5);
    built.engine.runUntilIdle();
    expect(pcA.pingResults.find((entry) => entry.sequence === 5)?.success).toBe(true);

    // Step 4: advance past 90% of the 120 s lifetime and confirm the rekey.
    const original = r1.ipsecSecurityAssociations().find((sa) => sa.direction === "outbound")!;
    built.engine.traceLog.length = 0;
    built.engine.advanceTo(original.createdAtNs + 110 * NS_PER_S);
    r1.checkVpnLifetimes();
    r2.checkVpnLifetimes();
    built.engine.runUntilIdle();
    expect(built.engine.traceLog.map((entry) => entry.type)).toContain("ipsec-sa-rekeyed");
    expect(r1.ipsecSecurityAssociations()
      .find((sa) => sa.direction === "outbound" && sa.state === "active")!.generation)
      .toBeGreaterThan(original.generation);

    // Step 5: denying ESP stops protected traffic. IKE runs over UDP 500 and is
    // still permitted, so the session stays up while nothing gets through —
    // exactly the distinction the demo is meant to teach.
    r1.applyAcl("Gi0/1", "out", "BLOCK-ESP");
    built.engine.traceLog.length = 0;
    pcA.ping("10.2.0.10", 6);
    built.engine.runUntilIdle();
    expect(pcA.pingResults.find((entry) => entry.sequence === 6)?.success).not.toBe(true);
    expect(built.engine.traceLog.some((entry) =>
      entry.type === "acl-denied" && entry.detail?.protocol === 50)).toBe(true);

    // Step 6: removing the binding lets protected traffic flow again.
    r1.removeAclBinding("Gi0/1", "out");
    built.engine.runUntilIdle();
    pcA.ping("10.2.0.10", 7);
    built.engine.runUntilIdle();
    expect(pcA.pingResults.find((entry) => entry.sequence === 7)?.success).toBe(true);
    expect(r1.ikeSessionSummaries()[0]!.state).toBe("ESTABLISHED");
  });
});
