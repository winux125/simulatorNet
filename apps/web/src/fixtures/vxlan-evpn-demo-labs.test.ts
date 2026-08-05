import { renderDeviceConfiguration } from "@sim/device-config";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  BGP_EVPN_STRETCH_DEMO,
  STATIC_VXLAN_STRETCH_DEMO,
  VXLAN_EVPN_DEMO_LABS,
} from "./vxlan-evpn-demo-labs";

const build = (document: typeof STATIC_VXLAN_STRETCH_DEMO) =>
  buildLabFromDocument(canonicalizeLabDocument(document));

describe("M10.14 VXLAN and BGP EVPN demo labs", () => {
  it.each(VXLAN_EVPN_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s is a valid explicitly-loadable schema-v1 lab",
    (_title, document) => {
      expect(parseLabDocument(document).schemaVersion).toBe(1);
      expect(document.instructions).toContain("Objective:");
      expect(document.instructions).toContain("Troubleshooting:");
      expect(document.expectedOutcome).toBeTruthy();
    },
  );

  it("stores configuration only, never overlay runtime state", () => {
    const serialized = JSON.stringify(VXLAN_EVPN_DEMO_LABS);
    for (const forbidden of [
      "remoteMac", "adjRib", "locRib", "evpnRoutes", "replicationState",
      "lastSeenNs", "originatorId", "clusterList",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("stretches one VLAN over static VXLAN and keeps the underlay free of tenant MACs", () => {
    const built = build(STATIC_VXLAN_STRETCH_DEMO);
    built.engine.runUntilIdle();
    const vtep1 = built.getLayer3Switch("vtep1")!;
    const vtep2 = built.getLayer3Switch("vtep2")!;

    expect(vtep1.nveSummaries()[0]).toMatchObject({ up: true, sourceAddress: "10.255.0.1" });
    expect(vtep1.vniSummaries()[0]).toMatchObject({ vni: 10_010, vlanId: 10, replication: "static", up: true });
    expect(vtep1.vxlanPeerSummaries()).toEqual([
      { vni: 10_010, address: "10.255.0.2", source: "static", reachable: true },
    ]);

    const pcA = built.getPc("pc-a")!;
    built.engine.enableTrace();
    pcA.ping("192.168.10.20", 1);
    built.engine.runUntilIdle();
    expect(pcA.pingResults.at(-1)?.success).toBe(true);

    // The frame really crossed a VXLAN tunnel rather than an invisible cable.
    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types).toContain("vxlan-encapsulation-started");
    expect(types).toContain("vxlan-packet-sent");
    expect(types).toContain("vxlan-decapsulated");
    expect(types).toContain("vxlan-bum-replicated");

    // Each VTEP learned the far-end MAC behind the remote tunnel endpoint.
    expect(vtep1.remoteMacEntries().map((entry) => entry.remoteVtep)).toEqual(["10.255.0.2"]);
    expect(vtep2.remoteMacEntries().map((entry) => entry.remoteVtep)).toEqual(["10.255.0.1"]);

    // The underlay device carries the outer IPv4/UDP only: it is a Router, so
    // it is not a VTEP and holds no tenant MAC table at all.
    expect(built.getRouter("core")).toBeDefined();
    expect(built.getLayer3Switch("core")).toBeUndefined();
  });

  it("builds EVPN membership and remote MACs through a Route Reflector spine", () => {
    const built = build(BGP_EVPN_STRETCH_DEMO);
    built.engine.runUntilIdle();
    const leaf1 = built.getLayer3Switch("leaf1")!;
    const leaf2 = built.getLayer3Switch("leaf2")!;
    const spine = built.getRouter("spine")!;

    // One session per neighbor, carrying the EVPN family alongside IPv4.
    expect(spine.bgp.summaries().map((entry) => entry.state)).toEqual(["established", "established"]);
    expect(spine.bgp.summaries()[0]?.addressFamilies).toContain("l2vpn-evpn");

    // Type 3 builds head-end replication before any tenant traffic exists.
    expect(leaf1.vxlanPeerSummaries()).toEqual([
      { vni: 20_020, address: "10.255.0.2", source: "bgp-evpn", reachable: true },
    ]);
    expect(leaf2.vxlanPeerSummaries()).toEqual([
      { vni: 20_020, address: "10.255.0.1", source: "bgp-evpn", reachable: true },
    ]);
    const imet = spine.bgp.evpnRoutes().filter((route) => route.type === 3);
    expect(imet).toHaveLength(2);
    // The reflector stamps its identity onto what it passes on.
    expect(leaf1.evpnRoutes().some((route) => route.clusterList.includes("10.255.0.9"))).toBe(true);

    const hostA = built.getPc("host-a")!;
    hostA.ping("192.168.20.20", 1);
    built.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);

    // Type 2 installs each remote MAC through the control plane.
    expect(leaf1.remoteMacEntries()).toEqual([
      expect.objectContaining({ vni: 20_020, remoteVtep: "10.255.0.2", source: "bgp-evpn" }),
    ]);
    expect(spine.bgp.evpnRoutes().some((route) => route.type === 2)).toBe(true);
    // The spine reflects the routes but is not a VTEP and holds no overlay.
    expect(built.getLayer3Switch("spine")).toBeUndefined();
  });

  it("round-trips overlay configuration without persisting a single runtime table", () => {
    const built = build(BGP_EVPN_STRETCH_DEMO);
    built.engine.runUntilIdle();
    // Serializing a *converged* engine is the real test: the remote MAC table,
    // the EVPN RIB and the learned membership all exist by now.
    const serialized = serializeLabDocument(built, {
      id: BGP_EVPN_STRETCH_DEMO.id,
      title: BGP_EVPN_STRETCH_DEMO.title,
    });
    const leaf1 = serialized.configurations.leaf1!;
    expect(leaf1.kind).toBe("l3-switch");
    if (leaf1.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(leaf1.nve).toEqual({
      id: "nve1",
      sourceInterfaceId: "Loopback0",
      shutdown: false,
      members: [{ vni: 20_020, vlanId: 20, replication: { type: "bgp-evpn" } }],
    });
    expect(leaf1.evpn).toEqual({
      vnis: [{
        vni: 20_020,
        routeDistinguisher: "65000:20020",
        importRouteTargets: ["65000:20020"],
        exportRouteTargets: ["65000:20020"],
      }],
    });
    const text = JSON.stringify(serialized);
    for (const forbidden of ["remoteVtep", "lastSeenNs", "originatorId", "clusterList", "adjRib"]) {
      expect(text).not.toContain(forbidden);
    }

    // Rebuilding from the serialized document reaches the same overlay state,
    // which is what makes the browser and the verifier agree.
    const rebuilt = buildLabFromDocument(serialized);
    rebuilt.engine.runUntilIdle();
    expect(rebuilt.getLayer3Switch("leaf1")!.vxlanPeerSummaries())
      .toEqual(built.getLayer3Switch("leaf1")!.vxlanPeerSummaries());

    // The rendered projection carries the same canonical syntax, and no state.
    const rendered = renderDeviceConfiguration(leaf1);
    expect(rendered).toContain("interface nve1");
    expect(rendered).toContain("  ingress-replication protocol bgp");
    expect(rendered).toContain(" address-family l2vpn evpn");
    expect(rendered).not.toMatch(/remote vtep|last seen|adj-rib/iu);
  });
});
