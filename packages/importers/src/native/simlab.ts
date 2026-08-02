/**
 * The native SimulatorNet lab package (`.simlab`).
 *
 * A `.simlab` is a ZIP container holding the canonical lab document plus
 * human-readable configuration projections:
 *
 * ```text
 * manifest.json
 * lab.json
 * configs/R1-running.cfg
 * configs/R1-startup.cfg
 * import-report.json        (optional)
 * ```
 *
 * `lab.json` is the **only** source of truth. The `.cfg` files are projections
 * for reading and for diffing outside the app; a package that has been edited
 * by hand is reported, never silently applied. Nothing here is a second
 * persistence format: the database and the verifier keep using the canonical
 * structured document exactly as before.
 *
 * It lives beside the foreign-format importers because that is where archive
 * safety lives: reading a `.simlab` goes through the same ZIP guards — path
 * traversal, symlinks, entry counts, expansion ratio, total size and no nested
 * archives — as any untrusted upload.
 */
import type { DeviceConfig, LabDocument } from "@sim/contracts";
import {
  configurationTextDigest,
  renderDeviceConfiguration,
  renderStartupConfiguration,
  supportsDeviceConfigurationText,
} from "@sim/device-config";
import { canonicalizeLabDocument, parseLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { isNestedArchiveEntry, isZipArchive, readZipCentralDirectory, readZipEntryData } from "../archive/zip";
import { writeZipArchive, type ZipFileInput } from "../archive/write";
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from "../config/limits";
import { ImportError, ImportSecurityError } from "../errors/errors";

export const SIMLAB_FORMAT = "simulatornet-lab" as const;
export const SIMLAB_SCHEMA_VERSION = 1 as const;
export const SIMLAB_EXTENSION = ".simlab";
export const SIMLAB_MANIFEST_PATH = "manifest.json";
export const SIMLAB_DOCUMENT_PATH = "lab.json";
export const SIMLAB_CONFIG_DIRECTORY = "configs/";
export const SIMLAB_IMPORT_REPORT_PATH = "import-report.json";

/** Bounds specific to the native container, beside the shared archive limits. */
export const SIMLAB_LIMITS = Object.freeze({
  /** Bytes a `.simlab` may occupy on disk. */
  maximumPackageBytes: 32 * 1024 * 1024,
  /** Configuration projections a package may carry. */
  maximumConfigurationFiles: 512,
  /** Characters of one `.cfg` projection. */
  maximumConfigurationCharacters: 262_144,
  /** Bytes of `lab.json`. */
  maximumDocumentBytes: 16 * 1024 * 1024,
});

/** Validation metadata for one rendered projection inside the package. */
export interface SimlabProjection {
  readonly path: string;
  readonly deviceId: string;
  readonly hostname: string;
  readonly kind: "running" | "startup";
  /** Digest of the rendered text, so hand edits are detectable. */
  readonly digest: string;
}

export interface SimlabManifest {
  readonly format: typeof SIMLAB_FORMAT;
  readonly schemaVersion: typeof SIMLAB_SCHEMA_VERSION;
  readonly title: string;
  readonly labDocumentPath: string;
  readonly configurationDirectory: string;
  readonly configurations: readonly SimlabProjection[];
}

export interface SimlabReadResult {
  readonly document: LabDocument;
  readonly manifest: SimlabManifest;
  /**
   * Honest notes: a projection that no longer matches the canonical document,
   * an unexpected entry, a missing `.cfg`. Never a silent repair.
   */
  readonly warnings: readonly string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** `R1` → `R1`; an untrusted hostname never becomes a path. */
export function packageFileNameFor(hostname: string): string {
  const cleaned = hostname
    .normalize("NFKD")
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.+/gu, ".")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "device";
}

/** Every device that owns a configuration file, in canonical node order. */
function configurableDevices(document: LabDocument): Array<{
  deviceId: string;
  hostname: string;
  running: DeviceConfig;
  startup: DeviceConfig | undefined;
}> {
  const devices: Array<{
    deviceId: string;
    hostname: string;
    running: DeviceConfig;
    startup: DeviceConfig | undefined;
  }> = [];
  for (const node of document.topology.nodes) {
    if (!supportsDeviceConfigurationText(node.kind)) continue;
    const running = document.configurations[node.id];
    if (!running) continue;
    const entry = document.startupConfigurations?.[node.id];
    devices.push({
      deviceId: node.id,
      hostname: running.hostname ?? node.name ?? node.id,
      running,
      // No entry means startup equals running, which is what a reader expects
      // to see in the package too.
      startup: entry === undefined ? running : entry.state === "saved" ? entry.configuration : undefined,
    });
  }
  return devices;
}

/** The projections a document produces, with a stable, collision-free path. */
function projectionsOf(document: LabDocument): Array<SimlabProjection & { text: string }> {
  const used = new Map<string, number>();
  const projections: Array<SimlabProjection & { text: string }> = [];
  for (const device of configurableDevices(document)) {
    const base = packageFileNameFor(device.hostname);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    // Two devices may legitimately share a hostname; the id disambiguates.
    const prefix = seen === 0 ? base : `${base}-${packageFileNameFor(device.deviceId)}`;
    const running = renderDeviceConfiguration(device.running);
    projections.push({
      path: `${SIMLAB_CONFIG_DIRECTORY}${prefix}-running.cfg`,
      deviceId: device.deviceId,
      hostname: device.hostname,
      kind: "running",
      digest: configurationTextDigest(running),
      text: running,
    });
    const startup = renderStartupConfiguration(device.startup);
    projections.push({
      path: `${SIMLAB_CONFIG_DIRECTORY}${prefix}-startup.cfg`,
      deviceId: device.deviceId,
      hostname: device.hostname,
      kind: "startup",
      digest: configurationTextDigest(startup),
      text: startup,
    });
  }
  return projections;
}

export interface WriteSimlabOptions {
  /** Non-canonical provenance, written verbatim; it never affects grading. */
  readonly importReport?: unknown;
}

/**
 * Build a `.simlab` package.
 *
 * The document is canonicalized first, so the package always contains exactly
 * what the simulator would load, and the projections are generated from that
 * same canonical document.
 */
export async function writeSimulatorNetLabPackage(
  document: LabDocument,
  options: WriteSimlabOptions = {},
): Promise<Uint8Array> {
  const canonical = canonicalizeLabDocument(document);
  const projections = projectionsOf(canonical);
  if (projections.length > SIMLAB_LIMITS.maximumConfigurationFiles) {
    throw new ImportError("package-too-large", `A lab package may hold at most ${SIMLAB_LIMITS.maximumConfigurationFiles} configuration files`);
  }
  const manifest: SimlabManifest = {
    format: SIMLAB_FORMAT,
    schemaVersion: SIMLAB_SCHEMA_VERSION,
    title: canonical.title,
    labDocumentPath: SIMLAB_DOCUMENT_PATH,
    configurationDirectory: SIMLAB_CONFIG_DIRECTORY,
    configurations: projections.map(({ path, deviceId, hostname, kind, digest }) => ({
      path, deviceId, hostname, kind, digest,
    })),
  };
  const files: ZipFileInput[] = [
    { name: SIMLAB_MANIFEST_PATH, data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: SIMLAB_DOCUMENT_PATH, data: encoder.encode(stringifyLabDocument(canonical)) },
    ...projections.map((projection) => ({ name: projection.path, data: encoder.encode(projection.text) })),
  ];
  if (options.importReport !== undefined) {
    files.push({
      name: SIMLAB_IMPORT_REPORT_PATH,
      data: encoder.encode(`${JSON.stringify(options.importReport, null, 2)}\n`),
    });
  }
  return writeZipArchive(files);
}

/** True when these bytes / this filename look like a native lab package. */
export function isSimulatorNetLabPackage(input: { filename?: string; bytes: Uint8Array }): boolean {
  if (!isZipArchive(input.bytes)) return false;
  if (input.filename?.toLowerCase().endsWith(SIMLAB_EXTENSION)) return true;
  try {
    return readZipCentralDirectory(input.bytes).some((entry) => entry.name === SIMLAB_MANIFEST_PATH);
  } catch {
    return false;
  }
}

function parseManifest(text: string): SimlabManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError("package-invalid", "manifest.json is not valid JSON");
  }
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  if (record.format !== SIMLAB_FORMAT) {
    throw new ImportError("package-invalid", "manifest.json is not a SimulatorNet lab package manifest");
  }
  if (record.schemaVersion !== SIMLAB_SCHEMA_VERSION) {
    throw new ImportError("package-unsupported-version", `Unsupported lab package schema version: ${String(record.schemaVersion)}`);
  }
  const documentPath = typeof record.labDocumentPath === "string" ? record.labDocumentPath : SIMLAB_DOCUMENT_PATH;
  if (documentPath !== SIMLAB_DOCUMENT_PATH) {
    throw new ImportError("package-invalid", "A lab package must store its document as lab.json");
  }
  const configurations = Array.isArray(record.configurations)
    ? record.configurations.flatMap((entry): SimlabProjection[] => {
      const candidate = typeof entry === "object" && entry !== null ? entry as Record<string, unknown> : {};
      const path = candidate.path;
      const deviceId = candidate.deviceId;
      const digest = candidate.digest;
      const kind = candidate.kind;
      if (typeof path !== "string" || typeof deviceId !== "string" || typeof digest !== "string") return [];
      if (kind !== "running" && kind !== "startup") return [];
      return [{
        path,
        deviceId,
        hostname: typeof candidate.hostname === "string" ? candidate.hostname : deviceId,
        kind,
        digest,
      }];
    })
    : [];
  return {
    format: SIMLAB_FORMAT,
    schemaVersion: SIMLAB_SCHEMA_VERSION,
    title: typeof record.title === "string" ? record.title : "Lab",
    labDocumentPath: documentPath,
    configurationDirectory: typeof record.configurationDirectory === "string"
      ? record.configurationDirectory
      : SIMLAB_CONFIG_DIRECTORY,
    configurations,
  };
}

/**
 * Read a `.simlab` package.
 *
 * Order matters: archive security first, then the manifest, then `lab.json`,
 * then validation of the projections. The canonical document always wins — a
 * `.cfg` edited by hand produces a warning and an explicit follow-up, never a
 * silent configuration change.
 */
export async function readSimulatorNetLabPackage(
  bytes: Uint8Array,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): Promise<SimlabReadResult> {
  if (bytes.length > SIMLAB_LIMITS.maximumPackageBytes) {
    throw new ImportSecurityError("package-too-large", `A lab package may not exceed ${SIMLAB_LIMITS.maximumPackageBytes} bytes`);
  }
  const entries = readZipCentralDirectory(bytes, limits);
  const warnings: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (isNestedArchiveEntry(entry)) {
      throw new ImportSecurityError("archive-nested", `A lab package may not contain another archive: ${entry.name}`);
    }
    const isKnown = entry.name === SIMLAB_MANIFEST_PATH
      || entry.name === SIMLAB_DOCUMENT_PATH
      || entry.name === SIMLAB_IMPORT_REPORT_PATH
      || (entry.name.startsWith(SIMLAB_CONFIG_DIRECTORY) && entry.name.endsWith(".cfg"));
    if (!isKnown) warnings.push(`Ignored unexpected package entry: ${entry.name}`);
  }
  const configurationEntries = entries.filter((entry) =>
    !entry.isDirectory && entry.name.startsWith(SIMLAB_CONFIG_DIRECTORY) && entry.name.endsWith(".cfg"));
  if (configurationEntries.length > SIMLAB_LIMITS.maximumConfigurationFiles) {
    throw new ImportSecurityError("package-too-large", "The lab package holds too many configuration files");
  }

  const manifestEntry = entries.find((entry) => entry.name === SIMLAB_MANIFEST_PATH);
  if (!manifestEntry) throw new ImportError("package-invalid", "The lab package has no manifest.json");
  const manifest = parseManifest(decoder.decode(await readZipEntryData(bytes, manifestEntry, limits)));

  const documentEntry = entries.find((entry) => entry.name === SIMLAB_DOCUMENT_PATH);
  if (!documentEntry) throw new ImportError("package-invalid", "The lab package has no lab.json");
  if (documentEntry.uncompressedSize > SIMLAB_LIMITS.maximumDocumentBytes) {
    throw new ImportSecurityError("package-too-large", "lab.json in the package is too large");
  }
  const documentText = decoder.decode(
    await readZipEntryData(bytes, documentEntry, limits, SIMLAB_LIMITS.maximumDocumentBytes),
  );
  const document = canonicalizeLabDocument(parseLabDocument(documentText));

  // Compare each stored projection with the one the canonical document produces
  // right now. A difference is reported; the document is never overwritten.
  const expected = new Map(projectionsOf(document).map((projection) => [projection.path, projection]));
  for (const entry of configurationEntries) {
    const projection = expected.get(entry.name);
    if (!projection) {
      warnings.push(`Configuration projection ${entry.name} does not belong to this lab document.`);
      continue;
    }
    if (entry.uncompressedSize > SIMLAB_LIMITS.maximumConfigurationCharacters) {
      warnings.push(`Configuration projection ${entry.name} is too large to validate.`);
      continue;
    }
    const stored = decoder.decode(
      await readZipEntryData(bytes, entry, limits, SIMLAB_LIMITS.maximumConfigurationCharacters),
    );
    if (configurationTextDigest(stored) === projection.digest) continue;
    warnings.push(
      `Configuration projection ${entry.name} differs from the canonical lab document. `
      + "The lab document was used; apply the file explicitly from the device Configuration tab if you meant to change it.",
    );
  }
  for (const projection of expected.values()) {
    if (!configurationEntries.some((entry) => entry.name === projection.path)) {
      warnings.push(`The package is missing the configuration projection ${projection.path}.`);
    }
  }
  const declared = new Set(manifest.configurations.map((entry) => entry.path));
  for (const entry of configurationEntries) {
    if (!declared.has(entry.name)) warnings.push(`Configuration projection ${entry.name} is not declared in manifest.json.`);
  }

  return { document, manifest, warnings };
}

/**
 * A plain ZIP of every device's `.cfg`, for reading or version control outside
 * the app. It carries no manifest and no lab document: it is a bundle of
 * projections, never a lab.
 */
export async function writeDeviceConfigurationArchive(document: LabDocument): Promise<Uint8Array> {
  const canonical = canonicalizeLabDocument(document);
  const projections = projectionsOf(canonical);
  return writeZipArchive(projections.map((projection) => ({
    // Flat inside a configuration bundle: there is no package structure here.
    name: projection.path.slice(SIMLAB_CONFIG_DIRECTORY.length),
    data: encoder.encode(projection.text),
  })));
}

/** The `.cfg` files a document produces, for a UI list or a single download. */
export function deviceConfigurationProjections(document: LabDocument): Array<SimlabProjection & { text: string }> {
  return projectionsOf(canonicalizeLabDocument(document));
}
