import { describe, expect, it } from "vitest";
import { boundText, classifyBinary, decodeSafeText, looksBinary, stripControlSequences } from "@sim/importers";

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const encoder = new TextEncoder();

describe("binary and text safety", () => {
  it("classifies vendor images and executables by signature", () => {
    expect(classifyBinary(Uint8Array.from([0x51, 0x46, 0x49, 0xfb])).kind).toBe("qemu-disk");
    expect(classifyBinary(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])).isVendorArtifact).toBe(true);
    expect(classifyBinary(Uint8Array.from([0x4d, 0x5a, 0x90, 0x00])).kind).toBe("executable");
  });

  it("classifies vendor artifacts by extension when the body is opaque", () => {
    expect(classifyBinary(new Uint8Array([1, 2, 3]), "IOSv.qcow2").kind).toBe("qemu-disk");
    expect(classifyBinary(new Uint8Array([1, 2, 3]), "router.vmdk").isVendorArtifact).toBe(true);
    expect(classifyBinary(new Uint8Array([1, 2, 3]), "license.lic").kind).toBe("license-file");
  });

  it("treats plain configuration text as importable", () => {
    const config = encoder.encode("hostname R1\ninterface Gi0/0\n");
    expect(classifyBinary(config, "startup.cfg").isVendorArtifact).toBe(false);
    expect(looksBinary(config)).toBe(false);
    expect(looksBinary(Uint8Array.from([0x00, 0x01, 0x02]))).toBe(true);
  });

  it("strips terminal control sequences but keeps tabs and newlines", () => {
    const input = `${ESC}[31mhostname\tR1${ESC}[0m\nline2${NUL}`;
    const cleaned = stripControlSequences(input);
    expect(cleaned).toBe("hostname\tR1\nline2");
    expect(cleaned).not.toContain(ESC);
    expect(cleaned).not.toContain(NUL);
  });

  it("decodes and bounds preserved text", () => {
    expect(decodeSafeText(encoder.encode(`${ESC}]0;title${ESC}\\ok`))).toBe("ok");
    const many = Array.from({ length: 50 }, (_, index) => `line${index}`).join("\n");
    expect(boundText(many, 10_000, 5).split("\n")).toHaveLength(5);
    expect(boundText("abcdefgh", 4, 100)).toBe("abcd");
  });
});
