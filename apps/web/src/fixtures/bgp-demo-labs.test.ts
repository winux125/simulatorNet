import { buildLabFromDocument, canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  BGP_AGGREGATION_POLICY_DEMO,
  BGP_COMMUNITIES_DEMO,
  BGP_DEMO_LABS,
  DUAL_ISP_BEST_PATH_DEMO,
  EBGP_BASIC_DEMO,
  IBGP_POLICY_DEMO,
  IBGP_ROUTE_REFLECTOR_DEMO,
} from "./bgp-demo-labs";

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

describe("M10.12 BGP demo labs", () => {
  it("iBGP Route Reflector replaces the full mesh and stamps the reflection attributes", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(IBGP_ROUTE_REFLECTOR_DEMO));
    built.engine.runUntilIdle();
    const client2 = built.getRouter("client2")!;
    expect(client2.bgp.summaries()).toHaveLength(1);
    const reflected = client2.bgp.adjRibInEntries("10.0.2.1").find((route) => route.network === "172.16.1.0");
    expect(reflected).toMatchObject({ originatorId: "1.1.1.1", clusterList: ["10.255.0.1"] });
    // A non-client route reaches the clients but never another non-client.
    expect(built.getRouter("edge")!.bgp.adjRibInEntries("10.0.4.1").map((route) => route.network).sort())
      .toEqual(["172.16.1.0", "172.16.2.0", "172.16.3.0"]);
  });

  it("BGP Communities re-prices a tagged prefix and keeps no-export inside the AS", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(BGP_COMMUNITIES_DEMO));
    built.engine.runUntilIdle();
    const provider = built.getRouter("provider")!;
    const tagged = provider.bgp.routes().find((route) => route.network === "198.51.100.0");
    expect(tagged).toMatchObject({ communities: ["65000:100"], localPreference: 250 });
    expect(provider.bgp.routes().find((route) => route.network === "198.51.101.0")?.communities).toEqual(["no-export"]);
    const upstream = built.getRouter("upstream")!.bgp.adjRibInEntries().map((route) => route.network);
    expect(upstream).toContain("198.51.100.0");
    expect(upstream).not.toContain("198.51.101.0");
  });

  it("Aggregation demo advertises only the summary and originates a default for ISP1 alone", () => {
    const built = buildLabFromDocument(canonicalizeLabDocument(BGP_AGGREGATION_POLICY_DEMO));
    built.engine.runUntilIdle();
    const edge = built.getRouter("edge")!;
    expect(edge.bgp.selectedRoutes().map((route) => `${route.network}/${route.prefixLength}`).sort())
      .toEqual(expect.arrayContaining(["10.20.0.0/16", "10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]));
    const isp1 = built.getRouter("isp1")!.bgp.adjRibInEntries("192.0.2.1").map((route) => `${route.network}/${route.prefixLength}`);
    expect(isp1).toContain("10.20.0.0/16");
    expect(isp1).not.toContain("10.20.1.0/24");
    expect(isp1).toContain("0.0.0.0/0");
    const isp2 = built.getRouter("isp2")!.bgp.adjRibInEntries("198.51.100.1");
    expect(isp2.map((route) => `${route.network}/${route.prefixLength}`)).not.toContain("0.0.0.0/0");
    expect(isp2.find((route) => route.network === "10.20.0.0")?.asPath).toEqual([65_000, 65_000, 65_000]);
  });
});
