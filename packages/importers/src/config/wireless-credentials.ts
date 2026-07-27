/**
 * Bounded wireless credential import. Only an explicit, small educational
 * subset is accepted. Plaintext is converted through the shared cross-runtime
 * verifier and immediately redacted from preserved source artifacts.
 */
import type { DeviceConfig } from "@sim/contracts";
import { createWirelessCredentialVerifier } from "@sim/console-auth";
import type { ImportReport, ImportResult, ImportedSourceArtifact } from "../types";

interface ParsedWirelessCredential {
  ssid?: string;
  passphrase?: string;
  vendorHashDetected: boolean;
}

const KEY_LINE = /^\s*(?:wpa2?[- ]?(?:psk|passphrase)|pre-shared-key|wireless\s+password)\s+(.+?)\s*$/iu;
const SSID_LINE = /^\s*(?:wireless\s+)?ssid\s+(.+?)\s*$/iu;

export function parseImportedWirelessCredential(text: string): ParsedWirelessCredential {
  const result: ParsedWirelessCredential = { vendorHashDetected: false };
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const ssid = SSID_LINE.exec(raw)?.[1]?.trim();
    if (ssid) result.ssid = stripQuotes(ssid).slice(0, 32);
    const key = KEY_LINE.exec(raw)?.[1]?.trim();
    if (!key) continue;
    const tokens = key.split(/\s+/u);
    if (tokens.length > 1 && /^[0-9]$/u.test(tokens[0]!)) {
      if (tokens[0] === "0") result.passphrase = stripQuotes(tokens.slice(1).join(" "));
      else result.vendorHashDetected = true;
    } else {
      result.passphrase = stripQuotes(key);
    }
  }
  return result;
}

export function redactWirelessCredentials(text: string): string {
  return text.replace(
    /^(\s*(?:wpa2?[- ]?(?:psk|passphrase)|pre-shared-key|wireless\s+password)\s+).+$/gimu,
    "$1<redacted>",
  );
}

export async function applyImportedWirelessCredentials(result: ImportResult): Promise<ImportResult> {
  const configurations: Record<string, DeviceConfig> = { ...result.document.configurations };
  const artifacts: ImportedSourceArtifact[] = [];
  let credentialsDetected = result.report.credentialsDetected;
  let credentialsRequiringReset = result.report.credentialsRequiringReset;
  const entries = [...result.report.entries];

  for (const artifact of result.sourceArtifacts) {
    if (artifact.kind !== "startup-config") {
      artifacts.push(artifact);
      continue;
    }
    const configuration = configurations[artifact.nodeId];
    if (!configuration || (configuration.kind !== "access-point" && configuration.kind !== "wireless-router")) {
      artifacts.push(artifact);
      continue;
    }
    const parsed = parseImportedWirelessCredential(artifact.text);
    if (!parsed.passphrase && !parsed.vendorHashDetected) {
      artifacts.push(artifact);
      continue;
    }
    artifacts.push({ ...artifact, text: redactWirelessCredentials(artifact.text) });
    credentialsDetected += 1;
    if (parsed.vendorHashDetected || !parsed.passphrase || parsed.passphrase.length < 8 || parsed.passphrase.length > 63) {
      credentialsRequiringReset += 1;
      entries.push({
        level: "warning",
        code: "wireless-credential-reset-required",
        message: `A vendor wireless key on ${artifact.nodeId} could not be imported; configure a new simulated WPA2 key`,
        nodeId: artifact.nodeId,
      });
      continue;
    }
    const accessPoint = configuration.accessPoint;
    const ssid = parsed.ssid ?? accessPoint.ssid;
    const credentialVerifier = await createWirelessCredentialVerifier(ssid, parsed.passphrase);
    configurations[artifact.nodeId] = {
      ...configuration,
      accessPoint: {
        ...accessPoint,
        ssid,
        security: { mode: "wpa2-personal", credentialVerifier },
      },
    } as DeviceConfig;
    entries.push({
      level: "info",
      code: "wireless-credential-imported",
      message: `Wireless credential on ${artifact.nodeId} was converted to a verifier`,
      nodeId: artifact.nodeId,
    });
  }

  const report: ImportReport = {
    ...result.report,
    credentialsDetected,
    credentialsRequiringReset,
    entries,
    warningCount: entries.filter((entry) => entry.level === "warning").length,
    errorCount: entries.filter((entry) => entry.level === "error").length,
  };
  return {
    document: { ...result.document, configurations },
    report,
    sourceArtifacts: artifacts,
  };
}

function stripQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/u, "$2");
}
