import { describe, expect, it } from "vitest";
import {
  ArpOp,
  EtherType,
  type WirelessBand,
  type WirelessInterfaceConfiguration,
} from "@sim/contracts";
import {
  createSimulationEngine,
  macFromIndex,
  WirelessLimitError,
  WirelessMedium,
  type EthernetFrame,
  type SimulationEngine,
  type WirelessAccessPointRadioConfiguration,
  type WirelessLimits,
} from "@sim/sim-core";

interface RadioCapture {
  readonly frames: EthernetFrame[];
}

function stationInterface(
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
    radioDomainId: "campus-a",
    ...overrides,
  };
}

function accessPointConfiguration(
  overrides: Partial<WirelessAccessPointRadioConfiguration> = {},
): WirelessAccessPointRadioConfiguration {
  return {
    ssid: "SimulatorNet",
    broadcastSsid: true,
    band: "2.4ghz",
    channel: 6,
    enabled: true,
    radioDomainId: "campus-a",
    priority: 100,
    maximumClients: 32,
    clientIsolation: false,
    security: { mode: "open" },
    ...overrides,
  };
}

function registerAccessPoint(
  engine: SimulationEngine,
  id: string,
  macIndex: number,
  capture: RadioCapture,
  overrides: Partial<WirelessAccessPointRadioConfiguration> = {},
): void {
  engine.wireless.registerAccessPoint({
    deviceId: id,
    interfaceId: "wlan0",
    macAddress: macFromIndex(macIndex),
    configuration: accessPointConfiguration(overrides),
    receive: (frame) => capture.frames.push(frame),
  });
}

function registerStation(
  engine: SimulationEngine,
  id: string,
  macIndex: number,
  capture: RadioCapture,
  overrides: Partial<WirelessInterfaceConfiguration> = {},
): void {
  engine.wireless.registerStation({
    deviceId: id,
    interface: stationInterface(macIndex, overrides),
    receive: (frame) => capture.frames.push(frame),
  });
}

function arpFrame(sourceMac: string, destinationMac: string): EthernetFrame {
  return {
    src: sourceMac,
    dst: destinationMac,
    etherType: EtherType.ARP,
    payload: {
      kind: "arp",
      op: ArpOp.Request,
      senderMac: sourceMac,
      senderIp: "192.168.10.10",
      targetMac: "00:00:00:00:00:00",
      targetIp: "192.168.10.1",
    },
  };
}

describe("deterministic wireless medium", () => {
  it.each([
    ["2.4ghz", 0],
    ["2.4ghz", 15],
    ["5ghz", 14],
    ["5ghz", 180],
  ] satisfies ReadonlyArray<readonly [WirelessBand, number]>)(
    "rejects channel %s/%d outside the configured band",
    (band, channel) => {
      const engine = createSimulationEngine({ seed: 106 });
      expect(() => registerAccessPoint(
        engine,
        "ap1",
        100,
        { frames: [] },
        { band, channel },
      )).toThrow(/not valid/);
    },
  );

  it("scans only visible compatible APs in the same radio domain", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "laptop", 1, { frames: [] });
    registerAccessPoint(engine, "visible", 100, { frames: [] });
    registerAccessPoint(engine, "hidden", 101, { frames: [] }, {
      ssid: "Hidden",
      broadcastSsid: false,
    });
    registerAccessPoint(engine, "other-domain", 102, { frames: [] }, {
      ssid: "Other",
      radioDomainId: "campus-b",
    });
    registerAccessPoint(engine, "other-channel", 103, { frames: [] }, {
      ssid: "Channel 13",
      channel: 13,
    });

    engine.wireless.scan("laptop", "wlan0");
    engine.runUntilIdle();

    expect(engine.wireless.scanResults("laptop", "wlan0").map((entry) => entry.ssid))
      .toEqual(["SimulatorNet"]);
  });

  it("finds a hidden SSID only when it is named explicitly", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "laptop", 1, { frames: [] });
    registerAccessPoint(engine, "hidden", 100, { frames: [] }, {
      ssid: "Hidden Lab",
      broadcastSsid: false,
    });

    engine.wireless.scan("laptop", "wlan0", "Hidden Lab");
    engine.runUntilIdle();

    expect(engine.wireless.scanResults("laptop", "wlan0")).toEqual([
      expect.objectContaining({ ssid: "Hidden Lab", bssid: macFromIndex(100) }),
    ]);
  });

  it("selects preferred BSSID, then priority, then stable BSSID order", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "preferred", 1, { frames: [] });
    registerStation(engine, "priority", 2, { frames: [] });
    registerStation(engine, "stable", 3, { frames: [] });
    registerAccessPoint(engine, "ap-low", 100, { frames: [] }, { priority: 10 });
    registerAccessPoint(engine, "ap-high-a", 101, { frames: [] }, { priority: 200 });
    registerAccessPoint(engine, "ap-high-b", 102, { frames: [] }, { priority: 200 });

    engine.wireless.connect("preferred", "wlan0", { preferredBssid: macFromIndex(100) });
    engine.wireless.connect("priority", "wlan0");
    engine.wireless.connect("stable", "wlan0");
    engine.runUntilIdle();

    expect(engine.wireless.status("preferred", "wlan0").accessPointDeviceId).toBe("ap-low");
    expect(engine.wireless.status("priority", "wlan0").accessPointDeviceId).toBe("ap-high-a");
    expect(engine.wireless.status("stable", "wlan0").accessPointDeviceId).toBe("ap-high-a");
  });

  it("runs open authentication and association through virtual-time events", () => {
    const engine = createSimulationEngine({ seed: 106 });
    engine.enableTrace();
    registerStation(engine, "laptop", 1, { frames: [] });
    registerAccessPoint(engine, "ap1", 100, { frames: [] });

    engine.wireless.connect("laptop", "wlan0");
    expect(engine.wireless.status("laptop", "wlan0").state).toBe("scanning");
    engine.runNextEvent();
    expect(engine.wireless.status("laptop", "wlan0").state).toBe("authenticating");
    engine.runNextEvent();
    expect(engine.wireless.status("laptop", "wlan0").state).toBe("associating");
    engine.runNextEvent();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "associated",
      accessPointDeviceId: "ap1",
      ssid: "SimulatorNet",
    });
    expect(engine.traceLog.map((entry) => entry.type)).toEqual(expect.arrayContaining([
      "wireless-probe-request",
      "wireless-probe-response",
      "wireless-authentication-started",
      "wireless-associated",
    ]));
  });

  it("keeps an existing association operational after an active scan", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "laptop", 1, { frames: [] });
    registerAccessPoint(engine, "ap1", 100, { frames: [] });

    engine.wireless.connect("laptop", "wlan0");
    engine.runUntilIdle();
    engine.wireless.scan("laptop", "wlan0");
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "associated",
      accessPointDeviceId: "ap1",
    });
    expect(engine.wireless.isOperational("laptop", "wlan0")).toBe(true);
  });

  it("delivers station and AP data without creating an Ethernet link", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const stationCapture = { frames: [] as EthernetFrame[] };
    const apCapture = { frames: [] as EthernetFrame[] };
    registerStation(engine, "laptop", 1, stationCapture);
    registerAccessPoint(engine, "ap1", 100, apCapture);
    engine.wireless.connect("laptop", "wlan0");
    engine.runUntilIdle();

    const uplink = arpFrame(macFromIndex(1), "ff:ff:ff:ff:ff:ff");
    engine.wireless.transmit("laptop", "wlan0", uplink);
    engine.runUntilIdle();
    const downlink = arpFrame(macFromIndex(100), macFromIndex(1));
    engine.wireless.transmit("ap1", "wlan0", downlink);
    engine.runUntilIdle();

    expect(apCapture.frames).toContainEqual(expect.objectContaining({
      src: uplink.src,
      dst: uplink.dst,
      payload: uplink.payload,
    }));
    expect(stationCapture.frames).toContainEqual(expect.objectContaining({
      src: downlink.src,
      dst: downlink.dst,
      payload: downlink.payload,
    }));
    expect(engine.links).toHaveLength(0);
  });

  it("bridges client-to-client radio data unless isolation is enabled", () => {
    const run = (clientIsolation: boolean) => {
      const engine = createSimulationEngine({ seed: 106 });
      const first = { frames: [] as EthernetFrame[] };
      const second = { frames: [] as EthernetFrame[] };
      registerStation(engine, "laptop-1", 1, first);
      registerStation(engine, "laptop-2", 2, second);
      registerAccessPoint(engine, "ap1", 100, { frames: [] }, { clientIsolation });
      engine.wireless.connect("laptop-1", "wlan0");
      engine.wireless.connect("laptop-2", "wlan0");
      engine.runUntilIdle();
      engine.wireless.transmit(
        "laptop-1",
        "wlan0",
        arpFrame(macFromIndex(1), "ff:ff:ff:ff:ff:ff"),
      );
      engine.runUntilIdle();
      return second.frames;
    };

    expect(run(false)).toHaveLength(1);
    expect(run(true)).toHaveLength(0);
  });

  it("enforces an AP client limit after deterministic authentication", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "laptop-1", 1, { frames: [] });
    registerStation(engine, "laptop-2", 2, { frames: [] });
    registerAccessPoint(engine, "ap1", 100, { frames: [] }, { maximumClients: 1 });

    engine.wireless.connect("laptop-1", "wlan0");
    engine.wireless.connect("laptop-2", "wlan0");
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop-1", "wlan0").state).toBe("associated");
    expect(engine.wireless.status("laptop-2", "wlan0")).toMatchObject({
      state: "failed",
      failureReason: "access-point-client-limit",
    });
  });

  it("keeps a disabled station non-operational", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerStation(engine, "laptop", 1, { frames: [] }, { enabled: false });
    registerAccessPoint(engine, "ap1", 100, { frames: [] });

    engine.wireless.connect("laptop", "wlan0");

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "failed",
      failureReason: "wireless-interface-disabled",
    });
    expect(engine.pendingEventCount()).toBe(0);
  });

  it("deauthenticates associated stations when the AP is disabled", () => {
    const engine = createSimulationEngine({ seed: 106 });
    engine.enableTrace();
    registerStation(engine, "laptop", 1, { frames: [] });
    registerAccessPoint(engine, "ap1", 100, { frames: [] });
    engine.wireless.connect("laptop", "wlan0");
    engine.runUntilIdle();

    engine.wireless.updateAccessPoint(
      "ap1",
      "wlan0",
      accessPointConfiguration({ enabled: false }),
    );

    expect(engine.wireless.status("laptop", "wlan0").state).toBe("disconnected");
    expect(engine.traceLog).toContainEqual(expect.objectContaining({
      type: "wireless-deauthenticated",
      device: "laptop",
    }));
  });

  it("bounds access points per radio domain", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const limits: WirelessLimits = {
      ...engine.wireless.limits,
      maximumAccessPointsPerRadioDomain: 1,
    };
    const medium = new WirelessMedium(engine, limits);
    const registration = (id: string, macIndex: number) => medium.registerAccessPoint({
      deviceId: id,
      interfaceId: "wlan0",
      macAddress: macFromIndex(macIndex),
      configuration: accessPointConfiguration(),
      receive: () => undefined,
    });
    registration("ap1", 100);

    expect(() => registration("ap2", 101)).toThrow(WirelessLimitError);
  });

  it("bounds pending wireless frames", () => {
    const engine = createSimulationEngine({ seed: 106 });
    const limits: WirelessLimits = {
      ...engine.wireless.limits,
      maximumPendingWirelessFrames: 1,
    };
    const medium = new WirelessMedium(engine, limits);
    medium.registerStation({
      deviceId: "laptop",
      interface: stationInterface(1),
      receive: () => undefined,
    });
    medium.registerAccessPoint({
      deviceId: "ap1",
      interfaceId: "wlan0",
      macAddress: macFromIndex(100),
      configuration: accessPointConfiguration(),
      receive: () => undefined,
    });
    medium.connect("laptop", "wlan0");
    engine.runUntilIdle();

    medium.transmit("laptop", "wlan0", arpFrame(macFromIndex(1), "ff:ff:ff:ff:ff:ff"));
    expect(() => medium.transmit(
      "laptop",
      "wlan0",
      arpFrame(macFromIndex(1), "ff:ff:ff:ff:ff:ff"),
    )).toThrow(WirelessLimitError);
  });

  it("produces identical association trace for identical input", () => {
    const run = () => {
      const engine = createSimulationEngine({ seed: 106 });
      engine.enableTrace();
      registerStation(engine, "laptop", 1, { frames: [] });
      registerAccessPoint(engine, "ap1", 100, { frames: [] });
      engine.wireless.connect("laptop", "wlan0");
      engine.runUntilIdle();
      return engine.traceLog;
    };

    expect(run()).toEqual(run());
  });
});
