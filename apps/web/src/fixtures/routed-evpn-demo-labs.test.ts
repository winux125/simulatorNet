import { renderDeviceConfiguration } from "@sim/device-config";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  ANYCAST_GATEWAY_DEMO,
  ROUTED_EVPN_DEMO_LABS,
  SYMMETRIC_IRB_DEMO,
} from "./routed-evpn-demo-labs";

const build = (document: typeof ANYCAST_GATEWAY_DEMO) =>
  buildLabFromDocument(canonicalizeLabDocument(document));

describe("M10.15 routed EVPN demo labs", () => {
  it.each(ROUTED_EVPN_DEMO_LABS.map((document) => [document.title, document] as const))(
    "%s is a valid explicitly-loadable schema-v1 lab",
    (_title, document) => {
      expect(parseLabDocument(document).schemaVersion).toBe(1);
      expect(document.instructions).toContain("Objective:");
      expect(document.instructions).toContain("Topology:");
      expect(document.instructions).toContain("Underlay:");
      expect(document.instructions).toContain("Required CLI:");
      expect(document.instructions).toContain("Expected:");
      expect(document.instructions).toContain("Troubleshooting:");
      expect(document.expectedOutcome).toBeTruthy();
    },
  );

  it("stores configuration only, never routed-overlay runtime state", () => {
    const serialized = JSON.stringify(ROUTED_EVPN_DEMO_LABS);
    for (const forbidden of [
      "importedEvpn", "remoteVtep", "originatorId", "clusterList", "locRib",
      "adjRib", "lastSeenNs", "l3VniState", "type5",
    ]) expect(serialized).not.toContain(forbidden);
  });

  // --- Demo 1: distributed anycast gateway --------------------------------

  it("presents one gateway IPv4 and one gateway MAC on both leaves", () => {
    const built = build(ANYCAST_GATEWAY_DEMO);
    built.engine.runUntilIdle();
    const leaf1 = built.getLayer3Switch("leaf1")!;
    const leaf2 = built.getLayer3Switch("leaf2")!;

    // The same VLAN, the same L2VNI, the same gateway address on both leaves.
    expect(leaf1.vniSummaries()[0]).toMatchObject({ vni: 10_010, vlanId: 10, up: true });
    expect(leaf2.vniSummaries()[0]).toMatchObject({ vni: 10_010, vlanId: 10, up: true });
    expect(leaf1.sviSummaries()[0]?.ip).toBe("10.10.10.1");
    expect(leaf2.sviSummaries()[0]?.ip).toBe("10.10.10.1");
    expect(leaf1.fabricConfiguration().anycastGatewayMac)
      .toBe(leaf2.fabricConfiguration().anycastGatewayMac);
    expect(leaf1.anycastGatewayVlanIds()).toEqual([10]);
    expect(leaf2.anycastGatewayVlanIds()).toEqual([10]);
  });

  it("answers the gateway on the host's own local leaf and never across the fabric", () => {
    const built = build(ANYCAST_GATEWAY_DEMO);
    built.engine.runUntilIdle();
    built.engine.enableTrace();

    // Each host reaches the very same gateway address, answered locally.
    for (const [id, gateway] of [["host-a", "10.10.10.1"], ["host-b", "10.10.10.1"]] as const) {
      const pc = built.getPc(id)!;
      pc.ping(gateway, 1);
      built.engine.runUntilIdle();
      expect(pc.pingResults.at(-1)?.success, `${id} reaches its local gateway`).toBe(true);
    }
    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types).toContain("evpn-anycast-gateway-replied");

    // A host always talks to its own leaf, so both keep the same gateway MAC.
    const anycastMac = built.getLayer3Switch("leaf1")!.fabricConfiguration().anycastGatewayMac!;
    expect(built.getPc("host-a")!.arpTable.get("10.10.10.1")).toBe(anycastMac);
    expect(built.getPc("host-b")!.arpTable.get("10.10.10.1")).toBe(anycastMac);
  });

  it("builds Type 3 membership and Type 2 MACs, but never advertises the gateway MAC", () => {
    const built = build(ANYCAST_GATEWAY_DEMO);
    built.engine.runUntilIdle();
    const leaf1 = built.getLayer3Switch("leaf1")!;

    expect(leaf1.vxlanPeerSummaries()).toEqual([
      { vni: 10_010, address: "10.255.0.2", source: "bgp-evpn", reachable: true },
    ]);

    built.getPc("host-a")!.ping("10.10.10.20", 1);
    built.engine.runUntilIdle();
    expect(built.getPc("host-a")!.pingResults.at(-1)?.success).toBe(true);

    const routes = leaf1.evpnRoutes();
    expect(routes.some((route) => route.type === 3)).toBe(true);
    expect(routes.some((route) => route.type === 2)).toBe(true);
    // Every leaf owns the anycast MAC, so no VTEP may claim it as a Type 2.
    const anycastMac = leaf1.fabricConfiguration().anycastGatewayMac!;
    expect(routes.some((route) => route.type === 2 && route.macAddress === anycastMac)).toBe(false);
  });

  // --- Demo 2: symmetric IRB and Type 5 -----------------------------------

  it("originates, reflects and imports a Type 5 prefix per tenant", () => {
    const built = build(SYMMETRIC_IRB_DEMO);
    built.engine.runUntilIdle();
    const leaf1 = built.getLayer3Switch("leaf1")!;
    const leaf2 = built.getLayer3Switch("leaf2")!;
    const spine = built.getRouter("spine")!;

    expect(leaf1.l3VniSummaries()).toEqual([
      expect.objectContaining({ vni: 50_001, vrfId: "TENANT-A", up: true }),
      expect.objectContaining({ vni: 50_002, vrfId: "TENANT-B", up: true }),
    ]);

    // Each leaf advertises its own connected tenant prefix, and only that.
    const originated = leaf1.evpnRoutes()
      .flatMap((route) => (route.type === 5 && route.source === "local"
        ? [`${route.network}/${route.prefixLength}`]
        : []));
    expect(originated).toContain("10.10.10.0/24");
    expect(originated).not.toContain("10.20.20.0/24");

    // The reflector passes Type 5 on, stamping its own identity.
    expect(spine.bgp.evpnRoutes().some((route) => route.type === 5)).toBe(true);
    expect(leaf2.evpnRoutes().some((route) => route.type === 5 && route.clusterList.includes("10.255.0.9")))
      .toBe(true);

    // The remote prefix becomes tenant forwarding state on the far leaf.
    expect(leaf2.importedEvpnRoutes("TENANT-A")).toEqual([expect.objectContaining({
      network: "10.10.10.0",
      prefixLength: 24,
      source: "evpn-type5",
      remoteVtep: "10.255.0.1",
      l3Vni: 50_001,
    })]);
  });

  it("routes symmetrically in both directions and keeps TENANT-B isolated", () => {
    const built = build(SYMMETRIC_IRB_DEMO);
    built.engine.runUntilIdle();
    built.engine.enableTrace();

    const hostA = built.getPc("host-a")!;
    hostA.ping("10.20.20.20", 1);
    built.engine.runUntilIdle();
    expect(hostA.pingResults.at(-1)?.success).toBe(true);

    const hostB = built.getPc("host-b")!;
    hostB.ping("10.10.10.10", 1);
    built.engine.runUntilIdle();
    expect(hostB.pingResults.at(-1)?.success).toBe(true);

    // Both ends routed, and the transit was the L3VNI rather than an L2VNI.
    const types = new Set(built.engine.traceLog.map((entry) => entry.type));
    expect(types).toContain("evpn-irb-routed");
    expect(types).toContain("evpn-l3vni-encapsulated");
    expect(types).toContain("evpn-l3vni-decapsulated");

    // TENANT-B shares no route target with TENANT-A, so it installs nothing
    // of it — and a TENANT-B host cannot reach a TENANT-A one.
    const leaf2 = built.getLayer3Switch("leaf2")!;
    expect(leaf2.vrfRoutingTable("TENANT-B").some((route) => route.network === "10.10.10.0")).toBe(false);
    const hostC = built.getPc("host-c")!;
    hostC.ping("10.10.10.10", 1);
    built.engine.runUntilIdle();
    expect(hostC.pingResults.at(-1)?.success).toBe(false);
  });

  it("keeps the spine an underlay reflector with no tenant forwarding state", () => {
    const built = build(SYMMETRIC_IRB_DEMO);
    built.engine.runUntilIdle();
    built.getPc("host-a")!.ping("10.20.20.20", 1);
    built.engine.runUntilIdle();

    // A Route Reflector is never a VTEP: no overlay, no VRF, no tenant route.
    expect(built.getLayer3Switch("spine")).toBeUndefined();
    const spine = built.getRouter("spine")!;
    expect(spine.vrfConfigurations()).toEqual([]);
    const tenantPrefixes = ["10.10.10.0", "10.20.20.0", "172.16.10.0", "172.16.20.0"];
    for (const route of spine.routingTable()) {
      expect(tenantPrefixes).not.toContain(route.network);
    }
  });

  it("round-trips the routed overlay without persisting a single runtime table", () => {
    const built = build(SYMMETRIC_IRB_DEMO);
    built.engine.runUntilIdle();
    built.getPc("host-a")!.ping("10.20.20.20", 1);
    built.engine.runUntilIdle();

    // Serializing a *converged* engine is the real test: the imported Type 5
    // prefixes, the EVPN RIB and the anycast state all exist by now.
    const serialized = serializeLabDocument(built, {
      id: SYMMETRIC_IRB_DEMO.id,
      title: SYMMETRIC_IRB_DEMO.title,
    });
    const leaf1 = serialized.configurations.leaf1!;
    if (leaf1.kind !== "l3-switch") throw new Error("expected an L3 Switch configuration");
    expect(leaf1.nve?.vrfMembers).toEqual([
      { vni: 50_001, vrfId: "TENANT-A" },
      { vni: 50_002, vrfId: "TENANT-B" },
    ]);
    expect(leaf1.evpn?.anycastGatewayMac).toBe("02:00:00:ff:00:01");
    expect(leaf1.svis).toEqual([
      expect.objectContaining({ vlanId: 10, ipAddress: "10.10.10.1", vrfId: "TENANT-A", anycastGateway: true }),
      expect.objectContaining({ vlanId: 110, ipAddress: "172.16.10.1", vrfId: "TENANT-B", anycastGateway: true }),
    ]);
    const text = JSON.stringify(serialized);
    for (const forbidden of ["remoteVtep", "evpn-type5", "clusterList", "originatorId", "lastSeenNs"]) {
      expect(text).not.toContain(forbidden);
    }

    // Rebuilding reaches the same routed state, which is what makes the
    // browser worker and the verifier agree.
    const rebuilt = buildLabFromDocument(serialized);
    rebuilt.engine.runUntilIdle();
    expect(rebuilt.getLayer3Switch("leaf2")!.importedEvpnRoutes("TENANT-A"))
      .toEqual(built.getLayer3Switch("leaf2")!.importedEvpnRoutes("TENANT-A"));

    // The rendered projection carries the same canonical syntax, and no state.
    const rendered = renderDeviceConfiguration(leaf1);
    expect(rendered).toContain("fabric forwarding anycast-gateway-mac 02:00:00:ff:00:01");
    expect(rendered).toContain("interface Vlan10");
    expect(rendered).toContain(" fabric forwarding mode anycast-gateway");
    expect(rendered).toContain(" member vni 50001 associate-vrf TENANT-A");
    expect(rendered).toContain("  advertise l2vpn evpn");
    expect(rendered).not.toMatch(/imported|remote vtep|cluster list/iu);
  });
});
