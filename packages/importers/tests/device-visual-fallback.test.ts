import { describe, expect, it } from "vitest";
import { resolveDeviceMapping } from "@sim/importers";

describe("built-in device visual fallback mappings", () => {
  it("maps supported source kinds to the closest built-in silhouettes", () => {
    const mappings = [
      ["iol-l2", "l2-switch"],
      ["iosv", "router"],
      ["csr1000v", "router"],
      ["nxos", "l3-switch"],
      ["multilayer-switch", "l3-switch"],
      ["asav", "firewall"],
      ["fortigate", "firewall"],
      ["vsrx", "firewall"],
      ["vpcs", "pc"],
      ["linux-server", "server"],
      ["wifi-ap", "access-point"],
      ["home-router", "wireless-router"],
    ] as const;

    for (const [sourceKind, expected] of mappings) {
      expect(resolveDeviceMapping("pnetlab", sourceKind).targetDeviceType).toBe(expected);
    }
  });

  it("keeps unknown source kinds as External Appliance placeholders", () => {
    const mapping = resolveDeviceMapping("eve-ng", "vendor-mystery-9000");
    expect(mapping.targetDeviceType).toBeUndefined();
    expect(mapping.supportLevel).toBe("visual-placeholder");
  });
});
