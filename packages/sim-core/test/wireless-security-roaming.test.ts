import { describe, expect, it } from "vitest";
import type {
  WirelessInterfaceConfiguration,
  WirelessSecurityMode,
} from "@sim/contracts";
import {
  createSimulationEngine,
  macFromIndex,
  type EthernetFrame,
  type SimulationEngine,
  type WirelessAccessPointRadioConfiguration,
  type WirelessStationCredential,
} from "@sim/sim-core";

const GOOD_FINGERPRINT = "opaque-good-fingerprint";
const WRONG_FINGERPRINT = "opaque-wrong-fingerprint";

function stationInterface(macIndex: number): WirelessInterfaceConfiguration {
  return {
    id: "wlan0",
    name: "wlan0",
    macAddress: macFromIndex(macIndex),
    enabled: true,
    band: "2.4ghz",
    supportedChannels: [1, 6, 11],
    radioDomainId: "campus",
  };
}

function accessPointConfiguration(
  overrides: Partial<WirelessAccessPointRadioConfiguration> = {},
): WirelessAccessPointRadioConfiguration {
  return {
    ssid: "Secure Lab",
    broadcastSsid: true,
    band: "2.4ghz",
    channel: 6,
    enabled: true,
    radioDomainId: "campus",
    priority: 100,
    maximumClients: 32,
    clientIsolation: false,
    security: { mode: "open" },
    ...overrides,
  };
}

function registerAccessPoint(
  engine: SimulationEngine,
  deviceId: string,
  macIndex: number,
  configuration: Partial<WirelessAccessPointRadioConfiguration> = {},
  frames: EthernetFrame[] = [],
): void {
  engine.wireless.registerAccessPoint({
    deviceId,
    interfaceId: "wlan0",
    macAddress: macFromIndex(macIndex),
    configuration: accessPointConfiguration(configuration),
    receive: (frame) => frames.push(frame),
  });
}

function registerStation(
  engine: SimulationEngine,
  deviceId: string,
  macIndex: number,
  options: {
    autoConnect?: boolean;
    preferredSsid?: string;
    preferredBssid?: string;
    credentials?: readonly WirelessStationCredential[];
  } = {},
): void {
  engine.wireless.registerStation({
    deviceId,
    interface: stationInterface(macIndex),
    receive: () => undefined,
    autoConnect: options.autoConnect,
    preferredSsid: options.preferredSsid,
    preferredBssid: options.preferredBssid,
    credentials: options.credentials,
  });
}

function credential(
  fingerprint = GOOD_FINGERPRINT,
  securityMode: WirelessSecurityMode = "wpa2-personal",
): WirelessStationCredential {
  return {
    ssid: "Secure Lab",
    securityMode,
    credentialFingerprint: fingerprint,
  };
}

describe("WPA2-PSK and deterministic roaming", () => {
  it("associates only when the opaque WPA2 fingerprint matches", () => {
    const run = (fingerprint: string) => {
      const engine = createSimulationEngine({ seed: 106 });
      registerStation(engine, "laptop", 1);
      registerAccessPoint(engine, "ap", 100, {
        security: { mode: "wpa2-personal", credentialFingerprint: GOOD_FINGERPRINT },
      });
      engine.wireless.connect("laptop", "wlan0", {
        ssid: "Secure Lab",
        securityMode: "wpa2-personal",
        credentialFingerprint: fingerprint,
      });
      engine.runUntilIdle();
      return engine.wireless.status("laptop", "wlan0");
    };

    expect(run(GOOD_FINGERPRINT).state).toBe("associated");
    expect(run(WRONG_FINGERPRINT)).toMatchObject({
      state: "failed",
      failureReason: "authentication-failed",
    });
  });

  it("never places credential material in management traces", () => {
    const engine = createSimulationEngine({ seed: 106 });
    engine.enableTrace();
    registerStation(engine, "laptop", 1);
    registerAccessPoint(engine, "ap", 100, {
      security: { mode: "wpa2-personal", credentialFingerprint: GOOD_FINGERPRINT },
    });

    engine.wireless.connect("laptop", "wlan0", {
      ssid: "Secure Lab",
      securityMode: "wpa2-personal",
      credentialFingerprint: WRONG_FINGERPRINT,
    });
    engine.runUntilIdle();

    const trace = JSON.stringify(engine.traceLog);
    expect(trace).not.toContain(GOOD_FINGERPRINT);
    expect(trace).not.toContain(WRONG_FINGERPRINT);
    expect(trace).toContain("incorrect-security-key");
  });

  it("rejects a WPA2 AP without prepared verifier material", () => {
    const engine = createSimulationEngine({ seed: 106 });

    expect(() => registerAccessPoint(engine, "ap", 100, {
      security: { mode: "wpa2-personal" },
    })).toThrow("opaque credential fingerprint");
  });

  it("uses a saved verifier for auto-connect without passing a secret to connect", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "ap", 100, {
      security: { mode: "wpa2-personal", credentialFingerprint: GOOD_FINGERPRINT },
    });
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
      credentials: [credential()],
    });

    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "associated",
      accessPointDeviceId: "ap",
    });
  });

  it("roams to the deterministic fallback AP when the current AP stops", () => {
    const engine = createSimulationEngine({ seed: 106 });
    engine.enableTrace();
    registerAccessPoint(engine, "preferred", 100, { priority: 200 });
    registerAccessPoint(engine, "fallback", 101, { priority: 100 });
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    engine.runUntilIdle();
    expect(engine.wireless.status("laptop", "wlan0").accessPointDeviceId).toBe("preferred");

    engine.wireless.updateAccessPoint(
      "preferred",
      "wlan0",
      accessPointConfiguration({ enabled: false, priority: 200 }),
    );
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "associated",
      accessPointDeviceId: "fallback",
      lastRoamedFromBssid: macFromIndex(100),
    });
    expect(engine.traceLog).toContainEqual(expect.objectContaining({
      type: "wireless-roamed",
      device: "laptop",
    }));
  });

  it("moves to an explicitly preferred BSSID while preserving station identity", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "ap-a", 100, { priority: 200 });
    registerAccessPoint(engine, "ap-b", 101, { priority: 100 });
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    engine.runUntilIdle();

    engine.wireless.updateStationPreferences("laptop", "wlan0", {
      preferredSsid: "Secure Lab",
      preferredBssid: macFromIndex(101),
      autoConnect: true,
    });
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      accessPointDeviceId: "ap-b",
      bssid: macFromIndex(101),
      lastRoamedFromBssid: macFromIndex(100),
    });
  });

  it("uses a lower-priority AP when the preferred AP has reached its limit", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "small", 100, { priority: 200, maximumClients: 1 });
    registerAccessPoint(engine, "overflow", 101, { priority: 100 });
    registerStation(engine, "first", 1);
    registerStation(engine, "second", 2);

    engine.wireless.connect("first", "wlan0", { ssid: "Secure Lab" });
    engine.runUntilIdle();
    engine.wireless.connect("second", "wlan0", { ssid: "Secure Lab" });
    engine.runUntilIdle();

    expect(engine.wireless.status("first", "wlan0").accessPointDeviceId).toBe("small");
    expect(engine.wireless.status("second", "wlan0").accessPointDeviceId).toBe("overflow");
  });

  it("rebalances excess clients after a running AP limit is reduced", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "primary", 100, { priority: 200, maximumClients: 2 });
    registerAccessPoint(engine, "overflow", 101, { priority: 100 });
    registerStation(engine, "first", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    registerStation(engine, "second", 2, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    engine.runUntilIdle();

    engine.wireless.updateAccessPoint(
      "primary",
      "wlan0",
      accessPointConfiguration({ priority: 200, maximumClients: 1 }),
    );
    engine.runUntilIdle();

    expect([
      engine.wireless.status("first", "wlan0").accessPointDeviceId,
      engine.wireless.status("second", "wlan0").accessPointDeviceId,
    ].sort()).toEqual(["overflow", "primary"]);
  });

  it("reconnects deterministically after a single AP restarts", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "ap", 100);
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    engine.runUntilIdle();

    engine.wireless.updateAccessPoint(
      "ap",
      "wlan0",
      accessPointConfiguration({ enabled: false }),
    );
    engine.runUntilIdle();
    expect(engine.wireless.status("laptop", "wlan0").state).not.toBe("associated");

    engine.wireless.updateAccessPoint(
      "ap",
      "wlan0",
      accessPointConfiguration({ enabled: true }),
    );
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "associated",
      accessPointDeviceId: "ap",
    });
  });

  it("reconnects an auto-connect station after its radio is re-enabled", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "ap", 100);
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
    });
    engine.runUntilIdle();

    engine.wireless.setStationEnabled("laptop", "wlan0", false);
    expect(engine.wireless.status("laptop", "wlan0").state).toBe("disabled");

    engine.wireless.setStationEnabled("laptop", "wlan0", true);
    engine.runUntilIdle();
    expect(engine.wireless.status("laptop", "wlan0").state).toBe("associated");
  });

  it("deauthenticates and rejects a saved profile after the AP key changes", () => {
    const engine = createSimulationEngine({ seed: 106 });
    registerAccessPoint(engine, "ap", 100, {
      security: { mode: "wpa2-personal", credentialFingerprint: GOOD_FINGERPRINT },
    });
    registerStation(engine, "laptop", 1, {
      autoConnect: true,
      preferredSsid: "Secure Lab",
      credentials: [credential()],
    });
    engine.runUntilIdle();

    engine.wireless.updateAccessPoint(
      "ap",
      "wlan0",
      accessPointConfiguration({
        security: { mode: "wpa2-personal", credentialFingerprint: WRONG_FINGERPRINT },
      }),
    );
    engine.runUntilIdle();

    expect(engine.wireless.status("laptop", "wlan0")).toMatchObject({
      state: "failed",
      failureReason: "authentication-failed",
    });
  });

  it("keeps automatic traces identical across repeated roaming runs", () => {
    const run = () => {
      const engine = createSimulationEngine({ seed: 106 });
      engine.enableTrace();
      registerAccessPoint(engine, "ap-a", 100, { priority: 200 });
      registerAccessPoint(engine, "ap-b", 101, { priority: 100 });
      registerStation(engine, "laptop", 1, {
        autoConnect: true,
        preferredSsid: "Secure Lab",
      });
      engine.runUntilIdle();
      engine.wireless.updateAccessPoint(
        "ap-a",
        "wlan0",
        accessPointConfiguration({ enabled: false, priority: 200 }),
      );
      engine.runUntilIdle();
      return engine.traceLog;
    };

    expect(run()).toEqual(run());
  });
});
