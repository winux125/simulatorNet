import type { ImportResult } from "@sim/importers";
import {
  applyImportedWirelessCredentials,
  parseImportedWirelessCredential,
  redactWirelessCredentials,
  resolveDeviceMapping,
} from "@sim/importers";
import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";

describe("wireless import mapping and credentials", () => {
  it.each([
    ["wireless-access-point", "access-point"],
    ["home-router", "wireless-router"],
    ["notebook-computer", "laptop"],
    ["tablet", "smartphone"],
  ] as const)("maps %s to %s deterministically", (sourceKind, expected) => {
    expect(resolveDeviceMapping("cml", sourceKind).targetDeviceType).toBe(expected);
  });

  it("converts imported plaintext into a verifier and redacts the artifact", async () => {
    const imported = await applyImportedWirelessCredentials(fixture(
      "ssid Imported-Lab\nwpa2 passphrase correct-horse-battery\n",
    ));
    const configuration = imported.document.configurations["ap-1"];
    if (configuration?.kind !== "access-point") throw new Error("fixture mismatch");

    expect(configuration.accessPoint).toMatchObject({
      ssid: "Imported-Lab",
      security: { mode: "wpa2-personal" },
    });
    expect(JSON.stringify(configuration)).not.toContain("correct-horse-battery");
    expect(imported.sourceArtifacts[0]?.text).toContain("wpa2 passphrase <redacted>");
    expect(imported.report.credentialsDetected).toBe(1);
    expect(imported.report.credentialsRequiringReset).toBe(0);
  });

  it("redacts unsupported vendor hashes and reports a required credential reset", async () => {
    const source = "ssid Imported-Lab\nwpa-psk 7 08314D5D1A48\n";
    expect(parseImportedWirelessCredential(source)).toMatchObject({ vendorHashDetected: true });
    expect(redactWirelessCredentials(source)).not.toContain("08314D5D1A48");

    const imported = await applyImportedWirelessCredentials(fixture(source));

    expect(imported.report.credentialsRequiringReset).toBe(1);
    expect(imported.report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "wireless-credential-reset-required", nodeId: "ap-1" }),
    ]));
    expect(JSON.stringify(imported)).not.toContain("08314D5D1A48");
  });
});

function fixture(startupConfig: string): ImportResult {
  const document = canonicalizeLabDocument({
    schemaVersion: 1,
    id: "wireless-import",
    title: "Wireless import",
    simulation: { seed: 1 },
    topology: {
      schemaVersion: 1,
      nodes: [{
        id: "ap-1",
        kind: "access-point",
        interfaces: [{ id: "wlan0" }, { id: "eth0" }],
      }],
      links: [],
    },
    configurations: {},
  });
  return {
    document,
    sourceArtifacts: [{ nodeId: "ap-1", kind: "startup-config", text: startupConfig }],
    report: {
      format: "cml",
      platform: "cml",
      importedNodeCount: 1,
      importedLinkCount: 0,
      importedAnnotationCount: 0,
      importedStartupConfigs: 1,
      mappedDeviceTypes: { "access-point": 1 },
      unsupportedDeviceTypes: [],
      ignoredFiles: [],
      ignoredVendorImages: [],
      unparsedConfigLines: 2,
      credentialsDetected: 0,
      credentialsRequiringReset: 0,
      entries: [],
      warningCount: 0,
      errorCount: 0,
    },
  };
}
