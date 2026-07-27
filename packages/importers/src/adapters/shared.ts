/**
 * Helpers shared by the format adapters: importing safe raster diagram images
 * (bounded to the contracts' own asset limits so a converted document always
 * passes diagram validation) and small source-kind heuristics.
 */
import {
  MAX_DIAGRAM_ASSET_BYTES,
  MAX_DIAGRAM_ASSET_TOTAL_BYTES,
  MAX_DIAGRAM_ASSETS,
  type DiagramAnnotation,
} from "@sim/contracts";
import { rasterAsset } from "../security/image";
import type { ConfigFamily, ImportReportEntry, ImportSourceAsset } from "../types";

/**
 * Classify a vendor image / node-definition string into a source-kind token and
 * config dialect, or undefined when nothing recognisable matches (the caller
 * then supplies its own fallback, typically an external-appliance placeholder).
 */
export function classifyVendorImage(text: string): { sourceKind: string; configFamily: ConfigFamily } | undefined {
  const hay = text.toLowerCase();
  const has = (...tokens: string[]): boolean => tokens.some((token) => hay.includes(token));
  if (has("wireless-router", "wifi-router", "home-router")) return { sourceKind: "wireless-router", configFamily: "unknown" };
  if (has("wireless-access-point", "access-point", "wifi-ap")) return { sourceKind: "access-point", configFamily: "unknown" };
  if (has("laptop", "notebook")) return { sourceKind: "laptop", configFamily: "unknown" };
  if (has("smartphone", "mobile-phone", "mobile-device", "tablet")) return { sourceKind: "smartphone", configFamily: "unknown" };
  if (has("iol", "iou")) return { sourceKind: has("l2", "switch") ? "iol-l2" : "iol-l3", configFamily: "ios-like" };
  if (has("iosv", "vios")) return { sourceKind: has("l2") ? "iol-l2" : "iosv", configFamily: "ios-like" };
  if (has("csr", "c8000v")) return { sourceKind: "csr1000v", configFamily: "ios-like" };
  if (has("c3745", "c7200", "c2691", "c3660", "dynamips")) return { sourceKind: "dynamips", configFamily: "ios-like" };
  if (has("xrv", "iosxr")) return { sourceKind: "iosxr", configFamily: "unknown" };
  if (has("nxos", "nexus", "n9k")) return { sourceKind: "nxos", configFamily: "unknown" };
  if (has("asav", "asa", "ftd", "firepower")) return { sourceKind: "asa", configFamily: "unknown" };
  if (has("forti")) return { sourceKind: "fortigate", configFamily: "fortios" };
  if (has("palo", "pan-os", "panos")) return { sourceKind: "paloalto", configFamily: "panos" };
  if (has("vsrx", "srx", "vmx", "juniper")) return { sourceKind: "vsrx", configFamily: "junos" };
  if (has("veos", "arista", "ceos")) return { sourceKind: "l3-switch", configFamily: "eos" };
  if (has("vpcs")) return { sourceKind: "vpcs", configFamily: "vpcs" };
  return undefined;
}

/** Basename with control characters removed, satisfying the asset-name schema. */
function safeAssetName(name: string): string {
  const base = name.split(/[\\/]/u).pop() ?? "image";
  let out = "";
  for (const ch of base) if (ch.charCodeAt(0) > 0x1f) out += ch;
  return (out || "image").slice(0, 255);
}

/**
 * Convert candidate raster bytes into diagram assets plus positioned image
 * annotations, bounding count and byte totals to the contracts' asset limits so
 * the result never trips diagram validation. Rejected images become notes.
 */
export function buildDiagramImages(
  rasters: ReadonlyArray<{ name: string; bytes: Uint8Array }>,
  notes: ImportReportEntry[],
): { assets: ImportSourceAsset[]; annotations: DiagramAnnotation[] } {
  const assets: ImportSourceAsset[] = [];
  const annotations: DiagramAnnotation[] = [];
  let totalBytes = 0;
  let offset = 40;
  for (const raster of rasters) {
    if (assets.length >= MAX_DIAGRAM_ASSETS) {
      notes.push({ level: "warning", code: "diagram-asset-limit", message: `Diagram image ${raster.name} skipped: asset count limit reached` });
      continue;
    }
    if (raster.bytes.length > MAX_DIAGRAM_ASSET_BYTES || totalBytes + raster.bytes.length > MAX_DIAGRAM_ASSET_TOTAL_BYTES) {
      notes.push({ level: "warning", code: "diagram-asset-size", message: `Diagram image ${raster.name} skipped: exceeds the diagram image size limit` });
      continue;
    }
    const asset = rasterAsset(`asset-${assets.length}`, safeAssetName(raster.name), raster.bytes);
    if (!asset) {
      notes.push({ level: "warning", code: "diagram-asset-invalid", message: `Diagram image ${raster.name} skipped: not a readable PNG/JPEG/WebP` });
      continue;
    }
    totalBytes += raster.bytes.length;
    assets.push(asset);
    annotations.push({
      type: "image",
      id: `image-${annotations.length}`,
      assetId: asset.id,
      position: { x: offset, y: offset },
      width: Math.min(Math.max(asset.width, 8), 4_096),
      height: Math.min(Math.max(asset.height, 8), 4_096),
      opacity: 1,
      preserveAspectRatio: true,
      zIndex: 0,
      rotation: 0,
    });
    offset += 40;
  }
  return { assets, annotations };
}

export const parseCoordinate = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Safe navigation for the plain data returned by the YAML/JSON parsers. */
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
