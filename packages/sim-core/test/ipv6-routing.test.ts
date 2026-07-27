import type { ServerServiceConfig } from "@sim/contracts";
import {
  L2Switch,
  Layer3Switch,
  Pc,
  Router,
  Server,
  createSimulationEngine,
  macFromIndex,
} from "@sim/sim-core";
import { describe, expect, it } from "vitest";

const HTTP_SERVICE: ServerServiceConfig = {
  id: "http-v6",
  type: "http",
  enabled: true,
  port: 80,
  resources: [{ path: "/", contentType: "text/plain", body: "hello over ipv6" }],
};

describe("IPv6 autoconfiguration and shared transport", () => {
  it("derives a SLAAC address and default router from a bounded Router Advertisement", () => {
    const engine = createSimulationEngine({ seed: 510 });
    const router = engine.add(new Router("r1", "R1"));
    const pc = engine.add(new Pc("pc1", "PC1"));
    router.addInterface("Gi0/0", macFromIndex(100));
    pc.addInterface("eth0", macFromIndex(1));
    engine.connect(router.id, "Gi0/0", pc.id, "eth0");
    router.getOrCreateInterface("Gi0/0");
    router.setInterfaceIpv6("Gi0/0", "2001:db8:10::1", 64);
    router.configureRouterAdvertisement("Gi0/0", {
      prefixes: [{
        prefix: "2001:db8:10::",
        prefixLength: 64,
        autonomous: true,
        onLink: true,
        preferredLifetimeNs: 600_000_000_000,
        validLifetimeNs: 1_200_000_000_000,
      }],
    });
    pc.setIpv6Mode("slaac");

    engine.runUntilIdle();

    expect(pc.ipv6AddressSummaries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        address: expect.stringMatching(/^2001:db8:10:/),
        source: "slaac",
        state: "preferred",
      }),
    ]));
    expect(pc.ipv6DefaultRouter).toMatch(/^fe80:/);
  });

  it.each(["router", "server"] as const)(
    "obtains a stateful DHCPv6 address and DNS option from a %s",
    (providerType) => {
    const engine = createSimulationEngine({ seed: 511 });
    const pc = engine.add(new Pc("pc1", "PC1"));
    pc.addInterface("eth0", macFromIndex(1));
    const provider = providerType === "router"
      ? engine.add(new Router("provider", "R1"))
      : engine.add(new Server("provider", "SRV1"));
    provider.addInterface(providerType === "router" ? "Gi0/0" : "eth0", macFromIndex(100));
    const providerInterface = providerType === "router" ? "Gi0/0" : "eth0";
    engine.connect(provider.id, providerInterface, pc.id, "eth0");
    if (provider instanceof Router) {
      provider.getOrCreateInterface(providerInterface);
      provider.setInterfaceIpv6(providerInterface, "2001:db8:20::1", 64);
      provider.configureRouterAdvertisement(providerInterface, { managed: true, prefixes: [] });
    } else {
      provider.configureIpv6Static("2001:db8:20::1", 64);
    }
    provider.addDhcpv6Pool({
      id: "lan20",
      prefix: "2001:db8:20::",
      prefixLength: 64,
      rangeStart: "2001:db8:20::100",
      rangeEnd: "2001:db8:20::10f",
      dnsServers: ["2001:db8:20::53"],
    });
    pc.setIpv6Mode("dhcpv6");

    engine.runUntilIdle();

    expect(pc.dhcpv6State).toBe("bound");
    expect(pc.dhcpv6Lease).toMatchObject({ address: "2001:db8:20::100", prefixLength: 64 });
    expect(pc.ipv6DnsServer).toBe("2001:db8:20::53");
    },
  );

  it("uses the same TCP/HTTP service implementation over IPv6", () => {
    const engine = createSimulationEngine({ seed: 512 });
    const sw = engine.add(new L2Switch("sw1", "SW1"));
    const pc = engine.add(new Pc("pc1", "PC1"));
    const server = engine.add(new Server("server1", "SRV1"));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    pc.addInterface("eth0", macFromIndex(1));
    server.addInterface("eth0", macFromIndex(2));
    engine.connect(pc.id, "eth0", sw.id, "Gi0/1");
    engine.connect(server.id, "eth0", sw.id, "Gi0/2");
    pc.configureIpv6Static("2001:db8:30::10", 64);
    server.configureIpv6Static("2001:db8:30::20", 64);
    server.configureServices([HTTP_SERVICE]);
    engine.runUntilIdle();

    pc.applications.httpGet("http://[2001:db8:30::20]/");
    engine.runUntilIdle();

    expect(pc.applications.httpResults.at(-1)).toMatchObject({
      status: "completed",
      statusCode: 200,
      body: "hello over ipv6",
    });
  });

  it("expires SLAAC preferred and valid state only through virtual time", () => {
    const engine = createSimulationEngine({ seed: 515 });
    const router = engine.add(new Router("r1", "R1"));
    const pc = engine.add(new Pc("pc1", "PC1"));
    router.addInterface("Gi0/0", macFromIndex(100));
    pc.addInterface("eth0", macFromIndex(1));
    engine.connect(router.id, "Gi0/0", pc.id, "eth0");
    router.getOrCreateInterface("Gi0/0");
    router.configureRouterAdvertisement("Gi0/0", {
      prefixes: [{
        prefix: "2001:db8:50::",
        prefixLength: 64,
        autonomous: true,
        onLink: true,
        preferredLifetimeNs: 2_000_000_000,
        validLifetimeNs: 5_000_000_000,
      }],
    });
    pc.setIpv6Mode("slaac");
    engine.runUntilIdle();
    const learned = pc.ipv6AddressSummaries().find((entry) => entry.source === "slaac")!;

    engine.advanceTo(engine.now() + 2_000_000_000);
    expect(pc.ipv6AddressSummaries().find((entry) => entry.address === learned.address)?.state).toBe("deprecated");
    engine.advanceTo(engine.now() + 4_000_000_000);
    expect(pc.ipv6AddressSummaries().find((entry) => entry.address === learned.address)).toBeUndefined();
  });
});

describe("IPv6 router forwarding", () => {
  it("uses longest-prefix static routes across two routers", () => {
    const engine = createSimulationEngine({ seed: 513 });
    const r1 = engine.add(new Router("r1", "R1"));
    const r2 = engine.add(new Router("r2", "R2"));
    for (const [router, base] of [[r1, 200], [r2, 210]] as const) {
      router.addInterface("Gi0/0", macFromIndex(base));
      router.addInterface("Gi0/1", macFromIndex(base + 1));
      router.getOrCreateInterface("Gi0/0");
      router.getOrCreateInterface("Gi0/1");
      router.setIpv6ForwardingEnabled(true);
    }
    r1.setInterfaceIpv6("Gi0/0", "2001:db8:1::1", 64);
    r1.setInterfaceIpv6("Gi0/1", "2001:db8:ff::1", 64);
    r2.setInterfaceIpv6("Gi0/0", "2001:db8:2::1", 64);
    r2.setInterfaceIpv6("Gi0/1", "2001:db8:ff::2", 64);
    r1.addIpv6StaticRoute("2001:db8:2::", 64, "2001:db8:ff::2");
    r2.addIpv6StaticRoute("2001:db8:1::", 64, "2001:db8:ff::1");
    engine.connect(r1.id, "Gi0/1", r2.id, "Gi0/1");

    const pc1 = engine.add(new Pc("pc1", "PC1"));
    const pc2 = engine.add(new Pc("pc2", "PC2"));
    pc1.addInterface("eth0", macFromIndex(1));
    pc2.addInterface("eth0", macFromIndex(2));
    pc1.configureIpv6Static("2001:db8:1::10", 64, "2001:db8:1::1");
    pc2.configureIpv6Static("2001:db8:2::10", 64, "2001:db8:2::1");
    engine.connect(pc1.id, "eth0", r1.id, "Gi0/0");
    engine.connect(pc2.id, "eth0", r2.id, "Gi0/0");
    engine.runUntilIdle();

    pc1.ping6("2001:db8:2::10", 1);
    engine.runUntilIdle();

    expect(pc1.ipv6PingResults.at(-1)).toMatchObject({ sequence: 1, success: true });
    expect(r1.ipv6RoutingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "static",
        network: "2001:db8:2::",
        prefixLength: 64,
        viaIp: "2001:db8:ff::2",
      }),
    ]));
  });

  it("routes between Layer-3 switch SVIs through the composed routing plane", () => {
    const engine = createSimulationEngine({ seed: 514 });
    const sw = engine.add(new Layer3Switch("l3", "L3SW"));
    const left = engine.add(new Pc("left", "Left"));
    const right = engine.add(new Pc("right", "Right"));
    sw.addInterface("Gi0/1", macFromIndex(101));
    sw.addInterface("Gi0/2", macFromIndex(102));
    left.addInterface("eth0", macFromIndex(1));
    right.addInterface("eth0", macFromIndex(2));
    engine.connect(left.id, "eth0", sw.id, "Gi0/1");
    engine.connect(right.id, "eth0", sw.id, "Gi0/2");
    sw.setAccess("Gi0/1", 10);
    sw.setAccess("Gi0/2", 20);
    sw.setSviIpv6(10, "2001:db8:10::1", 64);
    sw.setSviIpv6(20, "2001:db8:20::1", 64);
    sw.setIpv6Routing(true);
    left.configureIpv6Static("2001:db8:10::10", 64, "2001:db8:10::1");
    right.configureIpv6Static("2001:db8:20::10", 64, "2001:db8:20::1");
    engine.runUntilIdle();

    left.ping6("2001:db8:20::10", 2);
    engine.runUntilIdle();

    expect(left.ipv6PingResults.at(-1)).toMatchObject({ sequence: 2, success: true });
    expect(sw.ipv6RoutingTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "connected", network: "2001:db8:10::", egressName: "Vlan10" }),
      expect.objectContaining({ kind: "connected", network: "2001:db8:20::", egressName: "Vlan20" }),
    ]));
  });
});
