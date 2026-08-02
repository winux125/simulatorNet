import type { LabDocument, LabMetadata } from "@sim/contracts";
import { createCliSession } from "@sim/cli-engine";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  deviceConfigurationDrift,
  eraseStartupConfiguration,
  reloadDevice,
  renderDeviceRunningConfiguration,
  renderDeviceStartupConfiguration,
  runningConfigurationOf,
  saveRunningConfiguration,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const metadata: LabMetadata = { id: "lab-cfg", title: "Configuration lifecycle" };

/** Two routers and a PC, so a reload can be shown not to touch the neighbours. */
function labDocument(): LabDocument {
  return canonicalizeLabDocument({
    schemaVersion: 1,
    ...metadata,
    simulation: { seed: 11 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "r2", kind: "router", name: "R2", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "link-1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "r2", iface: "Gi0/0" } },
        { id: "link-2", a: { node: "r1", iface: "Gi0/1" }, b: { node: "pc1", iface: "eth0" } },
      ],
    },
    configurations: {
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [
          { id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.1", prefixLength: 30 } },
          { id: "Gi0/1", routed: true, ipv4: { address: "192.168.1.1", prefixLength: 24 } },
        ],
      },
      r2: {
        kind: "router",
        hostname: "R2",
        interfaces: [{ id: "Gi0/0", routed: true, ipv4: { address: "10.0.0.2", prefixLength: 30 } }],
        // A return route, so a ping across the reloaded router proves both of
        // its cables came back rather than only the local one.
        staticRoutes: [{ network: "192.168.1.0", prefixLength: 24, nextHop: "10.0.0.1" }],
      },
      pc1: {
        kind: "pc",
        hostname: "PC1",
        ipv4: { address: "192.168.1.10", prefixLength: 24, defaultGateway: "192.168.1.1" },
      },
    },
  });
}

describe("running and startup configuration lifecycle", () => {
  it("treats a document with no startup snapshot as saved", () => {
    const built = buildLabFromDocument(labDocument());
    expect(built.startupConfigurationOf("r1")).toBeUndefined();
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("saved");
    // `show startup-config` falls back to the running configuration, so an
    // older lab never looks like it lost its configuration.
    expect(renderDeviceStartupConfiguration(built, "r1")).toBe(renderDeviceRunningConfiguration(built, "r1"));
    expect(serializeLabDocument(built, metadata).startupConfigurations).toBeUndefined();
  });

  it("copies running to startup and detects drift afterwards", () => {
    const built = buildLabFromDocument(labDocument());
    saveRunningConfiguration(built, "r1");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("saved");

    built.getRouter("r1")!.rename("R1-EDGE");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("modified");
    expect(renderDeviceRunningConfiguration(built, "r1")).toContain("hostname R1-EDGE");
    expect(renderDeviceStartupConfiguration(built, "r1")).toContain("hostname R1");

    saveRunningConfiguration(built, "r1");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("saved");
  });

  it("erases the startup configuration without touching the running one", () => {
    const built = buildLabFromDocument(labDocument());
    saveRunningConfiguration(built, "r1");
    eraseStartupConfiguration(built, "r1");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("no-startup-configuration");
    expect(renderDeviceStartupConfiguration(built, "r1")).toBe("% startup-config is not present\n");
    expect(renderDeviceRunningConfiguration(built, "r1")).toContain("ip address 10.0.0.1 255.255.255.252");
  });

  it("restores the startup configuration on reload and clears device runtime", () => {
    const built = buildLabFromDocument(labDocument());
    saveRunningConfiguration(built, "r1");

    // Give R1 some runtime state and an unsaved change.
    built.getPc("pc1")!.ping("10.0.0.2", 1);
    built.engine.runUntilIdle();
    expect(built.getPc("pc1")!.pingResults.at(-1)).toMatchObject({ sequence: 1, success: true });
    expect(built.getRouter("r1")!.arpTable.size).toBeGreaterThan(0);
    built.getRouter("r1")!.addStaticRoute("172.16.0.0", 16, "10.0.0.2");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("modified");

    const result = reloadDevice(built, "r1");
    expect(result.bootedDefaults).toBe(false);
    expect(result.restoredLinks).toBe(2);
    // The unsaved route is gone and the ARP cache went with the old instance.
    expect(renderDeviceRunningConfiguration(built, "r1")).not.toContain("ip route 172.16.0.0");
    expect(built.getRouter("r1")!.arpTable.size).toBe(0);
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("saved");

    // The reloaded device is cabled again and forwards immediately.
    built.getPc("pc1")!.ping("10.0.0.2", 2);
    built.engine.runUntilIdle();
    expect(built.getPc("pc1")!.pingResults.at(-1)).toMatchObject({ sequence: 2, success: true });
  });

  it("saves first when a reload is answered with yes", () => {
    const built = buildLabFromDocument(labDocument());
    built.getRouter("r1")!.addStaticRoute("172.16.0.0", 16, "10.0.0.2");
    reloadDevice(built, "r1", { save: true });
    expect(renderDeviceRunningConfiguration(built, "r1")).toContain("ip route 172.16.0.0 255.255.0.0 10.0.0.2");
    expect(deviceConfigurationDrift(built, "r1").drift).toBe("saved");
  });

  it("boots factory defaults after the NVRAM was erased", () => {
    const built = buildLabFromDocument(labDocument());
    eraseStartupConfiguration(built, "r1");
    const result = reloadDevice(built, "r1");
    expect(result.bootedDefaults).toBe(true);
    const text = renderDeviceRunningConfiguration(built, "r1");
    expect(text).not.toContain("ip address 10.0.0.1");
    expect(text).toContain("hostname R1");
  });

  it("leaves every other device untouched", () => {
    const built = buildLabFromDocument(labDocument());
    built.getPc("pc1")!.ping("10.0.0.2", 1);
    built.engine.runUntilIdle();
    const neighbourArp = built.getRouter("r2")!.arpTable.size;
    expect(neighbourArp).toBeGreaterThan(0);
    const virtualTime = built.engine.now();
    const otherSession = createCliSession(built.getRouter("r2")!, built.engine);
    otherSession.execute("enable");

    reloadDevice(built, "r1");

    expect(built.getRouter("r2")!.arpTable.size).toBe(neighbourArp);
    expect(built.getDevice("r2")).toBeDefined();
    expect(built.engine.now()).toBeGreaterThanOrEqual(virtualTime);
    // A session on another device is still authenticated and usable.
    expect(otherSession.prompt()).toBe("R2#");
  });

  it("round-trips startup snapshots through the canonical document", () => {
    const built = buildLabFromDocument(labDocument());
    saveRunningConfiguration(built, "r1");
    eraseStartupConfiguration(built, "r2");
    const serialized = serializeLabDocument(built, metadata);
    expect(serialized.startupConfigurations?.r1).toMatchObject({ state: "saved" });
    expect(serialized.startupConfigurations?.r2).toEqual({ state: "absent" });

    const rebuilt = buildLabFromDocument(serialized);
    expect(deviceConfigurationDrift(rebuilt, "r1").drift).toBe("saved");
    expect(deviceConfigurationDrift(rebuilt, "r2").drift).toBe("no-startup-configuration");
    expect(stringifyLabDocument(serializeLabDocument(rebuilt, metadata))).toBe(stringifyLabDocument(serialized));
  });

  it("keeps a startup snapshot comparable to the canonical running configuration", () => {
    const built = buildLabFromDocument(labDocument());
    saveRunningConfiguration(built, "r1");
    const startup = built.startupConfigurationOf("r1");
    expect(startup?.state).toBe("saved");
    if (startup?.state !== "saved") throw new Error("expected a saved snapshot");
    // Both sides go through the same canonicalization, so defaults can never
    // make an untouched device look modified.
    expect(startup.configuration).toEqual(runningConfigurationOf(built, "r1"));
  });
});
