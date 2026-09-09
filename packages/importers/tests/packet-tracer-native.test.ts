/**
 * Native Packet Tracer import, exercised against a container genuinely written
 * by Cisco Packet Tracer where one is available locally, and against
 * synthetic-format containers otherwise.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { executeLabImport, inspectLabImport } from "../src/plan/plan";
import { inspectPacketTracerFile } from "../src/packet-tracer/inspect";
import { detectLabImportFormat } from "../src/detect/detect";

const FIXTURE_DIR = fileURLToPath(new URL("../../../.local-fixtures/packet-tracer/", import.meta.url));

function realFixture(extension: "pkt" | "pka"): { filename: string; bytes: Uint8Array; sha256: string } | undefined {
  const configured = process.env.PACKET_TRACER_REAL_FIXTURES_DIR;
  const directory = configured !== undefined && configured.trim() !== "" ? configured : FIXTURE_DIR;
  try {
    if (!statSync(directory).isDirectory()) return undefined;
    const match = readdirSync(directory).filter((entry) => entry.toLowerCase().endsWith(`.${extension}`)).sort()[0];
    if (match === undefined) return undefined;
    const bytes = new Uint8Array(readFileSync(join(directory, match)));
    return { filename: match, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    return undefined;
  }
}

const realPkt = realFixture("pkt");
const realPka = realFixture("pka");

describe("Packet Tracer detection", () => {
  it("reports a .pkt as a supported format", () => {
    const detection = detectLabImportFormat({ filename: "lab.pkt", bytes: new Uint8Array(64).fill(0x42) });
    expect(detection.format).toBe("packet-tracer-pkt");
    expect(detection.supported).toBe(true);
  });

  it("reports a .pka as a supported format", () => {
    const detection = detectLabImportFormat({ filename: "activity.pka", bytes: new Uint8Array(64).fill(0x42) });
    expect(detection.format).toBe("packet-tracer-pka");
    expect(detection.supported).toBe(true);
  });
});

describe.runIf(realPkt)("real Packet Tracer .pkt import", () => {
  const source = { filename: realPkt?.filename, bytes: realPkt?.bytes ?? new Uint8Array() };

  it("inspects into a plan with every device preserved", async () => {
    const inspection = await inspectPacketTracerFile(source);

    expect(inspection.format).toBe("packet-tracer-pkt");
    expect(inspection.packetTracerVersion).toMatch(/^\d+\./u);
    expect(inspection.networks).toHaveLength(1);
    expect(inspection.requiresNetworkChoice).toBe(false);

    // Five devices in the file; none may be dropped, including the one whose
    // model SimulatorNet does not simulate.
    expect(inspection.plan.proposals).toHaveLength(5);
    const labels = inspection.plan.proposals.map((proposal) => proposal.label).sort();
    expect(labels).toEqual(["192.168.1.2", "PC0", "PC1", "Power Distribution Device0", "Switch0"]);
  });

  it("maps models onto SimulatorNet device types", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const byLabel = new Map(plan.proposals.map((proposal) => [proposal.label, proposal]));

    expect(byLabel.get("PC0")?.suggestedDeviceType).toBe("pc");
    expect(byLabel.get("PC1")?.suggestedDeviceType).toBe("pc");
    expect(byLabel.get("192.168.1.2")?.suggestedDeviceType).toBe("server");
    expect(byLabel.get("Switch0")?.suggestedDeviceType).toBe("l2-switch");
    // A model with no SimulatorNet equivalent stays a placeholder rather than
    // being forced into the nearest device type.
    expect(byLabel.get("Power Distribution Device0")?.suggestedDeviceType).toBeUndefined();
  });

  it("preserves link endpoints through the interface mapping", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const result = executeLabImport(plan);
    const nameById = new Map(result.document.topology.nodes.map((node) => [node.id, node.name]));

    const edges = result.document.topology.links
      .map((link) => `${nameById.get(link.a.node)}:${link.a.iface} <-> ${nameById.get(link.b.node)}:${link.b.iface}`)
      .sort();

    // Endpoint order follows the source cable's own FROM/TO, which the
    // importer must not silently reorder.
    expect(edges).toEqual([
      "PC0:eth0 <-> Switch0:Fa0/1",
      "PC1:eth0 <-> Switch0:Fa0/3",
      "Switch0:Fa0/2 <-> 192.168.1.2:eth0",
    ]);
  });

  it("gives the switch a hardware profile large enough for its cabling", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const { document } = executeLabImport(plan);
    const switchNode = document.topology.nodes.find((node) => node.name === "Switch0")!;

    expect(switchNode.kind).toBe("l2-switch");
    // The source is a 2960-24TT, so the profile must have at least 24 access
    // ports — never a smaller one that could not hold the lab's cabling.
    expect(switchNode.hardwareProfileId).toBe("access-24");
    const ids = switchNode.interfaces.map((iface) => iface.id);
    expect(ids).toContain("Fa0/1");
    expect(ids).toContain("Fa0/24");
    expect(ids).toContain("Gi0/1");
  });

  it("routes the switch running-config through the shared IOS parser", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const result = executeLabImport(plan);

    const artifact = result.sourceArtifacts.find((entry) => entry.text.includes("hostname Switch"));
    expect(artifact, "the switch's running-config should be preserved").toBeDefined();
    expect(result.report.importedStartupConfigs).toBeGreaterThan(0);
    // The shared parser reports what it applied; this importer never parses
    // configuration itself.
    expect(result.report.entries.some((entry) => entry.code === "config-applied")).toBe(true);

    // The indentation of each <LINE> must survive the XML reader, or every
    // sub-command below "hostname" would be quietly demoted to unparsed.
    expect(artifact!.text).toMatch(/\n [a-z]/u);
    const switchNode = result.document.topology.nodes.find((node) => node.name === "Switch0")!;
    expect(result.document.configurations[switchNode.id]?.kind).toBe("l2-switch");
  });

  it("carries host addressing across as structured configuration", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const { document } = executeLabImport(plan);
    const pc0 = document.topology.nodes.find((node) => node.name === "PC0")!;
    const config = document.configurations[pc0.id];

    expect(config?.kind).toBe("pc");
    // PC0 is a DHCP client in the source and must not arrive as a static host.
    expect(config).toMatchObject({ dhcpEnabled: true });
  });

  it("preserves relative canvas placement", async () => {
    const { plan } = await inspectPacketTracerFile(source);
    const { document } = executeLabImport(plan);
    const at = (name: string): { x: number; y: number } =>
      document.topology.nodes.find((node) => node.name === name)!.position!;

    // In the source PC0 (181.5, 356) sits left of and below Switch0 (334, 196).
    expect(at("PC0").x).toBeLessThan(at("Switch0").x);
    expect(at("PC0").y).toBeGreaterThan(at("Switch0").y);
    // PC1 (359.5, 366) sits right of PC0.
    expect(at("PC1").x).toBeGreaterThan(at("PC0").x);
  });

  it("produces a document that passes canonical validation", async () => {
    const plan = await inspectLabImport({ filename: source.filename, bytes: source.bytes });
    expect(plan.importable).toBe(true);
    const { document } = executeLabImport(plan);
    expect(document.schemaVersion).toBe(1);
    expect(document.topology.nodes).toHaveLength(5);
    expect(document.sourceImport?.platform).toBe("packet-tracer");
  });
});

describe.runIf(realPka)("real Packet Tracer .pka import", () => {
  const source = { filename: realPka?.filename, bytes: realPka?.bytes ?? new Uint8Array() };

  it("discovers every contained network and offers the choice", async () => {
    const inspection = await inspectPacketTracerFile(source);

    expect(inspection.format).toBe("packet-tracer-pka");
    expect(inspection.packetTracerVersion).toMatch(/^\d+\./u);
    expect(inspection.networks.length).toBeGreaterThan(1);
    expect(inspection.requiresNetworkChoice).toBe(true);
    // Every network is offered with the counts needed to tell them apart.
    for (const network of inspection.networks) {
      expect(network.deviceCount).toBeGreaterThan(0);
      expect(network.name.length).toBeGreaterThan(0);
    }
  });

  it("builds a real topology from the selected network", async () => {
    const inspection = await inspectPacketTracerFile(source);
    const { document, report } = executeLabImport(inspection.plan);

    expect(document.topology.nodes.length).toBeGreaterThan(1);
    expect(document.topology.links.length).toBeGreaterThan(0);
    expect(document.sourceImport?.platform).toBe("packet-tracer");
    // Routers and switches arrived as routers and switches, not placeholders.
    const kinds = new Set(document.topology.nodes.map((node) => node.kind));
    expect(kinds.has("router")).toBe(true);
    expect(kinds.has("l2-switch")).toBe(true);
    expect(report.importedNodeCount).toBeGreaterThan(0);
  });

  it("imports a different network when one is chosen", async () => {
    const first = await inspectPacketTracerFile(source);
    const other = first.networks.find((network) => network.id !== first.selectedNetworkId)!;
    const chosen = await inspectPacketTracerFile(source, { networkId: other.id });

    expect(chosen.selectedNetworkId).toBe(other.id);
    expect(chosen.plan.parsed.nodes).toHaveLength(other.deviceCount);
  });

  it("reports every link it could not place instead of rewiring the lab", async () => {
    const inspection = await inspectPacketTracerFile(source);
    const { document } = executeLabImport(inspection.plan);
    const selected = inspection.networks.find((network) => network.id === inspection.selectedNetworkId)!;

    const unmapped = inspection.plan.report.entries
      .filter((entry) => entry.code === "packet-tracer-link-unmapped").length;
    // Every source cable is either created or named in the report; none is
    // quietly dropped and none is invented.
    expect(document.topology.links.length + unmapped).toBe(selected.linkCount);
  });
});
