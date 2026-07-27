import { canonicalizeLabDocument, buildLabFromDocument, serializeLabDocument } from "@sim/lab-format";
import { createWirelessCredentialVerifier } from "@sim/console-auth";
import type { AccessPointDeviceConfig } from "@sim/contracts";
import {
  createSimulationWorkerRuntime,
  type CliExecutionResult,
  type HostIpv6NetworkStatus,
  type HostNetworkStatus,
  type SimWorkerPayload,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
  type WirelessAccessPointView,
  type WirelessStationView,
} from "@sim/sim-worker";
import { describe, expect, it } from "vitest";
import {
  AP_FAILOVER_DEMO,
  HOME_WIRELESS_ROUTER_DEMO,
  OPEN_WIRELESS_LAN_DEMO,
  WIRELESS_DEMO_LABS,
  WPA2_WIRELESS_LAN_DEMO,
} from "./wireless-demo-labs";

function initialize(document: (typeof WIRELESS_DEMO_LABS)[number]) {
  const runtime = createSimulationWorkerRuntime();
  request(runtime, { type: "INITIALIZE_LAB", document });
  return runtime;
}

function request<Type extends SimWorkerRequest["type"]>(
  runtime: ReturnType<typeof createSimulationWorkerRuntime>,
  input: SimWorkerRequestInputOf<Type>,
): SimWorkerPayload {
  const response = runtime.handleRequest({
    ...input,
    requestId: `demo-${input.type}`,
  } as SimWorkerRequest);
  if (response.type === "REQUEST_FAILED") throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.payload;
}

describe("M10.6 wireless demo labs", () => {
  it.each(WIRELESS_DEMO_LABS.map((lab) => [lab.title, lab] as const))(
    "%s is explicit, buildable and round-trips configuration without association runtime",
    (_title, lab) => {
      const canonical = canonicalizeLabDocument(lab);
      const built = buildLabFromDocument(canonical);
      built.engine.runUntilIdle();
      const serialized = serializeLabDocument(built, canonical);

      expect(canonical.schemaVersion).toBe(1);
      expect(canonical.topology.links.every((link) =>
        link.a.iface !== "wlan0" && link.b.iface !== "wlan0")).toBe(true);
      expect(JSON.stringify(serialized)).not.toContain("associatedAtNs");
      expect(JSON.stringify(serialized)).not.toContain("\"bssid\"");
    },
  );

  it("runs open association, DHCP and wired gateway ping through the AP bridge", () => {
    const runtime = initialize(OPEN_WIRELESS_LAN_DEMO);
    const wireless = request(runtime, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop-1",
    }) as WirelessStationView;
    const host = request(runtime, {
      type: "GET_HOST_NETWORK_STATUS",
      deviceId: "laptop-1",
    }) as HostNetworkStatus;
    const ping = request(runtime, {
      type: "EXECUTE_CLI",
      sessionId: "open-demo",
      deviceId: "laptop-1",
      input: "ping 192.168.10.1",
    }) as CliExecutionResult;

    expect(wireless.status.state).toBe("associated");
    expect(host.runtime.address).toMatch(/^192\.168\.10\./u);
    expect(ping.output).toContain("Success rate is 100 percent");
    expect((request(runtime, {
      type: "GET_AP_CLIENTS",
      deviceId: "ap-1",
    }) as WirelessAccessPointView).clients).toHaveLength(1);
  });

  it("keeps WPA2 demo credentials opaque while matching station, AP and user-entered fingerprints", async () => {
    const canonical = canonicalizeLabDocument(WPA2_WIRELESS_LAN_DEMO);
    const runtime = initialize(WPA2_WIRELESS_LAN_DEMO);
    const laptop = request(runtime, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop-1",
    }) as WirelessStationView;

    expect(laptop.status.state).toBe("associated");
    expect(JSON.stringify(canonical)).not.toMatch(/passphrase|plaintext|password/iu);
    expect(JSON.stringify(laptop)).not.toContain("simulatornet-wpa2");
    const expected = (canonical.configurations["ap-1"] as AccessPointDeviceConfig)
      .accessPoint.security;
    const entered = await createWirelessCredentialVerifier("SECURE-LAB", "simulatornet-wpa2");
    expect(expected.mode).toBe("wpa2-personal");
    if (expected.mode !== "wpa2-personal") throw new Error("fixture mismatch");
    expect(entered).toEqual(expected.credentialVerifier);
  });

  it("composes Home Router DHCP/SLAAC and performs deterministic AP failover", () => {
    const home = initialize(HOME_WIRELESS_ROUTER_DEMO);
    const laptop = request(home, {
      type: "GET_HOST_NETWORK_STATUS",
      deviceId: "laptop-1",
    }) as HostNetworkStatus;
    const phone = request(home, {
      type: "GET_HOST_IPV6_NETWORK_STATUS",
      deviceId: "phone-1",
    }) as HostIpv6NetworkStatus;
    const router = request(home, {
      type: "GET_AP_CLIENTS",
      deviceId: "wireless-router-1",
    }) as WirelessAccessPointView;
    expect(laptop.runtime.address).toMatch(/^192\.168\.50\./u);
    expect(phone.runtime.addresses).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "slaac", state: "preferred" }),
    ]));
    expect(router.clients).toHaveLength(2);
    const publicPing = request(home, {
      type: "EXECUTE_CLI",
      sessionId: "home-demo",
      deviceId: "laptop-1",
      input: "ping 198.51.100.10",
    }) as CliExecutionResult;
    expect(publicPing.output).toContain("Success rate is 100 percent");

    const failover = initialize(AP_FAILOVER_DEMO);
    const before = request(failover, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop-1",
    }) as WirelessStationView;
    expect(before.status.accessPointDeviceId).toBe("ap-1");
    const primary = request(failover, {
      type: "GET_AP_CLIENTS",
      deviceId: "ap-1",
    }) as WirelessAccessPointView;
    request(failover, {
      type: "CONFIGURE_ACCESS_POINT",
      deviceId: "ap-1",
      configuration: { ...primary.configuration, enabled: false },
    });
    const roamingLaptop = request(failover, {
      type: "GET_WIRELESS_STATUS",
      deviceId: "laptop-1",
    }) as WirelessStationView;
    expect(roamingLaptop.status).toMatchObject({
      state: "associated",
      accessPointDeviceId: "ap-2",
    });
    expect(roamingLaptop.status.lastRoamedAtNs).toBeDefined();
  });
});
