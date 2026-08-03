import { describe, expect, it } from "vitest";
import {
  ControlProtocolConfigurationError,
  Router,
  applyCommunitySet,
  communityBlocksAdvertisement,
  createSimulationEngine,
  macFromIndex,
  normalizeBgpCommunities,
  parseBgpCommunity,
} from "@sim/sim-core";

/**
 * CUSTOMER (AS65001) tags its LAN on the way out, PROVIDER (AS65000) holds it
 * and may hand it to its iBGP peer CORE and to the eBGP upstream UPSTREAM
 * (AS65002). That single chain exercises every advertisement rule once.
 */
function communityChain(options: {
  readonly communities?: readonly string[];
  readonly sendToUpstream?: boolean;
  readonly sendToCore?: boolean;
} = {}) {
  const engine = createSimulationEngine({ seed: 10_130 });
  engine.enableTrace();
  const add = (id: string, base: number, ports: number) => {
    const router = engine.add(new Router(id, id.toUpperCase()));
    for (let index = 0; index < ports; index++) router.addInterface(`Gi0/${index}`, macFromIndex(base + index));
    return router;
  };
  const customer = add("customer", 1, 1);
  const provider = add("provider", 10, 3);
  const core = add("core", 20, 1);
  const upstream = add("upstream", 30, 1);

  customer.getOrCreateLoopback(0);
  customer.setInterfaceIp("Loopback0", "198.51.100.1", 24);
  customer.configureInterface("Gi0/0", { ip: "10.0.1.1", mask: 30 });
  provider.configureInterface("Gi0/0", { ip: "10.0.1.2", mask: 30 });
  provider.configureInterface("Gi0/1", { ip: "10.0.2.1", mask: 30 });
  provider.configureInterface("Gi0/2", { ip: "10.0.3.1", mask: 30 });
  core.configureInterface("Gi0/0", { ip: "10.0.2.2", mask: 30 });
  upstream.configureInterface("Gi0/0", { ip: "10.0.3.2", mask: 30 });
  engine.connect("customer", "Gi0/0", "provider", "Gi0/0");
  engine.connect("provider", "Gi0/1", "core", "Gi0/0");
  engine.connect("provider", "Gi0/2", "upstream", "Gi0/0");

  if (options.communities) {
    customer.bgp.routingPolicy.setRouteMaps([{
      id: "TAG",
      sequences: [{ sequence: 10, action: "permit", set: { communities: options.communities } }],
    }]);
  }
  customer.bgp.configure({
    localAs: 65_001,
    routerId: "1.1.1.1",
    neighbors: [{
      address: "10.0.1.2",
      remoteAs: 65_000,
      sendCommunityStandard: true,
      routeMapOut: options.communities ? "TAG" : undefined,
    }],
    networks: [{ network: "198.51.100.0", prefixLength: 24 }],
  });
  provider.bgp.configure({
    localAs: 65_000,
    routerId: "2.2.2.2",
    neighbors: [
      { address: "10.0.1.1", remoteAs: 65_001, sendCommunityStandard: true },
      { address: "10.0.2.2", remoteAs: 65_000, nextHopSelf: true, sendCommunityStandard: options.sendToCore !== false },
      { address: "10.0.3.2", remoteAs: 65_002, sendCommunityStandard: options.sendToUpstream !== false },
    ],
  });
  core.bgp.configure({ localAs: 65_000, routerId: "3.3.3.3", neighbors: [{ address: "10.0.2.1", remoteAs: 65_000 }] });
  upstream.bgp.configure({ localAs: 65_002, routerId: "4.4.4.4", neighbors: [{ address: "10.0.3.1", remoteAs: 65_000 }] });
  engine.runUntilIdle();
  return { engine, customer, provider, core, upstream };
}

function received(device: Router): Record<string, readonly string[]> {
  return Object.fromEntries(device.bgp.adjRibInEntries()
    .filter((route) => route.network === "198.51.100.0")
    .map((route) => [`${route.network}/${route.prefixLength}`, route.communities]));
}

describe("BGP standard community model", () => {
  it.each([
    ["65000:100", "65000:100"],
    [" 65000:0100 ", "65000:100"],
    ["NO-EXPORT", "no-export"],
    ["no-advertise", "no-advertise"],
    ["internet", "internet"],
    ["0:0", "internet"],
    ["65535:65281", "no-export"],
  ])("parses %s as %s", (input, expected) => {
    expect(parseBgpCommunity(input)).toBe(expected);
  });

  it.each(["65000", "65000:100:1", "70000:1", "65000:70000", "", "no-peer", "-1:1"])(
    "rejects the unsupported community %s",
    (input) => expect(() => parseBgpCommunity(input)).toThrow(ControlProtocolConfigurationError),
  );

  it("normalizes to a deduplicated, deterministically sorted set", () => {
    expect(normalizeBgpCommunities(["no-export", "65000:200", "65000:100", "65000:100", "internet"]))
      .toEqual(["internet", "65000:100", "65000:200", "no-export"]);
    expect(normalizeBgpCommunities(undefined)).toEqual([]);
  });

  it.each([
    ["replaces without additive", ["65000:1"], { communities: ["65000:2"] }, ["65000:2"]],
    ["merges with additive", ["65000:1"], { communities: ["65000:2"], communityAdditive: true }, ["65000:1", "65000:2"]],
    ["deduplicates and re-sorts", ["65000:2"], { communities: ["65000:2", "65000:1"], communityAdditive: true }, ["65000:1", "65000:2"]],
    ["clears with none", ["65000:1", "no-export"], { communityNone: true }, []],
    ["leaves the set alone when unset", ["65000:1"], {}, ["65000:1"]],
  ])("%s", (_name, current, set, expected) => {
    expect(applyCommunitySet(current, set)).toEqual(expected);
  });

  it.each([
    ["no-advertise blocks an iBGP peer", ["no-advertise"], true, "no-advertise"],
    ["no-advertise blocks an eBGP peer", ["no-advertise"], false, "no-advertise"],
    ["no-export blocks an eBGP peer", ["no-export"], false, "no-export"],
    ["no-export allows an iBGP peer", ["no-export"], true, undefined],
    ["internet advertises normally", ["internet"], false, undefined],
  ])("%s", (_name, communities, peerIsIbgp, expected) => {
    expect(communityBlocksAdvertisement(communities, peerIsIbgp)).toBe(expected);
  });
});

describe("BGP community advertisement behaviour", () => {
  it("carries communities through Adj-RIB-In, Loc-RIB and Adj-RIB-Out", () => {
    const { provider, core } = communityChain({ communities: ["65000:100"] });
    expect(received(provider)["198.51.100.0/24"]).toEqual(["65000:100"]);
    expect(provider.bgp.selectedRoutes().find((route) => route.network === "198.51.100.0")?.communities).toEqual(["65000:100"]);
    expect(provider.bgp.adjRibOutEntries("10.0.2.2").find((route) => route.network === "198.51.100.0")?.communities)
      .toEqual(["65000:100"]);
    expect(received(core)["198.51.100.0/24"]).toEqual(["65000:100"]);
  });

  it("only propagates communities to a neighbor with send-community", () => {
    const { provider, core, upstream } = communityChain({ communities: ["65000:100"], sendToCore: false });
    expect(provider.bgp.adjRibOutEntries("10.0.2.2").find((route) => route.network === "198.51.100.0")?.communities).toEqual([]);
    expect(received(core)["198.51.100.0/24"]).toEqual([]);
    // The upstream session still sends them, so the gate really is per neighbor.
    expect(received(upstream)["198.51.100.0/24"]).toEqual(["65000:100"]);
  });

  it("stops a no-export route at the eBGP boundary but keeps it inside the AS", () => {
    const { core, upstream } = communityChain({ communities: ["no-export"] });
    expect(received(core)["198.51.100.0/24"]).toEqual(["no-export"]);
    expect(received(upstream)).toEqual({});
  });

  it("stops a no-advertise route at every peer", () => {
    const { engine, core, upstream } = communityChain({ communities: ["no-advertise"] });
    expect(received(core)).toEqual({});
    expect(received(upstream)).toEqual({});
    expect(engine.traceLog.some((entry) => entry.type === "bgp-community-suppressed-advertisement"
      && entry.detail?.community === "no-advertise")).toBe(true);
  });

  it("traces the communities a route map adds", () => {
    const { engine } = communityChain({ communities: ["65000:100"] });
    expect(engine.traceLog.some((entry) => entry.type === "bgp-community-added"
      && Array.isArray(entry.detail?.communities) && entry.detail.communities.includes("65000:100"))).toBe(true);
  });

  it("originates no communities when no policy sets any", () => {
    const { provider } = communityChain();
    expect(received(provider)["198.51.100.0/24"]).toEqual([]);
  });
});
