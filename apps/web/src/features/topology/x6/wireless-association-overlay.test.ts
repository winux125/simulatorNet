import { describe, expect, it } from "vitest";
import {
  isWirelessAssociationEdgeId,
  wirelessAssociationEdgeAppearance,
  wirelessAssociationEdgeId,
} from "./wireless-association-overlay";

describe("wireless association overlay projection", () => {
  it("uses a namespaced runtime-only id and an SSID label", () => {
    const appearance = wirelessAssociationEdgeAppearance({
      id: "wireless:laptop-1:ap-1",
      stationDeviceId: "laptop-1",
      accessPointDeviceId: "ap-1",
      ssid: "LAB-WLAN",
      state: "associated",
    });

    expect(appearance).toMatchObject({
      id: "runtime-wireless:wireless:laptop-1:ap-1",
      label: "LAB-WLAN",
      dashArray: "5 4",
    });
    expect(isWirelessAssociationEdgeId(appearance.id)).toBe(true);
    expect(isWirelessAssociationEdgeId("physical-link-1")).toBe(false);
  });

  it.each([
    ["authenticating", "2 4"],
    ["associating", "2 4"],
    ["failed", "2 4"],
    ["associated", "5 4"],
  ] as const)("projects %s state without structural endpoint fields", (state, dashArray) => {
    const appearance = wirelessAssociationEdgeAppearance({
      id: "association",
      stationDeviceId: "station",
      accessPointDeviceId: "ap",
      ssid: "SSID",
      state,
    });
    expect(appearance.dashArray).toBe(dashArray);
    expect(appearance).not.toHaveProperty("sourceInterfaceId");
    expect(appearance).not.toHaveProperty("targetInterfaceId");
    expect(wirelessAssociationEdgeId("association")).toBe(appearance.id);
  });
});
