import { describe, expect, it } from "vitest";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { ExternalApplianceDeviceConfig, LabDocument } from "@sim/contracts";
import {
  executeLabImport,
  inspectLabImport,
  planFromParsed,
  registerImportAdapter,
  type ImportSource,
  type LabImportAdapter,
  type ParsedSourceTopology,
} from "@sim/importers";

function parsed(): ParsedSourceTopology {
  return {
    platform: "containerlab",
    format: "containerlab-yaml",
    sourceVersion: "0.48",
    labTitle: "Campus Core",
    nodes: [
      { id: "r1", label: "R1", sourceKind: "generic-router", interfaces: ["eth1", "eth2"], authLikelyRequired: true },
      { id: "sw1", label: "SW1", sourceKind: "ethernet-switch", interfaces: ["eth1", "eth2"] },
      { id: "pc1", label: "PC1", sourceKind: "vpcs", interfaces: ["eth0"] },
      {
        id: "fw1",
        label: "FW1",
        sourceKind: "acme-widget-9000",
        vendor: "Acme",
        interfaces: ["eth0", "eth1"],
        startupConfig: "set security policy allow\n",
        authLikelyRequired: true,
      },
    ],
    links: [
      { id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "sw1", iface: "eth1" } },
      { id: "l2", a: { node: "sw1", iface: "eth2" }, b: { node: "r1", iface: "eth1" } },
    ],
    annotations: [],
    assets: [],
    ignoredFiles: ["readme.md"],
    ignoredVendorImages: ["acme-9000.qcow2"],
    notes: [],
  };
}

describe("import plan and execution", () => {
  it("suggests supported device types and a placeholder for the unknown node", () => {
    const plan = planFromParsed(parsed(), "campus.clab.yml");
    const byId = new Map(plan.proposals.map((proposal) => [proposal.sourceNodeId, proposal]));
    expect(byId.get("r1")?.suggestedDeviceType).toBe("router");
    expect(byId.get("sw1")?.suggestedDeviceType).toBe("l2-switch");
    expect(byId.get("pc1")?.suggestedDeviceType).toBe("pc");
    expect(byId.get("fw1")?.suggestedDeviceType).toBeUndefined();
    expect(byId.get("fw1")?.supportLevel).toBe("visual-placeholder");
  });

  it("preserves an unmapped node as an external-appliance placeholder", () => {
    const result = executeLabImport(planFromParsed(parsed(), "campus.clab.yml"));
    const node = result.document.topology.nodes.find((candidate) => candidate.id === "fw1")!;
    expect(node.kind).toBe("external-appliance");
    expect(node.interfaces.map((iface) => iface.id).sort()).toEqual(["eth0", "eth1"]);
    const config = result.document.configurations.fw1 as ExternalApplianceDeviceConfig;
    expect(config.kind).toBe("external-appliance");
    expect(config.sourcePlatform).toBe("containerlab");
    expect(config.sourceVendor).toBe("Acme");
    expect(config.sourceNodeKind).toBe("acme-widget-9000");
    expect(config.authHint).toBe("likely-required");
    expect(config.unparsedConfig).toContain("set security policy allow");
    expect(result.sourceArtifacts.find((artifact) => artifact.nodeId === "fw1")?.text).toContain("set security policy allow");
  });

  it("builds a deterministic mapping plan and canonical report/document", () => {
    const a = executeLabImport(planFromParsed(parsed(), "campus.clab.yml"));
    const b = executeLabImport(planFromParsed(parsed(), "campus.clab.yml"));
    expect(planFromParsed(parsed()).proposals).toEqual(planFromParsed(parsed()).proposals);
    expect(stringifyLabDocument(a.document)).toBe(stringifyLabDocument(b.document));
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
    expect(a.report.mappedDeviceTypes).toMatchObject({ router: 1, "l2-switch": 1, pc: 1, "external-appliance": 1 });
    expect(a.report.ignoredVendorImages).toEqual(["acme-9000.qcow2"]);
    expect(a.report.unsupportedDeviceTypes).toEqual(["acme-widget-9000"]);
  });

  it("selects the nearest switch hardware profile while preserving imported port names", () => {
    const source = parsed();
    source.nodes.find((node) => node.id === "sw1")!.interfaces = Array.from(
      { length: 24 },
      (_, index) => `Ethernet${index + 1}`,
    );
    source.links = [];
    const result = executeLabImport(planFromParsed(source, "access.unl"));
    const node = result.document.topology.nodes.find((candidate) => candidate.id === "sw1")!;
    expect(node.hardwareProfileId).toBe("access-24");
    expect(node.interfaces.map((iface) => iface.id)).toEqual(expect.arrayContaining(["Ethernet1", "Ethernet24"]));
  });

  it("lets the user override a suggestion with a placeholder or exclusion", () => {
    const plan = planFromParsed(parsed(), "campus.clab.yml");
    const result = executeLabImport(plan, { r1: { kind: "placeholder" }, pc1: { kind: "exclude" } });
    const kinds = new Map(result.document.topology.nodes.map((node) => [node.id, node.kind]));
    expect(kinds.get("r1")).toBe("external-appliance");
    expect(kinds.has("pc1")).toBe(false);
    // The link to the excluded PC is dropped so the document stays valid.
    expect(result.document.topology.links.some((link) => link.a.node === "pc1" || link.b.node === "pc1")).toBe(false);
  });

  it("inspection is pure data and never builds a sim-core lab", async () => {
    const adapter: LabImportAdapter = {
      format: "containerlab-yaml",
      platform: "containerlab",
      parse: async () => parsed(),
    };
    registerImportAdapter(adapter);
    const source: ImportSource = {
      filename: "campus.clab.yml",
      bytes: new TextEncoder().encode("name: x\ntopology:\n  nodes: {}\n  links: []\n"),
    };
    const plan = await inspectLabImport(source);
    expect(plan.format).toBe("containerlab-yaml");
    const roundTripped = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    expect(roundTripped.platform).toBe("containerlab");
    expect((plan as Record<string, unknown>).engine).toBeUndefined();
  });

  it("imports a native SimulatorNet lab with full fidelity", async () => {
    const document: LabDocument = canonicalizeLabDocument({
      schemaVersion: 1,
      id: "lab",
      title: "Native Lab",
      simulation: { seed: 3 },
      topology: { schemaVersion: 1, nodes: [{ id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] }], links: [] },
      configurations: {},
    });
    const source: ImportSource = { filename: "lab.simnet.json", bytes: new TextEncoder().encode(JSON.stringify(document)) };
    const plan = await inspectLabImport(source);
    expect(plan.format).toBe("simulatornet");
    const result = executeLabImport(plan);
    expect(stringifyLabDocument(result.document)).toBe(stringifyLabDocument(document));
  });

  it("rejects Packet Tracer files with an honest diagnostic", async () => {
    const source: ImportSource = { filename: "lab.pkt", bytes: Uint8Array.from([0, 1, 2, 3, 0]) };
    await expect(inspectLabImport(source)).rejects.toThrow(/Packet Tracer/i);
  });

  it("counts every source link the adapter could not map", () => {
    const source = parsed();
    // Two of three cables reached the adapter; the third did not, and the
    // adapter said so rather than quietly shortening its own list.
    source.sourceLinkCount = 3;
    source.links = [{ ...source.links[0]!, mappingKind: "compatibility" }, source.links[1]!];
    const { report } = executeLabImport(planFromParsed(source, "campus.clab.yml"));

    expect(report.sourceLinkCount).toBe(3);
    expect(report.importedLinkCount).toBe(2);
    expect(report.compatibilityMappedLinkCount).toBe(1);
    expect(report.unresolvedLinkCount).toBe(1);
  });

  it("drops one unbuildable device configuration instead of failing the whole import", () => {
    const source = parsed();
    // A Laptop with no radio block: valid as far as this file is concerned, and
    // refused by the canonical schema. Before, it took the entire document with
    // it and the user was told their source file could not be read.
    source.nodes = [
      { id: "lap1", label: "Laptop0", sourceKind: "laptop", interfaces: ["wlan0", "eth0"],
        deviceConfig: { kind: "laptop", hostname: "Laptop0", interfaces: [], dhcpEnabled: true } as never },
      source.nodes[2]!,
    ];
    source.links = [];
    const { document, report } = executeLabImport(planFromParsed(source, "campus.clab.yml"));

    // The device, its interfaces and the rest of the lab all survive; only the
    // settings are gone, replaced by the defaults an unconfigured Laptop has.
    expect(document.topology.nodes.map((node) => node.id).sort()).toEqual(["lap1", "pc1"]);
    expect(document.configurations.lap1).toMatchObject({ kind: "laptop", wireless: expect.any(Object) });
    expect(report.entries.some((entry) =>
      entry.code === "config-invalid" && entry.message.includes("wireless"))).toBe(true);
  });
});
