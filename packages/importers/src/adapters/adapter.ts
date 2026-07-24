/**
 * Adapter contract + local-only registry. Each source format registers one
 * adapter that turns raw bytes into a platform-neutral ParsedSourceTopology.
 * Plugins may be registered in-process, but no remote plugin is ever fetched or
 * executed — third-party code must be imported explicitly by the host build.
 */
import type { ImportLimits } from "../config/limits";
import { ImportError } from "../errors/errors";
import type { ImportSource, LabImportFormat, ParsedSourceTopology } from "../types";

export interface LabImportAdapter {
  readonly format: LabImportFormat;
  readonly platform: string;
  parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology>;
}

export interface ExternalLabImporterPlugin {
  readonly id: string;
  readonly adapter: LabImportAdapter;
}

const adapters = new Map<LabImportFormat, LabImportAdapter>();

export function registerImportAdapter(adapter: LabImportAdapter): void {
  adapters.set(adapter.format, adapter);
}

export function getImportAdapter(format: LabImportFormat): LabImportAdapter | undefined {
  return adapters.get(format);
}

export function registeredImportFormats(): LabImportFormat[] {
  return [...adapters.keys()].sort();
}

/**
 * Register a plugin the host build already holds a reference to. This never
 * loads code from a URL, disk path or archive; it only wires an in-memory
 * adapter into the registry.
 */
export function registerExternalLabImporterPlugin(plugin: ExternalLabImporterPlugin): void {
  if (!plugin.id || typeof plugin.adapter?.parse !== "function") {
    throw new ImportError("plan-invalid", "Invalid external importer plugin");
  }
  registerImportAdapter(plugin.adapter);
}
