import { describe, expect, it } from "vitest";
import { DEFAULT_IMPORT_LIMITS, ImportSecurityError, findElement, parseXml } from "@sim/importers";

describe("safe XML parser", () => {
  it("parses elements, attributes and text", () => {
    const root = parseXml('<lab name="Lab"><node id="1" type="iol">R1</node></lab>');
    expect(root.name).toBe("lab");
    expect(root.attributes.name).toBe("Lab");
    expect(root.children[0]!.name).toBe("node");
    expect(root.children[0]!.attributes.type).toBe("iol");
    expect(root.children[0]!.text).toBe("R1");
    expect(findElement(root, "node")?.attributes.id).toBe("1");
  });

  it("resolves only the predefined entities", () => {
    expect(parseXml("<a>&lt;tag&gt; &amp; &quot;x&quot;</a>").text).toBe('<tag> & "x"');
  });

  it("rejects DOCTYPE / DTD", () => {
    expect(() => parseXml('<!DOCTYPE lab [<!ENTITY x "y">]><lab/>')).toThrow(ImportSecurityError);
  });

  it("rejects a custom entity reference (XXE-style)", () => {
    expect(() => parseXml("<lab>&xxe;</lab>")).toThrow(/entity/i);
  });

  it("enforces the nesting depth limit", () => {
    const deep = "<a>".repeat(10) + "x" + "</a>".repeat(10);
    expect(() => parseXml(deep, { ...DEFAULT_IMPORT_LIMITS, maxXmlDepth: 4 })).toThrow(/depth/i);
  });
});
