import { describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS, ImportSecurityError, parseYaml } from "@sim/importers";

describe("safe YAML subset parser", () => {
  it("parses block mappings and nested maps", () => {
    const value = parseYaml("name: office\ntopology:\n  nodes:\n    r1:\n      kind: linux\n") as Record<string, unknown>;
    expect(value.name).toBe("office");
    expect(value).toMatchObject({ topology: { nodes: { r1: { kind: "linux" } } } });
  });

  it("parses block sequences and sequences of maps", () => {
    const value = parseYaml("items:\n  - one\n  - two\nnodes:\n  - id: n1\n    kind: x\n  - id: n2\n") as Record<string, unknown>;
    expect(value.items).toEqual(["one", "two"]);
    expect(value.nodes).toEqual([{ id: "n1", kind: "x" }, { id: "n2" }]);
  });

  it("parses flow collections", () => {
    expect(parseYaml("list: [a, b, c]\nmap: {k: v}")).toEqual({ list: ["a", "b", "c"], map: { k: "v" } });
  });

  it("preserves literal block scalars", () => {
    const value = parseYaml("config: |\n  hostname R1\n  interface Gi0/0\n") as Record<string, string>;
    expect(value.config).toBe("hostname R1\ninterface Gi0/0\n");
  });

  it("rejects custom and global tags", () => {
    expect(() => parseYaml('x: !Custom v')).toThrow(ImportSecurityError);
    expect(() => parseYaml('x: !!python/object/apply:os.system ["ls"]')).toThrow(/tag/i);
  });

  it("rejects anchors and aliases", () => {
    expect(() => parseYaml("x: *anchor")).toThrow(/alias|anchor/i);
  });

  it("enforces the nesting depth limit", () => {
    const deep = "a:\n b:\n  c:\n   d:\n    e: 1\n";
    expect(() => parseYaml(deep, { ...DEFAULT_IMPORT_LIMITS, maxYamlDepth: 2 })).toThrow(/depth/i);
  });
});
