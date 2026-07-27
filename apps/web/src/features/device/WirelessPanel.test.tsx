// @vitest-environment jsdom

import {
  createSimulationWorkerRuntime,
  type SimWorkerEvent,
  type SimWorkerPayloadByType,
  type SimWorkerRequest,
  type SimWorkerRequestInputOf,
} from "@sim/sim-worker";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SimulatorClient } from "../../app/simulator-client";
import {
  OPEN_WIRELESS_LAN_DEMO,
  WPA2_WIRELESS_LAN_DEMO,
} from "../../fixtures/wireless-demo-labs";
import { WirelessPanel } from "./WirelessPanel";

class RuntimeClient implements SimulatorClient {
  readonly types: string[] = [];
  private readonly runtime = createSimulationWorkerRuntime();
  private id = 0;

  constructor(document: typeof OPEN_WIRELESS_LAN_DEMO) {
    this.runtime.handleRequest({ type: "INITIALIZE_LAB", requestId: "init", document });
  }

  async request<Type extends SimWorkerRequest["type"]>(
    input: SimWorkerRequestInputOf<Type>,
  ): Promise<SimWorkerPayloadByType[Type]> {
    this.types.push(input.type);
    const response = this.runtime.handleRequest({ ...input, requestId: `wireless-ui-${++this.id}` });
    if (response.type === "REQUEST_FAILED") throw new Error(response.error.message);
    return response.payload as SimWorkerPayloadByType[Type];
  }

  onEvent(_listener: (event: SimWorkerEvent) => void): () => void {
    return () => undefined;
  }
}

afterEach(cleanup);

describe("WirelessPanel", () => {
  it("scans and disconnects a station only through typed worker requests", async () => {
    const client = new RuntimeClient(OPEN_WIRELESS_LAN_DEMO);
    render(<WirelessPanel
      client={client}
      deviceId="laptop-1"
      deviceType="laptop"
      onConfigurationChanged={vi.fn()}
      onError={vi.fn()}
    />);

    expect((await screen.findAllByText("LAB-OPEN")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    await waitFor(() => expect(client.types).toContain("DISCONNECT_WIRELESS_NETWORK"));
    await userEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(client.types).toContain("SCAN_WIRELESS_NETWORKS"));
    expect(screen.queryByText(/credentialVerifier|hashBase64/iu)).toBeNull();
  });

  it("shows only the current password input and clears it after creating a verifier", async () => {
    const client = new RuntimeClient(WPA2_WIRELESS_LAN_DEMO);
    const changed = vi.fn();
    render(<WirelessPanel
      client={client}
      deviceId="ap-1"
      deviceType="access-point"
      onConfigurationChanged={changed}
      onError={vi.fn()}
    />);

    const password = await screen.findByPlaceholderText("Security key configured") as HTMLInputElement;
    expect(password.type).toBe("password");
    await userEvent.type(password, "updated-wireless-key");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(password.value).toBe("");
    const document = changed.mock.calls[0]?.[0];
    expect(JSON.stringify(document)).not.toContain("updated-wireless-key");
    expect(JSON.stringify(document)).not.toMatch(/passphrase/iu);
    expect(client.types).toEqual(expect.arrayContaining([
      "GET_AP_CLIENTS",
      "CONFIGURE_ACCESS_POINT",
    ]));
  });
});
