import { buildLabFromDocument, canonicalizeLabDocument, parseLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  DUAL_STACK_BGP_DEMO,
  EBGP_IPV6_DEMO,
  MBGP_IPV6_DEMO_LABS,
  VPNV6_OVER_MPLS_DEMO,
} from "./mbgp-ipv6-demo-labs";

const build = (document: typeof EBGP_IPV6_DEMO) =>
  buildLabFromDocument(canonicalizeLabDocument(document));

describe("M10.13 MP-BGP IPv6 demo labs", () => {
  it.each(MBGP_IPV6_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s is a valid explicitly-loadable schema-v1 lab",
    (_title, document) => {
      expect(parseLabDocument(document).schemaVersion).toBe(1);
      expect(document.instructions).toContain("Objective:");
      expect(document.instructions).toContain("Troubleshooting:");
      expect(document.expectedOutcome).toBeTruthy();
    },
  );

  it("stores configuration only, never runtime state", () => {
    const serialized = JSON.stringify(MBGP_IPV6_DEMO_LABS);
    for (const forbidden of ["adjRib", "locRib", "vpnLabel", "lfib", "sessionState", "neighborCache"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("eBGP over IPv6 establishes and exchanges IPv6 unicast prefixes", () => {
    const built = build(EBGP_IPV6_DEMO);
    built.engine.runUntilIdle();

    const r1 = built.getRouter("r1")!;
    const r2 = built.getRouter("r2")!;
    expect(r1.bgp.summaries()[0]).toMatchObject({
      address: "2001:db8:12::2",
      state: "established",
    });
    expect(r1.bgp.summaries()[0]?.addressFamilies).toContain("ipv6-unicast");
    // The RIBs are per family: an IPv6 prefix never lands in the IPv4 table.
    expect(r1.bgp.routes("ipv6-unicast").map((route) => route.network)).toContain("2001:db8:b::");
    expect(r2.bgp.routes("ipv6-unicast").map((route) => route.network)).toContain("2001:db8:a::");
    expect(r1.bgp.routes("ipv4-unicast")).toHaveLength(0);
  });

  it("Dual-Stack BGP carries both families on one session with independent policy", () => {
    const built = build(DUAL_STACK_BGP_DEMO);
    built.engine.runUntilIdle();

    const r2 = built.getRouter("r2")!;
    const summary = r2.bgp.summaries()[0]!;
    // One TCP session, two negotiated families.
    expect(summary.state).toBe("established");
    expect(summary.addressFamilies).toEqual(expect.arrayContaining(["ipv4-unicast", "ipv6-unicast"]));

    expect(r2.bgp.routes("ipv4-unicast").map((route) => route.network)).toContain("10.10.0.0");
    const ipv6 = r2.bgp.routes("ipv6-unicast").map((route) => route.network);
    // CUSTOMER6 permits only 2001:db8:100::/48 le 64; the rest hits implicit deny.
    expect(ipv6).toContain("2001:db8:100::");
    expect(ipv6).not.toContain("2001:db8:200::");
  });

  it("VPNv6 Over MPLS keeps overlapping customer /64s isolated and the P router label-only", () => {
    const built = build(VPNV6_OVER_MPLS_DEMO);
    built.engine.runUntilIdle();

    const pe2 = built.getRouter("pe2")!;
    const overlapping = pe2.bgp.vpnv6Routes()
      .filter((route) => route.network === "2001:db8:100::" && route.prefixLength === 64);
    // The same prefix arrives twice, made unique by its route distinguisher.
    expect(new Set(overlapping.map((route) => route.routeDistinguisher)))
      .toEqual(new Set(["65000:100", "65000:200"]));
    // The transport next hop is the remote PE's IPv4 loopback, resolved through
    // the OSPF/LDP core; the payload is IPv6.
    expect(overlapping.every((route) => route.nextHop === "10.255.0.1")).toBe(true);

    const inA = pe2.vrfIpv6RoutingTable("customer-a")
      .filter((route) => route.network === "2001:db8:100::");
    const inB = pe2.vrfIpv6RoutingTable("customer-b")
      .filter((route) => route.network === "2001:db8:100::");
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(1);
    expect(inA[0]?.routeDistinguisher).not.toBe(inB[0]?.routeDistinguisher);

    // A VPN label is per VRF *and* address family.
    const labels = pe2.vpnLabelBindings();
    const ipv6Labels = labels.filter((entry) => entry.addressFamily === "ipv6").map((entry) => entry.label);
    expect(new Set(ipv6Labels).size).toBe(ipv6Labels.length);
    for (const vrfId of ["customer-a", "customer-b"]) {
      const ipv4 = labels.find((entry) => entry.vrfId === vrfId && entry.addressFamily === "ipv4")?.label;
      const ipv6 = labels.find((entry) => entry.vrfId === vrfId && entry.addressFamily === "ipv6")?.label;
      expect(ipv6).toBeDefined();
      if (ipv4 !== undefined) expect(ipv6).not.toBe(ipv4);
    }

    // A P router performs MPLS forwarding only.
    const p = built.getRouter("p")!;
    expect(p.vrfConfigurations()).toHaveLength(0);
    expect(p.ipv6RoutingTable().some((route) => route.network.startsWith("2001:db8:"))).toBe(false);
  });
});
