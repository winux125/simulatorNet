/**
 * Containerlab (.clab.yml) adapter. Interfaces are derived from link endpoints
 * ("node:iface"); node kinds are mapped declaratively and inline startup-config
 * is preserved. Image references, bind mounts, host paths, env, commands and
 * entrypoints are treated purely as ignored source metadata — never fetched,
 * mounted or executed.
 */
import { parseYaml } from "../yaml/yaml";
import { asArray, asRecord, asString, classifyVendorImage } from "./shared";
import type { ImportLimits } from "../config/limits";
import { ImportError } from "../errors/errors";
import type { LabImportAdapter } from "./adapter";
import type {
  ConfigFamily,
  ImportReportEntry,
  ImportSource,
  ImportSourceLink,
  ImportSourceNode,
  ParsedSourceTopology,
} from "../types";

function classifyClab(kind: string, image: string): { sourceKind: string; configFamily: ConfigFamily } {
  const value = kind.toLowerCase();
  if (value === "bridge" || value === "ovs-bridge") return { sourceKind: "ethernet-switch", configFamily: "unknown" };
  if (value === "linux" || value === "host") return { sourceKind: "linux", configFamily: "unknown" };
  if (value.includes("ceos") || value.includes("arista")) return { sourceKind: "l3-switch", configFamily: "eos" };
  if (value.includes("vr-csr") || value.includes("csr")) return { sourceKind: "csr1000v", configFamily: "ios-like" };
  if (value.includes("vr-xrv") || value.includes("xrd")) return { sourceKind: "iosxr", configFamily: "unknown" };
  if (value.includes("vr-n9kv") || value.includes("nxos")) return { sourceKind: "nxos", configFamily: "unknown" };
  const classified = classifyVendorImage(`${kind} ${image}`);
  if (classified) return classified;
  return { sourceKind: kind || "unknown-appliance", configFamily: "unknown" };
}

export const containerlabAdapter: LabImportAdapter = {
  format: "containerlab-yaml",
  platform: "containerlab",
  async parse(source: ImportSource, limits: ImportLimits): Promise<ParsedSourceTopology> {
    const doc = asRecord(parseYaml(new TextDecoder("utf-8", { fatal: false }).decode(source.bytes), limits));
    const topology = asRecord(doc?.topology);
    if (!topology) throw new ImportError("adapter-error", "Containerlab file has no topology");
    const notes: ImportReportEntry[] = [];
    const nodeDefs = asRecord(topology.nodes) ?? {};
    const linkDefs = asArray(topology.links);

    // Interfaces come from link endpoints; collect them per node first.
    const nodeInterfaces = new Map<string, Set<string>>();
    const links: ImportSourceLink[] = [];
    linkDefs.forEach((raw, index) => {
      const endpoints = asArray(asRecord(raw)?.endpoints).map(asString).filter((value): value is string => value !== undefined);
      if (endpoints.length !== 2) { notes.push({ level: "info", code: "link-skipped", message: `A Containerlab link without exactly two endpoints was skipped` }); return; }
      const parse = (endpoint: string) => {
        const colon = endpoint.indexOf(":");
        return colon > 0 ? { node: endpoint.slice(0, colon), iface: endpoint.slice(colon + 1) } : undefined;
      };
      const a = parse(endpoints[0]!);
      const b = parse(endpoints[1]!);
      if (!a || !b) return;
      for (const endpoint of [a, b]) {
        const set = nodeInterfaces.get(endpoint.node) ?? new Set<string>();
        set.add(endpoint.iface);
        nodeInterfaces.set(endpoint.node, set);
      }
      links.push({ id: `link-${index}`, a, b });
    });

    const nodes: ImportSourceNode[] = Object.entries(nodeDefs).map(([name, rawNode]) => {
      const node = asRecord(rawNode) ?? {};
      const kind = asString(node.kind) ?? "linux";
      const image = asString(node.image) ?? "";
      const { sourceKind, configFamily } = classifyClab(kind, image);
      const startupRaw = node["startup-config"];
      const startupConfig = typeof startupRaw === "string" && startupRaw.includes("\n") ? startupRaw : undefined;
      if (typeof startupRaw === "string" && !startupConfig) {
        notes.push({ level: "info", code: "config-external", message: `startup-config for ${name} references an external path and was not inlined` });
      }
      return {
        id: name,
        label: name,
        sourceKind,
        sourceTemplate: kind,
        interfaces: [...(nodeInterfaces.get(name) ?? [])].sort(),
        startupConfig,
        configFamily,
        authLikelyRequired: sourceKind !== "ethernet-switch",
      };
    });

    return {
      platform: "containerlab",
      format: "containerlab-yaml",
      labTitle: asString(doc?.name),
      nodes,
      links,
      annotations: [],
      assets: [],
      ignoredFiles: [],
      ignoredVendorImages: [],
      notes,
    };
  },
};
