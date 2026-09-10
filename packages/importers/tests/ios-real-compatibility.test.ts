import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPacketTracerDocument, decodePacketTracer, DEFAULT_PACKET_TRACER_LIMITS } from "@sim/packet-tracer-format";
import { parseIosConfig, redactConfigurationLine } from "@sim/device-config";
import { parseXml } from "../src/xml/xml";
import { DEFAULT_IMPORT_LIMITS } from "../src/config/limits";
import { mapNetworkToTopology } from "../src/packet-tracer/native";

const directory = resolve(".local-fixtures/packet-tracer");
function fixtures(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? fixtures(join(path, entry.name)) : /\.(pkt|pka)$/i.test(entry.name) ? [join(path, entry.name)] : []);
}
const files = fixtures(directory).sort();

describe("real IOS RUNNING_CONFIG compatibility audit", () => {
  it.skipIf(!files.length && process.env.PACKET_TRACER_REQUIRE_REAL !== "1")("audits every Router/Switch in every real PKT/PKA network", async () => {
    expect(files.length).toBeGreaterThan(0);
    const devices: Array<{ file: string; network: string; device: string; total: number;
      applied: number; unsupported: number; ignored: number; failed: number; unsupportedCommands: string[] }> = [];
    for (const file of files) {
      const decoded = await decodePacketTracer(readFileSync(file), { filename: file });
      const document = buildPacketTracerDocument(parseXml(decoded.xml, {
        ...DEFAULT_IMPORT_LIMITS, maxXmlNodes: DEFAULT_PACKET_TRACER_LIMITS.maxXmlNodes,
        maxXmlDepth: DEFAULT_PACKET_TRACER_LIMITS.maxXmlDepth,
      }, { preserveTextWhitespace: true }), { format: decoded.format });
      for (const network of document.networks) {
        const mapped = mapNetworkToTopology(network, document, "CLI compatibility audit");
        for (const node of mapped.nodes.filter((node) => node.configFamily === "ios-like" && node.startupConfig !== undefined)) {
          const text = node.startupConfig!;
          const parsed = parseIosConfig(text, node.interfaces);
          const total = text.split(/\r\n|\r|\n/).length;
          const row = { file: relative(directory, file), network: network.id, device: node.label, total,
            applied: parsed.appliedLines.length, unsupported: parsed.unparsedLines.length,
            ignored: total - parsed.appliedLines.length - parsed.unparsedLines.length, failed: 0,
            unsupportedCommands: parsed.unparsedLines.map(redactConfigurationLine) };
          expect(row.ignored).toBeGreaterThanOrEqual(0);
          devices.push(row);
        }
      }
    }
    expect(devices.length).toBeGreaterThan(0);
    const totals = devices.reduce((sum, row) => ({
      total: sum.total + row.total, applied: sum.applied + row.applied,
      unsupported: sum.unsupported + row.unsupported, ignored: sum.ignored + row.ignored, failed: sum.failed + row.failed,
    }), { total: 0, applied: 0, unsupported: 0, ignored: 0, failed: 0 });
    const counts = new Map<string, number>();
    for (const row of devices) for (const line of row.unsupportedCommands) {
      const command = line.split(/\s+/).slice(0, /^(?:no |ip |switchport |spanning-tree )/.test(line) ? 3 : 2).join(" ");
      counts.set(command, (counts.get(command) ?? 0) + 1);
    }
    const report = { files: files.length, devices: devices.length, totals,
      topUnsupported: [...counts].sort((a, b) => b[1] - a[1]), details: devices };
    if (process.env.IOS_COMPAT_REPORT) writeFileSync(process.env.IOS_COMPAT_REPORT, JSON.stringify(report, null, 2) + "\n");
  }, 120_000);
});
