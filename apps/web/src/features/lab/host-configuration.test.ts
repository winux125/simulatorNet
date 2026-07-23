import type { LabDocument } from "@sim/contracts";
import { parseLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  hostIpConfigurationFromDocument,
  withHostDhcpMode,
  withHostStaticConfiguration,
} from "./document";

const draft: LabDocument = {
  schemaVersion: 1,
  id: "host-persistence",
  title: "Host persistence",
  simulation: { seed: 5 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
      { id: "server-1", kind: "server", name: "SRV1", interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false },
    "server-1": { kind: "server", hostname: "SRV1", interfaces: [], dhcpClientEnabled: false, enabledServices: [] },
  },
};

describe("draft host configuration persistence", () => {
  it("round-trips PC and Server structured static configuration", () => {
    const withPc = withHostStaticConfiguration(draft, "pc-1", {
      address: "192.168.10.10",
      prefixLength: 24,
      dnsServer: "192.168.10.53",
    });
    const withServer = withHostStaticConfiguration(withPc, "server-1", {
      address: "192.168.10.20",
      prefixLength: 24,
      defaultGateway: "192.168.10.1",
    });
    const restored = parseLabDocument(stringifyLabDocument(withServer));
    expect(hostIpConfigurationFromDocument(restored, "pc-1")).toEqual({
      mode: "static",
      address: "192.168.10.10",
      prefixLength: 24,
      defaultGateway: undefined,
      dnsServer: "192.168.10.53",
    });
    expect(hostIpConfigurationFromDocument(restored, "server-1")).toEqual({
      mode: "static",
      address: "192.168.10.20",
      prefixLength: 24,
      defaultGateway: "192.168.10.1",
      dnsServer: undefined,
    });
  });

  it("persists DHCP mode without transient lease state", () => {
    const restored = parseLabDocument(stringifyLabDocument(withHostDhcpMode(draft, "pc-1")));
    expect(restored.configurations["pc-1"]).toMatchObject({ kind: "pc", dhcpEnabled: true });
    expect(restored.configurations["pc-1"]).not.toHaveProperty("lease");
  });
});
