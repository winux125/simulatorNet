import { describe, expect, it } from "vitest";
import {
  configurationFileName,
  driftSummary,
  numberedLines,
  readConfigurationFileText,
  sanitizeConfigurationFileName,
} from "./configuration-text";

describe("configuration viewer text", () => {
  it("numbers lines and marks search matches", () => {
    const lines = numberedLines("hostname R1\n!\ninterface Gi0/0\n", "interface");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ number: 1, text: "hostname R1", match: false });
    expect(lines[2]).toMatchObject({ number: 3, match: true });
    expect(numberedLines("", "x")).toEqual([]);
  });

  it("sanitizes an untrusted hostname into a filename", () => {
    expect(configurationFileName("R1", "running")).toBe("R1-running.cfg");
    expect(configurationFileName("../../etc/passwd", "startup")).toBe("etc-passwd-startup.cfg");
    expect(sanitizeConfigurationFileName("Branch Router #2")).toBe("Branch-Router-2");
    expect(sanitizeConfigurationFileName("...")).toBe("device");
    expect(sanitizeConfigurationFileName("a".repeat(200))).toHaveLength(64);
  });
});

describe("configuration file upload", () => {
  it("accepts plain text and normalizes line endings", () => {
    const read = readConfigurationFileText("hostname R1\r\ninterface Gi0/0\r\n");
    expect(read).toEqual({ status: "ok", text: "hostname R1\ninterface Gi0/0\n" });
  });

  it("refuses binary content, empty files and oversized files", () => {
    expect(readConfigurationFileText("hostname\u0000R1")).toMatchObject({ status: "rejected" });
    expect(readConfigurationFileText("   \n ")).toMatchObject({ status: "rejected" });
    expect(readConfigurationFileText("!\n".repeat(10), {
      maximumTextCharacters: 5,
      maximumTextLines: 100,
      maximumReportedLineCharacters: 10,
      maximumReportedLines: 10,
    })).toMatchObject({ status: "rejected" });
  });
});

describe("drift wording", () => {
  it("counts unsaved changes only when the device is modified", () => {
    expect(driftSummary("saved", 0)).toBe("Saved");
    expect(driftSummary("no-startup-configuration", 4)).toBe("No startup configuration");
    expect(driftSummary("modified", 1)).toBe("Running configuration has 1 unsaved change.");
    expect(driftSummary("modified", 4)).toBe("Running configuration has 4 unsaved changes.");
  });
});
