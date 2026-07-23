import type { LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import {
  nextExampleAddress,
  prefixLengthToMask,
  subnetMaskToPrefix,
  validateHostIpFields,
} from "./host-ip-validation";

describe("host IP form validation", () => {
  it("converts only contiguous masks", () => {
    expect(subnetMaskToPrefix("255.255.255.0")).toBe(24);
    expect(prefixLengthToMask(20)).toBe("255.255.240.0");
    expect(subnetMaskToPrefix("255.0.255.0")).toBeUndefined();
  });

  it("returns field-level address, mask, gateway and DNS errors", () => {
    expect(validateHostIpFields({
      address: "",
      subnetMask: "255.0.255.0",
      defaultGateway: "",
      dnsServer: "999.1.1.1",
    }).errors).toEqual({
      address: "IPv4 address is required.",
      subnetMask: "Subnet mask must contain contiguous bits.",
      dnsServer: "DNS server must be a valid IPv4 address.",
    });
    expect(validateHostIpFields({
      address: "192.168.10.0",
      subnetMask: "255.255.255.0",
      defaultGateway: "192.168.20.1",
      dnsServer: "1.1.1.1",
    }).errors).toEqual({
      address: "The address is the network address.",
      defaultGateway: "Default gateway must be in the same subnet.",
    });
    expect(validateHostIpFields({
      address: "192.168.10.255",
      subnetMask: "255.255.255.0",
      defaultGateway: "",
      dnsServer: "",
    }).errors.address).toBe("The address is the broadcast address.");
  });

  it("chooses the next unused deterministic example address", () => {
    const document = {
      configurations: {
        "pc-1": { kind: "pc", interfaces: [], dhcpEnabled: false, ipv4: { address: "192.168.10.10", prefixLength: 24 } },
        "pc-2": { kind: "pc", interfaces: [], dhcpEnabled: false },
      },
    } as unknown as LabDocument;
    expect(nextExampleAddress(document, "pc-2")).toBe("192.168.10.20");
  });
});
