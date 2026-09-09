/**
 * The committed synthetic-format fixtures, imported the whole way through:
 * frozen container bytes -> decode -> map -> LabDocument.
 *
 * These are the same three files the Playwright flows drive the browser with,
 * so a failure here localises a break to the conversion rather than the UI.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeLabImport, inspectLabImport } from "../src/plan/plan";
import { inspectPacketTracerFile } from "../src/packet-tracer/inspect";

const DIRECTORY = fileURLToPath(new URL("../../../fixtures/packet-tracer/", import.meta.url));

function fixture(file: string): { filename: string; bytes: Uint8Array } {
  return { filename: file, bytes: new Uint8Array(readFileSync(join(DIRECTORY, file))) };
}

/** `name:iface <-> name:iface`, in the source cable's own direction. */
function edges(document: { topology: { nodes: ReadonlyArray<{ id: string; name: string }>; links: ReadonlyArray<{ a: { node: string; iface: string }; b: { node: string; iface: string } }> } }): string[] {
  const names = new Map(document.topology.nodes.map((node) => [node.id, node.name]));
  return document.topology.links
    .map((link) => `${names.get(link.a.node)}:${link.a.iface} <-> ${names.get(link.b.node)}:${link.b.iface}`)
    .sort();
}

describe("basic-lab.pkt", () => {
  it("imports two hosts and a switch with the cabling intact", async () => {
    const plan = await inspectLabImport(fixture("basic-lab.pkt"));
    const { document } = executeLabImport(plan);

    expect(plan.format).toBe("packet-tracer-pkt");
    expect(plan.importable).toBe(true);
    expect(document.topology.nodes.map((node) => node.name).sort()).toEqual(["PC0", "PC1", "Switch0"]);
    expect(edges(document)).toEqual([
      "PC0:eth0 <-> Switch0:Fa0/1",
      "Switch0:Fa0/2 <-> PC1:eth0",
    ]);
  });

  it("keeps the source's relative placement", async () => {
    const plan = await inspectLabImport(fixture("basic-lab.pkt"));
    const { document } = executeLabImport(plan);
    const at = (name: string) => document.topology.nodes.find((node) => node.name === name)!.position!;

    // PC0 (160,320) and PC1 (520,320) sit either side of and below Switch0 (340,180).
    expect(at("PC0").x).toBeLessThan(at("Switch0").x);
    expect(at("PC1").x).toBeGreaterThan(at("Switch0").x);
    expect(at("PC0").y).toBeGreaterThan(at("Switch0").y);
  });

  it("carries no runtime state or raw source bytes into the document", async () => {
    const plan = await inspectLabImport(fixture("basic-lab.pkt"));
    const { document } = executeLabImport(plan);

    expect(document.sourceImport).toMatchObject({
      platform: "packet-tracer",
      originalFilename: "basic-lab.pkt",
    });
    // Only metadata: the container itself is never persisted.
    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain("PACKETTRACER5");
    expect(serialized.length).toBeLessThan(200_000);
  });
});

describe("configured-lab.pkt", () => {
  it("applies router and switch running-configs through the shared parser", async () => {
    const plan = await inspectLabImport(fixture("configured-lab.pkt"));
    const { document, report } = executeLabImport(plan);
    const r1 = document.topology.nodes.find((node) => node.name === "R1")!;

    expect(r1.kind).toBe("router");
    expect(report.importedStartupConfigs).toBe(2);
    expect(document.configurations[r1.id]).toMatchObject({
      kind: "router",
      hostname: "R1",
      interfaces: expect.arrayContaining([
        expect.objectContaining({ id: "Gi0/0", ipv4: { address: "192.168.10.1", prefixLength: 24 } }),
        expect.objectContaining({ id: "Gi0/1", ipv4: { address: "10.20.0.1", prefixLength: 30 } }),
      ]),
    });
    // Indentation must survive the XML reader or every sub-command is demoted.
    expect(report.entries.some((entry) => entry.code === "config-unparsed")).toBe(false);
  });

  it("keeps the router's static default route", async () => {
    const plan = await inspectLabImport(fixture("configured-lab.pkt"));
    const { document } = executeLabImport(plan);
    const r1 = document.topology.nodes.find((node) => node.name === "R1")!;
    const config = document.configurations[r1.id];

    expect(config).toMatchObject({
      staticRoutes: expect.arrayContaining([
        expect.objectContaining({ network: "0.0.0.0", prefixLength: 0, nextHop: "10.20.0.2" }),
      ]),
    });
  });

  it("carries static host addressing as structured configuration", async () => {
    const plan = await inspectLabImport(fixture("configured-lab.pkt"));
    const { document } = executeLabImport(plan);
    const pc0 = document.topology.nodes.find((node) => node.name === "PC0")!;

    expect(document.configurations[pc0.id]).toMatchObject({
      kind: "pc",
      dhcpEnabled: false,
      ipv4: { address: "192.168.10.10", prefixLength: 24, defaultGateway: "192.168.10.1" },
    });
  });

  it("sizes the switch for its chassis, not for its cabling", async () => {
    const plan = await inspectLabImport(fixture("configured-lab.pkt"));
    const { document } = executeLabImport(plan);
    const switchNode = document.topology.nodes.find((node) => node.name === "Switch0")!;

    expect(switchNode.hardwareProfileId).toBe("access-24");
    expect(switchNode.interfaces.map((iface) => iface.id)).toContain("Fa0/24");
  });

  it("wires the router to the switch and both hosts to access ports", async () => {
    const plan = await inspectLabImport(fixture("configured-lab.pkt"));
    const { document } = executeLabImport(plan);

    expect(edges(document)).toEqual([
      "R1:Gi0/0 <-> Switch0:Fa0/1",
      "Switch0:Fa0/2 <-> PC0:eth0",
      "Switch0:Fa0/3 <-> PC1:eth0",
    ]);
  });
});

describe("activity.pka", () => {
  it("offers both networks and defaults to the initial one", async () => {
    const inspection = await inspectPacketTracerFile(fixture("activity.pka"));

    expect(inspection.format).toBe("packet-tracer-pka");
    expect(inspection.activityTitle).toBe("Connect two hosts through a switch");
    expect(inspection.activityInstructions).toContain("192.168.20.0/24");
    expect(inspection.requiresNetworkChoice).toBe(true);
    expect(inspection.networks.map((network) => network.role).sort()).toEqual(["answer", "initial"]);

    const selected = inspection.networks.find((network) => network.id === inspection.selectedNetworkId)!;
    expect(selected.role).toBe("initial");
    expect(selected.deviceCount).toBe(2);
    expect(selected.linkCount).toBe(1);
  });

  it("imports the initial network by default, unsolved", async () => {
    const inspection = await inspectPacketTracerFile(fixture("activity.pka"));
    const { document } = executeLabImport(inspection.plan);

    expect(document.topology.nodes).toHaveLength(2);
    // The initial network's PC0 is unaddressed — that is the exercise. It still
    // gets the standard empty host configuration every PC opens with.
    const pc0 = document.topology.nodes.find((node) => node.name === "PC0")!;
    expect(document.configurations[pc0.id]).toMatchObject({ kind: "pc", ipv4: undefined, dhcpEnabled: false });
  });

  it("imports the answer network only when it is explicitly chosen", async () => {
    const first = await inspectPacketTracerFile(fixture("activity.pka"));
    const answerId = first.networks.find((network) => network.role === "answer")!.id;
    const chosen = await inspectPacketTracerFile(fixture("activity.pka"), { networkId: answerId });
    const { document } = executeLabImport(chosen.plan);

    expect(chosen.selectedNetworkId).toBe(answerId);
    expect(document.topology.nodes).toHaveLength(3);
    const pc0 = document.topology.nodes.find((node) => node.name === "PC0")!;
    expect(document.configurations[pc0.id]).toMatchObject({
      ipv4: { address: "192.168.20.10", prefixLength: 24 },
    });
  });

  it("names the lab after the activity and the chosen network", async () => {
    const inspection = await inspectPacketTracerFile(fixture("activity.pka"));
    const { document } = executeLabImport(inspection.plan);
    expect(document.title).toContain("Connect two hosts through a switch");
  });
});
