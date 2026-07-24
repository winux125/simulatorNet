/**
 * Turn a validated ZIP into safe, in-memory contents: decoded text files and
 * candidate raster images. Vendor appliance images/binaries are recorded as
 * ignored (never decoded further or kept), nested archives are refused, and
 * unreadable entries are skipped. Nothing is written to a filesystem.
 */
import { classifyBinary } from "../security/binary";
import { looksBinary, decodeSafeText } from "../security/text";
import { inspectRaster } from "../security/image";
import { isNestedArchiveEntry, readZipCentralDirectory, readZipEntryData } from "./zip";
import type { ImportLimits } from "../config/limits";

export interface ArchiveContents {
  readonly textFiles: Map<string, string>;
  readonly rasters: Array<{ name: string; bytes: Uint8Array }>;
  readonly ignoredVendorImages: string[];
  readonly ignoredFiles: string[];
}

export async function readArchive(bytes: Uint8Array, limits: ImportLimits): Promise<ArchiveContents> {
  const entries = readZipCentralDirectory(bytes, limits);
  const contents: ArchiveContents = { textFiles: new Map(), rasters: [], ignoredVendorImages: [], ignoredFiles: [] };
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (isNestedArchiveEntry(entry)) { contents.ignoredFiles.push(entry.name); continue; }
    let data: Uint8Array;
    try {
      data = await readZipEntryData(bytes, entry, limits, limits.maxTopologyFileBytes);
    } catch {
      contents.ignoredFiles.push(entry.name);
      continue;
    }
    if (classifyBinary(data, entry.name).isVendorArtifact) { contents.ignoredVendorImages.push(entry.name); continue; }
    if (inspectRaster(data)) { contents.rasters.push({ name: entry.name, bytes: data }); continue; }
    if (looksBinary(data)) { contents.ignoredFiles.push(entry.name); continue; }
    contents.textFiles.set(entry.name, decodeSafeText(data));
  }
  return contents;
}
