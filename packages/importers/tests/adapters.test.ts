import { beforeAll, describe, expect, it } from "vitest";
import { buildLabFromDocument, canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import type { ExternalApplianceDeviceConfig, LabDocument, PcDeviceConfig, RouterDeviceConfig } from "@sim/contracts";
import {
  executeLabImport,
  inspectLabImport,
  registerBuiltinImportAdapters,
  type ImportResult,
  type ImportSource,
} from "@sim/importers";
import { buildZip } from "./helpers/zip";
import {
  CML_YAML,
  CONTAINERLAB_YAML,
  EVE_UNL,
  FAKE_QCOW2,
  GNS3_JSON,
  PNETLAB_UNL,
  UNKNOWN_UNL,
  VIRL_XML,
  tinyPng,
} from "./helpers/fixtures";

const encoder = new TextEncoder();

beforeAll(() => registerBuiltinImportAdapters());

async function importText(text: string, filename: string): Promise<ImportResult> {
  const source: ImportSource = { filename, bytes: encoder.encode(text) };
  return executeLabImport(await inspectLabImport(source));
}
async function importBytes(bytes: Uint8Array, filename: string): Promise<ImportResult> {
  return executeLabImport(await inspectLabImport({ filename, bytes }));
}
const kindOf = (document: LabDocument, id: string): string | undefined =>
  document.topology.nodes.find((node) => node.id === id)?.kind;

describe("PNETLab / EVE UNL adapter", () => {
  it("imports routers, switches and PCs with positions, links and config", async () => {
    const { document, report, sourceArtifacts } = await importText(PNETLAB_UNL, "campus.unl");
    expect(document.topology.nodes).toHaveLength(4);
    expect(kindOf(document, "n1")).toBe("router");
    expect(kindOf(document, "n2")).toBe("l2-switch");
    expect(kindOf(document, "n3")).toBe("pc");
    expect(document.topology.links).toHaveLength(3);
    expect(document.topology.nodes.find((node) => node.id === "n1")?.position).toEqual({ x: 100, y: 120 });

    const router = document.configurations.n1 as RouterDeviceConfig;
    expect(router.interfaces.find((iface) => iface.id === "Gi0/0")?.ipv4).toEqual({ address: "10.0.0.1", prefixLength: 24 });
    const pc1 = document.configurations.n3 as PcDeviceConfig;
    expect(pc1.ipv4?.address).toBe("10.0.0.10");
    expect(report.mappedDeviceTypes).toMatchObject({ router: 1, "l2-switch": 1, pc: 2 });

    // Unsupported config is preserved and reported, not applied.
    expect(sourceArtifacts.find((artifact) => artifact.nodeId === "n1")?.text).toContain("router ospf 1");
    expect(report.entries.some((entry) => entry.code === "config-unparsed" && entry.nodeId === "n1")).toBe(true);
    expect(report.entries.some((entry) => entry.code === "config-applied" && entry.nodeId === "n1")).toBe(true);
  });

  it("runs the imported supported data plane", async () => {
    const { document } = await importText(PNETLAB_UNL, "campus.unl");
    const lab = buildLabFromDocument(document);
    lab.getPc("n3")!.ping("10.0.0.11", 1);
    lab.engine.runUntilIdle();
    expect(lab.getPc("n3")!.pingResults.at(-1)).toMatchObject({ success: true });
  });

  it("imports EVE text annotations", async () => {
    const { document } = await importText(EVE_UNL, "annotated.unl");
    const text = document.diagram?.annotations.find((annotation) => annotation.type === "text");
    expect(text && "content" in text ? text.content : "").toBe("Core Link");
  });

  it("ignores vendor images and imports safe diagram images from a ZIP", async () => {
    const zip = buildZip([
      { name: "lab/campus.unl", data: encoder.encode(PNETLAB_UNL) },
      { name: "images/iosv.qcow2", data: FAKE_QCOW2 },
      { name: "diagram/topology.png", data: tinyPng(64, 48) },
    ]);
    const { document, report } = await importBytes(zip, "campus.zip");
    expect(report.ignoredVendorImages).toContain("images/iosv.qcow2");
    expect(document.diagram?.assets?.length).toBe(1);
    expect(document.diagram?.annotations.some((annotation) => annotation.type === "image")).toBe(true);
    expect(document.topology.nodes.length).toBe(4);
  });
});

describe("GNS3 adapter", () => {
  it("imports a .gns3 project without executing any binary", async () => {
    const { document } = await importText(GNS3_JSON, "lab.gns3");
    expect(kindOf(document, "aaaa")).toBe("pc"); // VPCS
    expect(kindOf(document, "bbbb")).toBe("l2-switch"); // Ethernet switch
    expect(kindOf(document, "cccc")).toBe("router"); // qemu iosv
    expect(document.topology.links).toHaveLength(2);
    expect(document.diagram?.annotations.some((annotation) => annotation.type === "text" && annotation.content === "Core")).toBe(true);
  });

  it("imports a .gns3project archive with associated VPCS config", async () => {
    const zip = buildZip([
      { name: "project.gns3", data: encoder.encode(GNS3_JSON) },
      { name: "project-files/vpcs/aaaa/startup.vpc", data: encoder.encode("ip 10.0.0.10/24 10.0.0.1\n") },
      { name: "images/iosv.qcow2", data: FAKE_QCOW2 },
    ]);
    const { document, report } = await importBytes(zip, "lab.gns3project");
    expect((document.configurations.aaaa as PcDeviceConfig).ipv4?.address).toBe("10.0.0.10");
    expect(report.ignoredVendorImages).toContain("images/iosv.qcow2");
  });
});

describe("Containerlab adapter", () => {
  it("maps kinds, derives interfaces from endpoints and applies supported config", async () => {
    const { document, report } = await importText(CONTAINERLAB_YAML, "topo.clab.yml");
    expect(kindOf(document, "r1")).toBe("router");
    expect(kindOf(document, "sw1")).toBe("l2-switch");
    expect(kindOf(document, "srl1")).toBe("external-appliance");
    const router = document.configurations.r1 as RouterDeviceConfig;
    expect(router.interfaces.find((iface) => iface.id === "GigabitEthernet1")?.ipv4?.address).toBe("10.0.0.1");
    expect(document.topology.links).toHaveLength(2);
    expect(report.unsupportedDeviceTypes).toContain("srl");
  });
});

describe("CML and VIRL adapters", () => {
  it("imports a CML YAML lab with mapping, annotations and positions", async () => {
    const { document } = await importText(CML_YAML, "lab.yaml");
    expect(kindOf(document, "n0")).toBe("router");
    expect(kindOf(document, "n1")).toBe("pc");
    expect((document.configurations.n0 as RouterDeviceConfig).interfaces.find((iface) => iface.id === "GigabitEthernet0/0")?.ipv4?.address).toBe("10.0.0.1");
    expect(document.topology.links).toHaveLength(1);
    expect(document.topology.nodes.find((node) => node.id === "n0")?.position).toEqual({ x: 50, y: 60 });
    expect(document.diagram?.annotations.some((annotation) => annotation.type === "text" && annotation.content === "Campus Core")).toBe(true);
  });

  it("imports a VIRL XML lab, resolving XPath connections", async () => {
    const { document } = await importText(VIRL_XML, "lab.virl");
    expect(kindOf(document, "iosv-0")).toBe("router");
    expect(kindOf(document, "iosv-1")).toBe("l2-switch");
    expect(document.topology.links).toHaveLength(1);
  });
});

describe("placeholders, determinism and native round trip", () => {
  it("keeps an unknown node type as an external-appliance placeholder", async () => {
    const { document } = await importText(UNKNOWN_UNL, "mystery.unl");
    expect(kindOf(document, "n1")).toBe("external-appliance");
    expect((document.configurations.n1 as ExternalApplianceDeviceConfig).sourceNodeKind).toBe("acme9000fw");
  });

  it("produces a byte-identical canonical document for the same import", async () => {
    const a = await importText(PNETLAB_UNL, "campus.unl");
    const b = await importText(PNETLAB_UNL, "campus.unl");
    expect(stringifyLabDocument(a.document)).toBe(stringifyLabDocument(b.document));
  });

  it("round-trips a native SimulatorNet document through import/export", async () => {
    const native = canonicalizeLabDocument({
      schemaVersion: 1,
      id: "lab",
      title: "Native",
      simulation: { seed: 5 },
      topology: {
        schemaVersion: 1,
        nodes: [
          { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
          { id: "pc2", kind: "pc", name: "PC2", interfaces: [{ id: "eth0" }] },
        ],
        links: [{ id: "l1", a: { node: "pc1", iface: "eth0" }, b: { node: "pc2", iface: "eth0" } }],
      },
      configurations: {},
    });
    const result = await importBytes(encoder.encode(JSON.stringify(native)), "native.simnet.json");
    expect(stringifyLabDocument(result.document)).toBe(stringifyLabDocument(native));
  });
});
