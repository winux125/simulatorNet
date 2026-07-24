import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_LIMITS,
  ImportSecurityError,
  readZipCentralDirectory,
  readZipEntryData,
} from "@sim/importers";
import { buildZip, deflateRaw } from "./helpers/zip";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SYMLINK_MODE = 0xa1ff; // S_IFLNK | 0777

describe("archive security", () => {
  it("rejects ZIP-slip and absolute paths", () => {
    expect(() => readZipCentralDirectory(buildZip([{ name: "../../etc/passwd", data: encoder.encode("x") }])))
      .toThrow(ImportSecurityError);
    expect(() => readZipCentralDirectory(buildZip([{ name: "/etc/shadow", data: encoder.encode("x") }])))
      .toThrow(/absolute/i);
    expect(() => readZipCentralDirectory(buildZip([{ name: "C:\\windows\\evil", data: encoder.encode("x") }])))
      .toThrow(/drive|absolute/i);
  });

  it("rejects symlink entries", () => {
    const zip = buildZip([{ name: "link", data: encoder.encode("/etc/passwd"), unixMode: SYMLINK_MODE }]);
    expect(() => readZipCentralDirectory(zip)).toThrow(/symlink/i);
  });

  it("rejects duplicate conflicting paths", () => {
    const zip = buildZip([
      { name: "topology.unl", data: encoder.encode("a") },
      { name: "topology.unl", data: encoder.encode("b") },
    ]);
    expect(() => readZipCentralDirectory(zip)).toThrow(/duplicate/i);
  });

  it("rejects an excessive file count", () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({ name: `f${index}.txt`, data: encoder.encode("x") }));
    expect(() => readZipCentralDirectory(buildZip(entries), { ...DEFAULT_IMPORT_LIMITS, maxArchiveEntries: 2 }))
      .toThrow(ImportSecurityError);
  });

  it("rejects an excessive compression ratio before decompressing", () => {
    const zip = buildZip([{
      name: "bomb.txt",
      method: 8,
      data: encoder.encode("x"),
      declaredCompressedSize: 1,
      declaredUncompressedSize: 5_000_000,
    }]);
    expect(() => readZipCentralDirectory(zip)).toThrow(/compression-ratio|compression ratio/i);
  });

  it("rejects excessive total uncompressed size", () => {
    const zip = buildZip([
      { name: "a.txt", data: encoder.encode("x"), declaredUncompressedSize: 900 },
      { name: "b.txt", data: encoder.encode("x"), declaredUncompressedSize: 900 },
    ]);
    expect(() => readZipCentralDirectory(zip, { ...DEFAULT_IMPORT_LIMITS, maxUncompressedBytes: 1_000 }))
      .toThrow(ImportSecurityError);
  });

  it("reads a stored entry and round-trips a deflate entry", async () => {
    const stored = buildZip([{ name: "hello.txt", data: encoder.encode("hello world") }]);
    const entries = readZipCentralDirectory(stored);
    expect(entries).toHaveLength(1);
    expect(decoder.decode(await readZipEntryData(stored, entries[0]!))).toBe("hello world");

    const payload = encoder.encode("R1#show running-config\n".repeat(20));
    const deflated = await deflateRaw(payload);
    const zip = buildZip([{ name: "config.txt", method: 8, data: deflated, declaredUncompressedSize: payload.length }]);
    const parsed = readZipCentralDirectory(zip);
    expect(decoder.decode(await readZipEntryData(zip, parsed[0]!))).toBe(decoder.decode(payload));
  });
});
