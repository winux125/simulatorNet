import { buildLabFromDocument, canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { BGP_DEMO_LABS, DUAL_ISP_BEST_PATH_DEMO, EBGP_BASIC_DEMO, IBGP_POLICY_DEMO } from "./bgp-demo-labs";

describe("M10.10 BGP demo labs", () => {
  it.each(BGP_DEMO_LABS.map((document) => [document.title, document] as const))("%s is a valid explicitly-loadable schema-v1 lab", (_title, document) => {
    expect(parseLabDocument(document).schemaVersion).toBe(1);
    expect(document.instructions).toContain("Objective:");
    expect(document.expectedOutcome).toBeTruthy();
  });

  it("eBGP Basic converges and carries end-to-end ICMP", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(EBGP_BASIC_DEMO));
    built.engine.runUntilIdle();
    expect(built.getRouter("r1")?.bgp.summaries()[0]?.state).toBe("established");
    built.getPc("pc-a")?.ping("10.20.0.10", 1);
    built.engine.runUntilIdle();
    expect(built.getPc("pc-a")?.pingResults.find((entry) => entry.sequence === 1)?.success).toBe(true);
  });

  it("Dual ISP selects the higher local-preference path deterministically", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(DUAL_ISP_BEST_PATH_DEMO));
    built.engine.runUntilIdle();
    const best = built.getRouter("customer")?.bgp.routes().find((route) => route.best && route.network === "203.0.113.0");
    expect(best).toMatchObject({ neighborAddress: "192.0.2.2", localPreference: 200 });
  });

  it("iBGP full mesh establishes and applies the inbound route policy", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(IBGP_POLICY_DEMO));
    built.engine.runUntilIdle();
    expect(built.getRouter("edge2")?.bgp.summaries().every((neighbor) => neighbor.state === "established")).toBe(true);
    expect(built.getRouter("edge2")?.bgp.routes().find((route) => route.network === "10.1.0.0" && route.best)?.localPreference).toBe(150);
  });
});
