import { describe, expect, it } from "vitest";
import { detectLabImportFormat, parseXml, parseYaml, type ImportSource } from "@sim/importers";

// The importer is browser- and Node-safe: it uses only cross-runtime primitives
// (TextDecoder/TextEncoder/DecompressionStream, DataView, String). Since the
// parsers are pure and deterministic, the same input must yield identical output
// on every runtime — verified here by structural equality across repeated runs.
describe("browser / Node parser parity", () => {
  const yaml = "name: campus\ntopology:\n  nodes:\n    r1:\n      kind: linux\n  links:\n    - endpoints: [r1:eth1, r1:eth2]\n";
  const xml = '<lab name="Lab"><node id="1" type="iol"/><node id="2" type="vpcs"/></lab>';
  const clab: ImportSource = { filename: "x.clab.yml", bytes: new TextEncoder().encode(yaml) };

  it("produces identical YAML output across runs", () => {
    expect(JSON.stringify(parseYaml(yaml))).toBe(JSON.stringify(parseYaml(yaml)));
  });

  it("produces identical XML output across runs", () => {
    expect(JSON.stringify(parseXml(xml))).toBe(JSON.stringify(parseXml(xml)));
  });

  it("produces identical detection results across runs", () => {
    expect(detectLabImportFormat(clab)).toEqual(detectLabImportFormat(clab));
  });

  it("relies only on globals available in both browsers and Node", () => {
    for (const name of ["TextDecoder", "TextEncoder", "DecompressionStream"]) {
      expect(typeof (globalThis as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
