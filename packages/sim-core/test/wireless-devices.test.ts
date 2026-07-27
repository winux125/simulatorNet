import { describe, expect, it } from "vitest";
import type {
  WirelessAccessPointConfiguration,
  WirelessInterfaceConfiguration,
  WirelessRouterDeviceConfig,
  WirelessStationConfiguration,
} from "@sim/contracts";
import {
  AccessPoint,
  createSimulationEngine,
  Laptop,
  L2Switch,
  macFromIndex,
  Router,
  Server,
  Smartphone,
  WirelessRouter,
  type SimulationEngine,
} from "@sim/sim-core";

function radio(
  macIndex: number,
  overrides: Partial<WirelessInterfaceConfiguration> = {},
): WirelessInterfaceConfiguration {
  return {
    id: "wlan0",
    name: "wlan0",
    macAddress: macFromIndex(macIndex),
    enabled: true,
    band: "2.4ghz",
    supportedChannels: [1, 6, 11],
    radioDomainId: "home",
    ...overrides,
  };
}

function accessPointConfig(
  overrides: Partial<WirelessAccessPointConfiguration> = {},
): WirelessAccessPointConfiguration {
  return {
    ssid: "SimulatorNet",
    broadcastSsid: true,
    band: "2.4ghz",
    channel: 6,
    enabled: true,
    radioDomainId: "home",
    priority: 100,
    maximumClients: 32,
    clientIsolation: false,
    security: { mode: "open" },
    ...overrides,
  };
}

function stationConfig(
  overrides: Partial<WirelessStationConfiguration> = {},
): WirelessStationConfiguration {
  return {
    radio: {
      enabled: true,
      band: "2.4ghz",
      supportedChannels: [1, 6, 11],
      radioDomainId: "home",
    },
    savedNetworks: [],
    autoConnect: true,
    preferredSsid: "SimulatorNet",
    ...overrides,
  };
}

function configuredAccessPoint(engine: SimulationEngine): AccessPoint {
  const accessPoint = engine.add(new AccessPoint("ap1", "AP1"));
  accessPoint.addInterface("eth0", macFromIndex(100));
  accessPoint.configureWireless(radio(101), accessPointConfig());
  return accessPoint;
}

function configuredLaptop(engine: SimulationEngine, id = "laptop", macIndex = 1): Laptop {
  const laptop = engine.add(new Laptop(id, id.toUpperCase()));
  laptop.addInterface("eth0", macFromIndex(macIndex + 20));
  laptop.configureWirelessInterface(radio(macIndex), stationConfig());
  return laptop;
}

describe("wireless devices", () => {
  it("reuses EndHost DHCP and ping through an AP Ethernet bridge", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const router = engine.add(new Router("r1", "R1"));
    router.addInterface("Gi0/0", macFromIndex(200));
    router.configureInterface("Gi0/0", { ip: "192.168.10.1", mask: 24 });
    router.addDhcpPool({
      network: "192.168.10.0",
      mask: 24,
      gateway: "192.168.10.1",
      rangeStart: "192.168.10.100",
      rangeEnd: "192.168.10.120",
    });
    const accessPoint = configuredAccessPoint(engine);
    engine.connect(accessPoint.id, "eth0", router.id, "Gi0/0");
    const laptop = configuredLaptop(engine);

    laptop.connectWireless();
    engine.runUntilIdle();
    laptop.requestDhcp();
    engine.runUntilIdle();
    laptop.ping("192.168.10.1", 1);
    engine.runUntilIdle();

    expect(laptop.ip).toBe("192.168.10.100");
    expect(laptop.pingResults.at(-1)).toMatchObject({ success: true });
    expect(accessPoint.associatedClients()).toEqual([
      expect.objectContaining({ deviceId: laptop.id, macAddress: laptop.primary.mac }),
    ]);
    expect(engine.links).toHaveLength(1);
  });

  it("pings a wired server from a static wireless laptop", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const accessPoint = configuredAccessPoint(engine);
    const networkSwitch = engine.add(new L2Switch("sw1", "SW1"));
    networkSwitch.addInterface("Gi0/1", macFromIndex(110));
    networkSwitch.addInterface("Gi0/2", macFromIndex(111));
    const server = engine.add(new Server("server", "SERVER"));
    server.addInterface("eth0", macFromIndex(10));
    server.configure({ ip: "192.168.10.20", mask: 24 });
    engine.connect(accessPoint.id, "eth0", networkSwitch.id, "Gi0/1");
    engine.connect(server.id, "eth0", networkSwitch.id, "Gi0/2");
    const laptop = configuredLaptop(engine);
    laptop.setStaticConfiguration({ address: "192.168.10.10", prefixLength: 24 });

    laptop.connectWireless();
    engine.runUntilIdle();
    laptop.ping("192.168.10.20", 1);
    engine.runUntilIdle();

    expect(laptop.pingResults.at(-1)).toMatchObject({ success: true });
    expect(networkSwitch.macAddressTable()).toEqual(expect.arrayContaining([
      expect.objectContaining({ mac: laptop.primary.mac }),
      expect.objectContaining({ mac: server.primary.mac }),
    ]));
  });

  it("does not make a standalone AP act as a DHCP server", () => {
    const engine = createSimulationEngine({ seed: 106 });
    configuredAccessPoint(engine);
    const laptop = configuredLaptop(engine);
    laptop.connectWireless();
    engine.runUntilIdle();

    laptop.requestDhcp();
    engine.runUntilIdle();

    expect(laptop.dhcpBound).toBe(false);
    expect(laptop.dhcpState).toBe("failed");
  });

  it("runs IPv6 SLAAC for a smartphone through the same AP bridge", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const router = engine.add(new Router("r1", "R1"));
    router.addInterface("Gi0/0", macFromIndex(200));
    router.getOrCreateInterface("Gi0/0");
    router.setInterfaceIpv6("Gi0/0", "2001:db8:60::1", 64);
    router.setIpv6ForwardingEnabled(true);
    router.configureRouterAdvertisement("Gi0/0", {
      prefixes: [{
        prefix: "2001:db8:60::",
        prefixLength: 64,
        autonomous: true,
        onLink: true,
        validLifetimeNs: 7_200_000_000_000,
        preferredLifetimeNs: 3_600_000_000_000,
      }],
    });
    const accessPoint = configuredAccessPoint(engine);
    engine.connect(accessPoint.id, "eth0", router.id, "Gi0/0");
    const phone = engine.add(new Smartphone("phone", "PHONE"));
    phone.configureWirelessInterface(radio(2), stationConfig());

    phone.connectWireless();
    engine.runUntilIdle();
    phone.setIpv6Mode("slaac");
    engine.runUntilIdle();

    expect(phone.ipv6AddressSummaries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "link-local", state: "preferred" }),
      expect.objectContaining({ source: "slaac", state: "preferred", prefixLength: 64 }),
    ]));
    expect(phone.ipv6DefaultRouter).toMatch(/^fe80:/);
  });

  it("lets an AP explicitly disconnect only the selected client", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const accessPoint = configuredAccessPoint(engine);
    const first = configuredLaptop(engine, "laptop-1", 1);
    const second = configuredLaptop(engine, "laptop-2", 2);
    first.connectWireless();
    second.connectWireless();
    engine.runUntilIdle();

    expect(accessPoint.disconnectClient(first.id)).toBe(true);

    expect(first.wirelessStatus().state).toBe("disconnected");
    expect(second.wirelessStatus().state).toBe("associated");
    expect(accessPoint.associatedClients().map((client) => client.deviceId)).toEqual([second.id]);
  });

  it("keeps station configuration separate from transient association state", () => {
    const engine = createSimulationEngine({ seed: 106 });
    configuredAccessPoint(engine);
    const laptop = configuredLaptop(engine);
    laptop.connectWireless();
    engine.runUntilIdle();

    const configuration = laptop.wirelessConfigurationSnapshot();

    expect(configuration).toEqual(stationConfig());
    expect(configuration).not.toHaveProperty("state");
    expect(configuration).not.toHaveProperty("bssid");
    expect(configuration).not.toHaveProperty("associatedAtNs");
  });

  it("composes WLAN, LAN switch, DHCP, PAT and firewall in the home router", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const homeRouter = engine.add(new WirelessRouter("home-router", "HOME"));
    for (const [index, name] of ["LAN1", "LAN2", "LAN3", "LAN4", "WAN"].entries()) {
      homeRouter.addInterface(name, macFromIndex(300 + index));
    }
    const configuration = homeRouterConfiguration();
    homeRouter.configureHomeNetwork(radio(306), configuration);
    const laptop = configuredLaptop(engine);

    laptop.connectWireless();
    engine.runUntilIdle();
    laptop.requestDhcp();
    engine.runUntilIdle();
    laptop.ping("192.168.50.1", 1);
    engine.runUntilIdle();

    expect(laptop.ip).toBe("192.168.50.100");
    expect(laptop.pingResults.at(-1)).toMatchObject({ success: true });
    expect(homeRouter.firewallRouter.natRuleConfigurations()).toEqual([
      expect.objectContaining({ kind: "pat", outsideAddress: "interface" }),
    ]);
    expect(homeRouter.firewallRouter.policyConfigurations()).toEqual([
      expect.objectContaining({ sourceZone: "lan", destinationZone: "wan", action: "permit" }),
    ]);
    expect(homeRouter.lanSwitch.interfaces.has("wlan0")).toBe(true);
  });

  it("keeps the explicit home-router preset visible in its snapshot", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const homeRouter = engine.add(new WirelessRouter("home-router", "HOME"));
    for (const [index, name] of ["LAN1", "LAN2", "LAN3", "LAN4", "WAN"].entries()) {
      homeRouter.addInterface(name, macFromIndex(300 + index));
    }
    const configuration = homeRouterConfiguration();
    homeRouter.configureHomeNetwork(radio(306), configuration);

    expect(homeRouter.configurationSnapshot()).toEqual(configuration);
    expect(homeRouter.configurationSnapshot()).toMatchObject({
      natEnabled: true,
      firewallEnabled: true,
      lan: { dhcpEnabled: true },
      wan: { mode: "static" },
    });
  });
});

function homeRouterConfiguration(): WirelessRouterDeviceConfig {
  return {
    kind: "wireless-router",
    hostname: "HOME",
    interfaces: [],
    radio: {
      enabled: true,
      band: "2.4ghz",
      supportedChannels: [1, 6, 11],
      radioDomainId: "home",
    },
    accessPoint: accessPointConfig(),
    lan: {
      address: "192.168.50.1",
      prefixLength: 24,
      dhcpEnabled: true,
      dhcpRangeStart: "192.168.50.100",
      dhcpRangeEnd: "192.168.50.150",
      routerAdvertisementEnabled: false,
      dhcpv6Enabled: false,
    },
    wan: {
      mode: "static",
      address: "203.0.113.2",
      prefixLength: 24,
      defaultGateway: "203.0.113.1",
    },
    natEnabled: true,
    firewallEnabled: true,
  };
}
