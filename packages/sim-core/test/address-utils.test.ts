import { describe, expect, it } from "vitest";
import { intToIp, ipToInt, macFromIndex, maskToInt, networkAddress, sameSubnet } from "@sim/sim-core";

describe("IPv4 helpers", () => {
  it("round-trips dotted <-> integer", () => {
    expect(ipToInt("192.168.1.1")).toBe(0xc0a80101);
    expect(intToIp(0xc0a80101)).toBe("192.168.1.1");
    expect(intToIp(ipToInt("255.255.255.255"))).toBe("255.255.255.255");
    expect(intToIp(ipToInt("0.0.0.0"))).toBe("0.0.0.0");
  });

  it("rejects malformed addresses", () => {
    expect(() => ipToInt("192.168.1")).toThrow();
    expect(() => ipToInt("192.168.1.256")).toThrow();
    expect(() => ipToInt("a.b.c.d")).toThrow();
  });

  it("converts prefix length or dotted mask to the same 32-bit value", () => {
    expect(maskToInt(24)).toBe(maskToInt("255.255.255.0"));
    expect(maskToInt(0)).toBe(0);
    expect(maskToInt(32) >>> 0).toBe(0xffffffff);
    expect(() => maskToInt(33)).toThrow();
  });

  it("computes subnet membership and network address", () => {
    expect(sameSubnet("192.168.1.10", "192.168.1.200", 24)).toBe(true);
    expect(sameSubnet("192.168.1.10", "192.168.2.10", 24)).toBe(false);
    expect(networkAddress("192.168.1.200", 24)).toBe(ipToInt("192.168.1.0"));
  });
});

describe("MAC helpers", () => {
  it("generates deterministic, locally-administered MACs from an index", () => {
    expect(macFromIndex(1)).toBe("02:00:00:00:00:01");
    expect(macFromIndex(0x010203)).toBe("02:00:00:01:02:03");
    expect(macFromIndex(5)).toBe(macFromIndex(5));
  });
});
