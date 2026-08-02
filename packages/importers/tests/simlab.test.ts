import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import {
  executeLabImport,
  inspectLabImport,
  deviceConfigurationProjections,
  detectLabImportFormat,
  isSimulatorNetLabPackage,
  readSimulatorNetLabPackage,
  SIMLAB_LIMITS,
  writeDeviceConfigurationArchive,
  writeSimulatorNetLabPackage,
  readZipCentralDirectory,
  readZipEntryData,
} from "@sim/importers";
import { writeZipArchive } from "../src/archive/write";
import { describe, expect, it } from "vitest";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function labDocument(): LabDocument {
  return canonicalizeLabDocument({
    schemaVersion: 1,
    id: "branch-network",
    title: "Branch Network",
    simulation: { seed: 5 },
    topology: {
      schemaVersion: 1,
      nodes: [
        { id: "r1", kind: "router", name: "R1", interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
        { id: "sw1", kind: "l2-switch", name: "SW1", interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
        { id: "pc1", kind: "pc", name: "PC1", interfaces: [{ id: "eth0" }] },
      ],
      links: [
        { id: "link-1", a: { node: "r1", iface: "Gi0/0" }, b: { node: "sw1", iface: "Gi0/1" } },
        { id: "link-2", a: { node: "sw1", iface: "Gi0/2" }, b: { node: "pc1", iface: "eth0" } },
      ],
    },
    configurations: {
      r1: {
        kind: "router",
        hostname: "R1",
        interfaces: [{ id: "Gi0/0", routed: true, ipv4: { address: "192.168.1.1", prefixLength: 24 } }],
      },
      sw1: { kind: "l2-switch", hostname: "SW1", vlans: [{ id: 10, name: "USERS" }] },
      pc1: {
        kind: "pc",
        hostname: "PC1",
        ipv4: { address: "192.168.1.10", prefixLength: 24, defaultGateway: "192.168.1.1" },
      },
    },
  });
}

async function entryText(bytes: Uint8Array, name: string): Promise<string> {
  const entries = readZipCentralDirectory(bytes);
  const entry = entries.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Missing package entry ${name}`);
  return decoder.decode(await readZipEntryData(bytes, entry));
}

describe("simlab package", () => {
  it("writes the documented package structure", async () => {
    const bytes = await writeSimulatorNetLabPackage(labDocument());
    const names = readZipCentralDirectory(bytes).map((entry) => entry.name).sort();
    expect(names).toEqual([
      "configs/R1-running.cfg",
      "configs/R1-startup.cfg",
      "configs/SW1-running.cfg",
      "configs/SW1-startup.cfg",
      "lab.json",
      "manifest.json",
    ]);
    const manifest = JSON.parse(await entryText(bytes, "manifest.json")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      format: "simulatornet-lab",
      schemaVersion: 1,
      title: "Branch Network",
      labDocumentPath: "lab.json",
      configurationDirectory: "configs/",
    });
    // Canonical content carries no timestamp.
    expect(JSON.stringify(manifest)).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
    // A PC has no configuration file, so it contributes no projection.
    expect(names.some((name) => name.includes("PC1"))).toBe(false);
  });

  it("round-trips a lab byte-identically", async () => {
    const document = labDocument();
    const bytes = await writeSimulatorNetLabPackage(document);
    const read = await readSimulatorNetLabPackage(bytes);
    expect(read.warnings).toEqual([]);
    expect(stringifyLabDocument(read.document)).toBe(stringifyLabDocument(document));
    // Deterministic output: the same lab always produces the same package.
    expect(Array.from(await writeSimulatorNetLabPackage(document))).toEqual(Array.from(bytes));
  });

  it("carries startup snapshots through the package", async () => {
    const document = labDocument();
    document.startupConfigurations = {
      r1: { state: "saved", configuration: { ...document.configurations.r1!, hostname: "R1-SAVED" } },
      sw1: { state: "absent" },
    };
    const read = await readSimulatorNetLabPackage(await writeSimulatorNetLabPackage(document));
    expect(read.document.startupConfigurations?.r1).toMatchObject({ state: "saved" });
    expect(read.document.startupConfigurations?.sw1).toEqual({ state: "absent" });
  });

  it("writes cfg projections that match the canonical document", async () => {
    const document = labDocument();
    const bytes = await writeSimulatorNetLabPackage(document);
    const running = await entryText(bytes, "configs/R1-running.cfg");
    const projection = deviceConfigurationProjections(document)
      .find((entry) => entry.deviceId === "r1" && entry.kind === "running");
    expect(running).toBe(projection?.text);
    expect(running).toContain("hostname R1");
    expect(running).toContain("ip address 192.168.1.1 255.255.255.0");
  });

  it("warns when a cfg projection was edited by hand and keeps lab.json authoritative", async () => {
    const document = labDocument();
    const bytes = await writeSimulatorNetLabPackage(document);
    const entries = readZipCentralDirectory(bytes);
    const files = await Promise.all(entries.map(async (entry) => ({
      name: entry.name,
      data: entry.name === "configs/R1-running.cfg"
        ? encoder.encode("!\nhostname HAND-EDITED\n!\nend\n")
        : await readZipEntryData(bytes, entry),
    })));
    const tampered = await writeZipArchive(files);

    const read = await readSimulatorNetLabPackage(tampered);
    expect(read.warnings.some((warning) => warning.includes("differs from the canonical lab document"))).toBe(true);
    // The document wins: the hand edit is reported, never applied.
    expect(read.document.configurations.r1?.hostname).toBe("R1");
  });

  it("reports an unexpected entry rather than reading it", async () => {
    const document = labDocument();
    const bytes = await writeSimulatorNetLabPackage(document);
    const entries = readZipCentralDirectory(bytes);
    const files = await Promise.all(entries.map(async (entry) => ({
      name: entry.name,
      data: await readZipEntryData(bytes, entry),
    })));
    files.push({ name: "notes.txt", data: encoder.encode("hello") });
    const read = await readSimulatorNetLabPackage(await writeZipArchive(files));
    expect(read.warnings).toContain("Ignored unexpected package entry: notes.txt");
  });

  it("refuses a package with no manifest or no document", async () => {
    const onlyDocument = await writeZipArchive([
      { name: "lab.json", data: encoder.encode(stringifyLabDocument(labDocument())) },
    ]);
    await expect(readSimulatorNetLabPackage(onlyDocument)).rejects.toThrow(/no manifest.json/u);

    const onlyManifest = await writeZipArchive([
      { name: "manifest.json", data: encoder.encode(JSON.stringify({ format: "simulatornet-lab", schemaVersion: 1 })) },
    ]);
    await expect(readSimulatorNetLabPackage(onlyManifest)).rejects.toThrow(/no lab.json/u);
  });

  it("refuses a foreign manifest and an unsupported schema version", async () => {
    const foreign = await writeZipArchive([
      { name: "manifest.json", data: encoder.encode(JSON.stringify({ format: "something-else" })) },
      { name: "lab.json", data: encoder.encode(stringifyLabDocument(labDocument())) },
    ]);
    await expect(readSimulatorNetLabPackage(foreign)).rejects.toThrow(/not a SimulatorNet lab package/u);

    const future = await writeZipArchive([
      { name: "manifest.json", data: encoder.encode(JSON.stringify({ format: "simulatornet-lab", schemaVersion: 99 })) },
      { name: "lab.json", data: encoder.encode(stringifyLabDocument(labDocument())) },
    ]);
    await expect(readSimulatorNetLabPackage(future)).rejects.toThrow(/Unsupported lab package schema version/u);
  });

  it("refuses a nested archive and an oversized package", async () => {
    const nested = await writeZipArchive([
      { name: "manifest.json", data: encoder.encode(JSON.stringify({ format: "simulatornet-lab", schemaVersion: 1 })) },
      { name: "lab.json", data: encoder.encode(stringifyLabDocument(labDocument())) },
      { name: "payload.zip", data: encoder.encode("PK not really") },
    ]);
    await expect(readSimulatorNetLabPackage(nested)).rejects.toThrow(/may not contain another archive/u);

    const oversized = new Uint8Array(SIMLAB_LIMITS.maximumPackageBytes + 1);
    await expect(readSimulatorNetLabPackage(oversized)).rejects.toThrow(/may not exceed/u);
  });

  it("never writes a traversal or absolute path", async () => {
    await expect(writeZipArchive([{ name: "../escape.cfg", data: encoder.encode("x") }]))
      .rejects.toThrow(/unsafe archive entry name/u);
    await expect(writeZipArchive([{ name: "/etc/passwd", data: encoder.encode("x") }]))
      .rejects.toThrow(/unsafe archive entry name/u);
  });

  it("is detected as the native package and opened through the import plan", async () => {
    const bytes = await writeSimulatorNetLabPackage(labDocument());
    expect(isSimulatorNetLabPackage({ bytes, filename: "branch.simlab" })).toBe(true);
    const detection = detectLabImportFormat({ filename: "branch.simlab", bytes });
    expect(detection).toMatchObject({ format: "simulatornet-package", supported: true, isArchive: true });

    const plan = await inspectLabImport({ filename: "branch.simlab", bytes });
    expect(plan.importable).toBe(true);
    expect(plan.nativeDocument?.title).toBe("Branch Network");
    expect(executeLabImport(plan).document.topology.nodes).toHaveLength(3);
  });

  it("exports a flat configuration bundle with no lab document", async () => {
    const bytes = await writeDeviceConfigurationArchive(labDocument());
    const names = readZipCentralDirectory(bytes).map((entry) => entry.name).sort();
    expect(names).toEqual([
      "R1-running.cfg",
      "R1-startup.cfg",
      "SW1-running.cfg",
      "SW1-startup.cfg",
    ]);
  });

  it("never writes a credential into a projection", async () => {
    const document = labDocument();
    document.configurations.r1 = {
      ...document.configurations.r1!,
      consoleAccess: {
        mode: "local-user",
        users: [{
          id: "u1",
          username: "admin",
          passwordVerifier: {
            algorithm: "pbkdf2-sha256",
            iterations: 1_000,
            saltBase64: "c2FsdHNhbHQ=",
            hashBase64: "aGFzaGhhc2g=",
          },
          privilegeLevel: 15,
          enabled: true,
        }],
        maximumAttempts: 3,
        credentialResetRequired: false,
      },
    };
    const bytes = await writeSimulatorNetLabPackage(canonicalizeLabDocument(document));
    const running = await entryText(bytes, "configs/R1-running.cfg");
    expect(running).toContain("username admin privilege 15 secret <configured>");
    expect(running).not.toContain("aGFzaGhhc2g=");
    expect(running).not.toContain("c2FsdHNhbHQ=");
    expect(running).not.toContain("pbkdf2");
  });

  it("keeps two devices with the same hostname in separate files", async () => {
    const document = labDocument();
    document.configurations.sw1 = { ...document.configurations.sw1!, hostname: "R1" };
    const bytes = await writeSimulatorNetLabPackage(canonicalizeLabDocument(document));
    const names = readZipCentralDirectory(bytes).map((entry) => entry.name).sort();
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("configs/R1-sw1-running.cfg");
  });
});
