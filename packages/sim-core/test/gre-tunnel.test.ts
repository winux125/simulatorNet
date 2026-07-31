import {
  Firewall,
  IspCloud,
  Layer3Switch,
  Pc,
  Router,
  VpnConfigurationError,
  createSimulationEngine,
  macFromIndex,
  parseTunnelName,
  tunnelName,
  validateTunnel,
  type GreTunnelConfiguration,
  type SimulationEngine,
  type TraceEntry,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

/**
 * LAN A — R1 — ISP — R2 — LAN B, with a GRE tunnel between the two routers'
 * WAN addresses. The ISP has no idea the overlay exists: it only ever sees
 * outer 203.0.113.x traffic with protocol GRE.
 */
interface SiteToSiteLab {
  engine: SimulationEngine;
  r1: Router;
  r2: Router;
  isp: IspCloud;
  pcA: Pc;
  pcB: Pc;
}

function buildSiteToSite(options: { tunnelMtu?: number; ipv6?: boolean } = {}): SiteToSiteLab {
  const engine = createSimulationEngine({ seed: 10_900 });
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

  // Underlay addressing.
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

  // Overlay: Tunnel0 on each side, addressed out of 10.255.0.0/30.
  const mtu = options.tunnelMtu ?? 1_476;
  r1.configureTunnel(0, {
    source: { type: "interface", interfaceId: "Gi0/1" },
    destinationAddress: "203.0.113.6",
    ipv4Addresses: [{ address: "10.255.0.1", prefixLength: 30 }],
    ipv6Addresses: options.ipv6 ? [{ address: "2001:db8:ffff::1", prefixLength: 64 }] : [],
    mtu,
  });
  r2.configureTunnel(0, {
    source: { type: "interface", interfaceId: "Gi0/1" },
    destinationAddress: "203.0.113.1",
    ipv4Addresses: [{ address: "10.255.0.2", prefixLength: 30 }],
    ipv6Addresses: options.ipv6 ? [{ address: "2001:db8:ffff::2", prefixLength: 64 }] : [],
    mtu,
  });
  // Overlay routes: the remote LAN is reached through the tunnel next hop.
  r1.addStaticRoute("10.2.0.0", 24, "10.255.0.2");
  r2.addStaticRoute("10.1.0.0", 24, "10.255.0.1");

  if (options.ipv6) {
    r1.setIpv6ForwardingEnabled(true);
    r2.setIpv6ForwardingEnabled(true);
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:1::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:2::1", 64);
    r1.addIpv6StaticRoute("2001:db8:2::", 64, "2001:db8:ffff::2");
    r2.addIpv6StaticRoute("2001:db8:1::", 64, "2001:db8:ffff::1");
    pcA.configureIpv6Static("2001:db8:1::10", 64, "2001:db8:1::1");
    pcB.configureIpv6Static("2001:db8:2::10", 64, "2001:db8:2::1");
  }

  engine.enableTrace();
  engine.runUntilIdle();
  return { engine, r1, r2, isp, pcA, pcB };
}

const typesOf = (trace: readonly TraceEntry[]): string[] => trace.map((entry) => entry.type);

describe("GRE tunnel interfaces", () => {
  it("names, parses and defaults a logical tunnel with no cable", () => {
    const engine = createSimulationEngine({ seed: 1 });
    const router = engine.add(new Router("r1", "R1"));
    const iface = router.getOrCreateTunnel(0);

    expect(tunnelName(0)).toBe("Tunnel0");
    expect(parseTunnelName("Tunnel12")).toBe(12);
    expect(parseTunnelName("Gi0/0")).toBeUndefined();
    expect(iface.name).toBe("Tunnel0");
    expect(router.isTunnel("Tunnel0")).toBe(true);
    // A tunnel is logical: it is never a cabled port on the canvas.
    expect(router.getInterface("Tunnel0")).toBeUndefined();
    expect(router.tunnelNumbers()).toEqual([0]);
  });

  it.each([
    ["router", () => new Router("d", "D"), true],
    ["firewall", () => new Firewall("d", "D"), true],
    ["cloud", () => new IspCloud("d", "D"), false],
  ] as const)("supports tunnels on a %s: %s", (_kind, create, supported) => {
    const engine = createSimulationEngine({ seed: 2 });
    const device = engine.add(create());
    expect(device.supportsTunnels()).toBe(supported);
    if (supported) expect(() => device.getOrCreateTunnel(0)).not.toThrow();
    else expect(() => device.getOrCreateTunnel(0)).toThrow(VpnConfigurationError);
  });

  it("does not expose a tunnel API on an L3 switch", () => {
    const engine = createSimulationEngine({ seed: 3 });
    const device = engine.add(new Layer3Switch("sw", "SW"));
    expect("getOrCreateTunnel" in device).toBe(false);
  });

  // --- table-driven tunnel validation ---------------------------------------
  const base: GreTunnelConfiguration = {
    id: "Tunnel0",
    source: { type: "interface", interfaceId: "Gi0/1" },
    destinationAddress: "203.0.113.6",
    mode: "gre-ipv4",
    ipv4Addresses: [{ address: "10.255.0.1", prefixLength: 30 }],
    ipv6Addresses: [],
    mtu: 1_476,
    ttl: 255,
    adminUp: true,
  };

  it.each([
    ["accepts a well-formed tunnel", base, undefined],
    ["rejects a non-tunnel interface name", { ...base, id: "Gi0/1" }, "must be Tunnel"],
    ["rejects an unsupported mode", { ...base, mode: "gre-ipv6" }, "gre-ipv4"],
    ["rejects an empty source interface", { ...base, source: { type: "interface", interfaceId: " " } }, "source interface"],
    ["rejects a malformed source address", { ...base, source: { type: "address", address: "10.0.0.300" } }, "source address"],
    ["rejects a malformed destination", { ...base, destinationAddress: "not-an-ip" }, "destination"],
    ["rejects an MTU below the floor", { ...base, mtu: 100 }, "MTU"],
    ["rejects an MTU above the ceiling", { ...base, mtu: 20_000 }, "MTU"],
    ["rejects a zero TTL", { ...base, ttl: 0 }, "TTL"],
    ["rejects a TTL above 255", { ...base, ttl: 300 }, "TTL"],
    [
      "rejects a destination inside its own overlay subnet",
      { ...base, destinationAddress: "10.255.0.2" },
      "inside its own overlay subnet",
    ],
  ] as const)("%s", (_label, configuration, expected) => {
    if (expected === undefined) {
      expect(validateTunnel(configuration as GreTunnelConfiguration).id).toBe("Tunnel0");
      return;
    }
    expect(() => validateTunnel(configuration as GreTunnelConfiguration))
      .toThrow(new RegExp(expected, "iu"));
  });

  // --- operational state ----------------------------------------------------
  it.each([
    ["is up with a usable source and a routed destination", (_lab: SiteToSiteLab) => {}, true, undefined],
    [
      "is down when administratively shut down",
      (lab: SiteToSiteLab) => lab.r1.configureTunnel(0, { adminUp: false }),
      false,
      "administratively-down",
    ],
    [
      "is down when the source interface has no usable address",
      (lab: SiteToSiteLab) => lab.r1.getInterface("Gi0/1")!.shutdown(),
      false,
      "source-unavailable",
    ],
    [
      "is down when the underlay has no route to the destination",
      (lab: SiteToSiteLab) => lab.r1.configureTunnel(0, { destinationAddress: "198.51.100.9" }),
      false,
      "destination-unreachable",
    ],
  ] as const)("%s", (_label, mutate, up, reason) => {
    const lab = buildSiteToSite();
    mutate(lab);
    const summary = lab.r1.tunnelSummaries()[0]!;
    expect(summary.operUp).toBe(up);
    expect(summary.reason).toBe(reason);
  });

  it("rejects a recursive underlay route through the tunnel itself", () => {
    const lab = buildSiteToSite();
    // Route the tunnel destination back through the overlay: the tunnel must
    // refuse rather than encapsulate its own outer packet forever.
    lab.r1.addStaticRoute("203.0.113.6", 32, "10.255.0.2");
    const summary = lab.r1.tunnelSummaries()[0]!;
    expect(summary.operUp).toBe(false);
    expect(summary.reason).toBe("recursive-route");
    expect(lab.r1.routingTable().some((row) => row.egressName === "Tunnel0" && row.kind === "connected"))
      .toBe(false);
  });

  it("produces a connected overlay route and reports the resolved source", () => {
    const lab = buildSiteToSite();
    const summary = lab.r1.tunnelSummaries()[0]!;
    expect(summary).toMatchObject({
      name: "Tunnel0",
      sourceAddress: "203.0.113.1",
      destinationAddress: "203.0.113.6",
      mode: "gre-ipv4",
      operUp: true,
      protected: false,
      ipv4: { address: "10.255.0.1", prefixLength: 30 },
    });
    expect(lab.r1.routingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "connected", network: "10.255.0.0", egressName: "Tunnel0" }),
    ]));
  });

  // --- data plane -----------------------------------------------------------
  it("carries an IPv4 payload end to end and leaves only GRE on the underlay", () => {
    const lab = buildSiteToSite();
    lab.engine.traceLog.length = 0;
    lab.pcA.ping("10.2.0.10", 1);
    lab.engine.runUntilIdle();

    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 1)?.success).toBe(true);
    const types = typesOf(lab.engine.traceLog);
    expect(types).toEqual(expect.arrayContaining([
      "gre-encapsulation-started",
      "gre-packet-sent",
      "gre-packet-received",
      "gre-decapsulated",
    ]));
    // The provider only ever routed the outer packet.
    const ispRoutes = lab.engine.traceLog.filter((entry) => entry.device === "isp" && entry.type === "route");
    expect(ispRoutes.length).toBeGreaterThan(0);
    for (const entry of ispRoutes) {
      expect(["203.0.113.1", "203.0.113.6"]).toContain(entry.detail?.dst as string);
    }
  });

  it("carries an IPv6 payload over the same IPv4 underlay tunnel", () => {
    const lab = buildSiteToSite({ ipv6: true });
    lab.engine.traceLog.length = 0;
    lab.pcA.ping6("2001:db8:2::10", 1);
    lab.engine.runUntilIdle();

    expect(lab.pcA.ipv6PingResults.find((entry) => entry.sequence === 1)?.success).toBe(true);
    const decapsulated = lab.engine.traceLog.filter((entry) => entry.type === "gre-decapsulated");
    expect(decapsulated.length).toBeGreaterThan(0);
    expect(decapsulated.some((entry) => entry.detail?.innerProtocol === "ipv6")).toBe(true);
  });

  it("drops a packet larger than the tunnel MTU and reports it, without fragmenting", () => {
    const lab = buildSiteToSite({ tunnelMtu: 600 });
    lab.engine.traceLog.length = 0;
    lab.pcA.ping("10.2.0.10", 7, { payloadBytes: 1_200 });
    lab.engine.runUntilIdle();

    const exceeded = lab.engine.traceLog.filter((entry) => entry.type === "gre-mtu-exceeded");
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]!.detail).toMatchObject({ tunnel: "Tunnel0", mtu: 600 });
    expect(typesOf(lab.engine.traceLog)).not.toContain("gre-decapsulated");
    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 7)?.success).not.toBe(true);
  });

  it("drops traffic and traces the reason when the tunnel is down", () => {
    const lab = buildSiteToSite();
    lab.r1.configureTunnel(0, { adminUp: false });
    lab.engine.traceLog.length = 0;
    // The overlay route is gone with the tunnel, so nothing reaches the peer.
    lab.pcA.ping("10.2.0.10", 2);
    lab.engine.runUntilIdle();

    expect(typesOf(lab.engine.traceLog)).not.toContain("gre-packet-sent");
    expect(lab.pcA.pingResults.find((entry) => entry.sequence === 2)?.success).not.toBe(true);
  });

  it("ignores a GRE packet from an unexpected peer", () => {
    const lab = buildSiteToSite();
    // R2 believes its peer is R1; a packet claiming a different source is not ours.
    lab.r2.configureTunnel(0, { destinationAddress: "198.51.100.7" });
    lab.engine.traceLog.length = 0;
    lab.pcA.ping("10.2.0.10", 3);
    lab.engine.runUntilIdle();

    const rejected = lab.engine.traceLog.filter((entry) =>
      entry.device === "r2" && entry.type === "gre-tunnel-down");
    expect(rejected.length).toBeGreaterThan(0);
    expect(typesOf(lab.engine.traceLog)).not.toContain("gre-decapsulated");
  });

  it("keeps tunnel configuration free of runtime state", () => {
    const lab = buildSiteToSite();
    lab.pcA.ping("10.2.0.10", 4);
    lab.engine.runUntilIdle();

    const [tunnel] = lab.r1.tunnelConfigurations();
    expect(tunnel).toEqual({
      id: "Tunnel0",
      source: { type: "interface", interfaceId: "Gi0/1" },
      destinationAddress: "203.0.113.6",
      mode: "gre-ipv4",
      ipv4Addresses: [{ address: "10.255.0.1", prefixLength: 30 }],
      ipv6Addresses: [],
      mtu: 1_476,
      ttl: 255,
      adminUp: true,
    });
    expect(Object.keys(tunnel!)).not.toEqual(expect.arrayContaining(["counters", "peerState", "queue"]));
  });

  it("removes a tunnel with its overlay route and ACL bindings", () => {
    const lab = buildSiteToSite();
    lab.r1.defineAcl({ id: "OVERLAY", type: "standard", rules: [] });
    lab.r1.applyAcl("Tunnel0", "in", "OVERLAY");
    lab.r1.removeTunnel(0);

    expect(lab.r1.tunnelConfigurations()).toEqual([]);
    expect(lab.r1.isTunnel("Tunnel0")).toBe(false);
    expect(lab.r1.aclBindings()).toEqual([]);
    expect(lab.r1.routingTable().some((row) => row.egressName === "Tunnel0")).toBe(false);
  });

  it("runs OSPFv2 over the GRE point-to-point overlay", () => {
    const lab = buildSiteToSite();
    for (const router of [lab.r1, lab.r2]) {
      router.ospf.createProcess(1);
      router.ospf.configureInterface("Tunnel0", { area: 0, networkType: "point-to-point", enabled: true });
      router.ospf.configureInterface("Gi0/0", { area: 0, enabled: true });
    }
    lab.r1.ospf.setRouterId("1.1.1.1");
    lab.r2.ospf.setRouterId("2.2.2.2");
    lab.engine.runUntilIdle();

    expect(lab.r1.ospf.neighborSummaries()).toEqual([
      expect.objectContaining({ state: "full", interfaceId: "Tunnel0", address: "10.255.0.2" }),
    ]);
    expect(lab.r1.ospf.routeTable().some((route) => route.network === "10.2.0.0")).toBe(true);
  });
});
