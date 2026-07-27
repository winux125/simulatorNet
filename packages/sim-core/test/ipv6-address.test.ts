import { describe, expect, it } from "vitest";
import {
  bigIntToIpv6,
  combineIpv6Prefix,
  deterministicInterfaceIdentifier,
  deterministicLinkLocalAddress,
  ipv6InPrefix,
  ipv6MulticastMac,
  ipv6Network,
  ipv6ToBigInt,
  isIpv6GlobalUnicast,
  isIpv6LinkLocal,
  isIpv6Multicast,
  normalizeIpv6,
  solicitedNodeMulticast,
} from "@sim/sim-core";

describe("IPv6 address values", () => {
  it.each([
    ["2001:0db8:0000:0000:0000:ff00:0042:8329", "2001:db8::ff00:42:8329"],
    ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["::ffff:192.0.2.128", "::ffff:c000:280"],
  ])("canonicalizes %s", (input, expected) => {
    expect(normalizeIpv6(input)).toBe(expected);
    expect(bigIntToIpv6(ipv6ToBigInt(input))).toBe(expected);
  });

  it.each([
    ["2001:::1"],
    ["2001:db8:1"],
    ["2001:db8::1::2"],
    ["gggg::1"],
    ["fe80::1%eth0"],
  ])("rejects malformed address %s", (input) => {
    expect(() => ipv6ToBigInt(input)).toThrow(/Invalid IPv6/);
  });

  it("calculates prefixes and scope", () => {
    expect(ipv6Network("2001:db8:10::abcd", 64)).toBe("2001:db8:10::");
    expect(ipv6InPrefix("2001:db8:10::20", "2001:db8:10::", 64)).toBe(true);
    expect(ipv6InPrefix("2001:db8:11::20", "2001:db8:10::", 64)).toBe(false);
    expect(isIpv6GlobalUnicast("2001:db8::1")).toBe(true);
    expect(isIpv6LinkLocal("fe80::1")).toBe(true);
    expect(isIpv6Multicast("ff02::1")).toBe(true);
  });

  it("derives deterministic interface, link-local and multicast addresses", () => {
    const mac = "02:00:00:00:00:01";
    expect(deterministicLinkLocalAddress(mac)).toBe("fe80::ff:fe00:1");
    expect(combineIpv6Prefix("2001:db8:10::", 64, deterministicInterfaceIdentifier(mac)))
      .toBe("2001:db8:10::ff:fe00:1");
    expect(solicitedNodeMulticast("2001:db8::1234:5678")).toBe("ff02::1:ff34:5678");
    expect(ipv6MulticastMac("ff02::1:ff34:5678")).toBe("33:33:ff:34:56:78");
  });

  it.each([-1, 129, 1.5])("rejects prefix length %s", (prefix) => {
    expect(() => ipv6Network("2001:db8::1", prefix)).toThrow(/prefix length/);
  });
});
