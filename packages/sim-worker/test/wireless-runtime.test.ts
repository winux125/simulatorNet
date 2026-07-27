import type { LabDocument } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type LabUiSnapshot,
  type SimWorkerPayload,
  type SimWorkerRequest,
  type WirelessAccessPointView,
  type WirelessStationView,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";

const VERIFIER = {
  algorithm: "pbkdf2-sha256" as const,
  iterations: 2_000,
  saltBase64: "c2ltdWxhdG9ybmV0LXNhbHQ=",
  hashBase64: "b3BhcXVlLXdpcmVsZXNzLWZpbmdlcnByaW50",
};

function wirelessLab(security: "open" | "wpa2-personal" = "open"): LabDocument {
  return {
    schemaVersion: 1,
    id: "worker-wireless",
    title: "Worker wireless",
    simulation: { seed: 106 },
    topology: {
      schemaVersion: 1,
      nodes: [
        {
          id: "ap",
          kind: "access-point",
          interfaces: [{ id: "wlan0" }, { id: "eth0" }],
        },
        {
          id: "laptop",
          kind: "laptop",
          interfaces: [{ id: "wlan0" }, { id: "eth0" }],
        },
      ],
      links: [],
    },
    configurations: {
      ap: {
        kind: "access-point",
        hostname: "AP1",
        interfaces: [],
        radio: {
          enabled: true,
          band: "2.4ghz",
          supportedChannels: [1, 6, 11],
          radioDomainId: "lab",
        },
        accessPoint: {
          ssid: "Lab WLAN",
          broadcastSsid: true,
          band: "2.4ghz",
          channel: 6,
          enabled: true,
          radioDomainId: "lab",
          priority: 100,
          maximumClients: 16,
          clientIsolation: false,
          security: security === "open"
            ? { mode: "open" }
            : { mode: "wpa2-personal", credentialVerifier: VERIFIER },
        },
      },
      laptop: {
        kind: "laptop",
        hostname: "Laptop1",
        interfaces: [],
        dhcpEnabled: false,
        wireless: {
          radio: {
            enabled: true,
            band: "2.4ghz",
            supportedChannels: [1, 6, 11],
            radioDomainId: "lab",
          },
          savedNetworks: [],
          autoConnect: false,
        },
      },
    },
  };
}

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: Omit<Extract<SimWorkerRequest, { type: Type }>, "requestId">,
): SimWorkerPayload {
  const response = runtime.handleRequest({ ...input, requestId: `wireless-${input.type}` });
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

describe("wireless worker protocol", () => {
  it("scans, connects, and exposes a runtime-only association overlay", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: wirelessLab() });

    const scanned = request(runtime, {
      type: "SCAN_WIRELESS_NETWORKS",
      deviceId: "laptop",
    }) as WirelessStationView;
    expect(scanned.networks).toEqual([
      expect.objectContaining({ ssid: "Lab WLAN", security: "open" }),
    ]);

    const connected = request(runtime, {
      type: "CONNECT_WIRELESS_NETWORK",
      deviceId: "laptop",
      ssid: "Lab WLAN",
      securityMode: "open",
      saveNetwork: true,
    }) as WirelessStationView;
    expect(connected.status.state).toBe("associated");
    const snapshot = request(runtime, { type: "GET_SNAPSHOT" }) as LabUiSnapshot;
    expect(snapshot.links).toEqual([]);
    expect(snapshot.wirelessAssociations).toEqual([
      expect.objectContaining({
        stationDeviceId: "laptop",
        accessPointDeviceId: "ap",
        ssid: "Lab WLAN",
      }),
    ]);
  });

  it("stores only the WPA2 verifier and returns a stable incorrect-key problem", () => {
    const events: unknown[] = [];
    const runtime = createSimulationWorkerRuntime((event) => events.push(event));
    request(runtime, { type: "INITIALIZE_LAB", document: wirelessLab("wpa2-personal") });

    const failed = request(runtime, {
      type: "CONNECT_WIRELESS_NETWORK",
      deviceId: "laptop",
      ssid: "Lab WLAN",
      securityMode: "wpa2-personal",
      credentialVerifier: { ...VERIFIER, hashBase64: "d3Jvbmc=" },
      saveNetwork: false,
    }) as WirelessStationView;

    expect(failed.status).toMatchObject({
      state: "failed",
      failureReason: "authentication-failed",
    });
    const serialized = JSON.stringify({ failed, events });
    expect(serialized).not.toContain("passphrase");
    expect(serialized).not.toContain("d3Jvbmc=");
    expect(events).toContainEqual(expect.objectContaining({
      type: "RUNTIME_WARNING",
      warnings: [expect.objectContaining({ code: "wireless-authentication-failed" })],
    }));
  });

  it("queues association in Step mode and completes it with Run All", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: wirelessLab() });
    request(runtime, { type: "SET_EXECUTION_MODE", mode: "step" });

    const queued = request(runtime, {
      type: "CONNECT_WIRELESS_NETWORK",
      deviceId: "laptop",
      ssid: "Lab WLAN",
      securityMode: "open",
      saveNetwork: false,
    }) as WirelessStationView;
    expect(queued.status.state).toBe("scanning");

    request(runtime, { type: "RUN_UNTIL_IDLE" });
    const completed = request(runtime, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop",
    }) as WirelessStationView;
    expect(completed.status.state).toBe("associated");
  });

  it("configures an AP and disconnects an associated client through typed requests", () => {
    const runtime = createSimulationWorkerRuntime();
    request(runtime, { type: "INITIALIZE_LAB", document: wirelessLab() });
    request(runtime, {
      type: "CONNECT_WIRELESS_NETWORK",
      deviceId: "laptop",
      ssid: "Lab WLAN",
      securityMode: "open",
      saveNetwork: true,
    });
    const clients = request(runtime, {
      type: "GET_AP_CLIENTS",
      deviceId: "ap",
    }) as WirelessAccessPointView;
    expect(clients.clients).toHaveLength(1);

    const disconnected = request(runtime, {
      type: "DISCONNECT_AP_CLIENT",
      deviceId: "ap",
      stationDeviceId: "laptop",
    }) as WirelessAccessPointView;
    expect(disconnected.clients).toEqual([]);
    const status = request(runtime, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop",
    }) as WirelessStationView;
    expect(status.status.state).toBe("disconnected");
  });
});
