/**
 * Configuration drift: is a device's running configuration saved?
 *
 * The comparison is made over **canonical structured snapshots**, never over
 * rendered text. Two configurations that differ only in property order, or only
 * in a schema default that one of them spelled out, are the same configuration —
 * and a renderer change must never turn a saved device into a modified one.
 */
import type { DeviceConfig } from "@sim/contracts";

/**
 * Deterministic JSON with sorted object keys and `undefined` dropped.
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical
 * configurations built by different code paths would otherwise hash differently.
 */
export function stableConfigurationJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableConfigurationJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableConfigurationJson(entry)}`).join(",")}}`;
}

/**
 * A short, stable digest of one structured device configuration.
 *
 * FNV-1a over the canonical JSON: deterministic in every runtime, no Web Crypto,
 * no async. It identifies a configuration; it is not a security primitive and is
 * never used to protect anything.
 */
export function deviceConfigurationDigest(config: DeviceConfig | undefined): string {
  const text = stableConfigurationJson(config ?? null);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A second pass over the reversed string widens the digest without pulling in
  // a hash library; collisions only ever cost a wrong "Saved" badge, and the
  // authoritative comparison below is the canonical JSON itself.
  let mix = 0x811c9dc5;
  for (let index = text.length - 1; index >= 0; index--) {
    mix ^= text.charCodeAt(index);
    mix = Math.imul(mix, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${mix.toString(16).padStart(8, "0")}`;
}

/**
 * A digest of *rendered* configuration text.
 *
 * Used to detect a `.cfg` projection inside a lab package that someone edited
 * by hand. Like `deviceConfigurationDigest` it identifies content; it is not a
 * security primitive and protects nothing.
 */
export function configurationTextDigest(text: string): string {
  // The same normalization the renderer applies, so a stray trailing newline or
  // a CRLF checkout does not read as a hand edit.
  const normalized = text.replace(/\r\n|\r/gu, "\n").replace(/[ \t]+$/gmu, "").replace(/\n+$/u, "\n");
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}${normalized.length.toString(16)}`;
}

/**
 * A device's saved startup configuration.
 *
 * `implicit` is what every lab written before this milestone has: no startup
 * snapshot was ever stored, so the startup configuration is by definition the
 * configuration the document was saved with. `absent` is the deliberate result
 * of `erase startup-config`.
 */
export type DeviceStartupState =
  | { readonly state: "implicit" }
  | { readonly state: "absent" }
  | { readonly state: "saved"; readonly configuration: DeviceConfig };

export type ConfigurationDriftState = "saved" | "modified" | "no-startup-configuration";

export interface ConfigurationStatus {
  readonly drift: ConfigurationDriftState;
  readonly runningDigest: string;
  /** Absent when the device has no stored startup configuration. */
  readonly startupDigest?: string;
}

/** Human-readable label for a drift state, used by the CLI and the UI alike. */
export function driftLabel(drift: ConfigurationDriftState): string {
  if (drift === "saved") return "Saved";
  if (drift === "modified") return "Modified";
  return "No startup configuration";
}

/**
 * Compare a running configuration with the stored startup snapshot.
 *
 * An `implicit` startup is treated as saved: opening an older lab must not
 * greet the learner with a lab-wide "unsaved changes" warning they never caused.
 */
export function deviceConfigurationStatus(
  running: DeviceConfig,
  startup: DeviceStartupState,
): ConfigurationStatus {
  const runningDigest = deviceConfigurationDigest(running);
  if (startup.state === "implicit") return { drift: "saved", runningDigest, startupDigest: runningDigest };
  if (startup.state === "absent") return { drift: "no-startup-configuration", runningDigest };
  const startupDigest = deviceConfigurationDigest(startup.configuration);
  const same = stableConfigurationJson(running) === stableConfigurationJson(startup.configuration);
  return { drift: same ? "saved" : "modified", runningDigest, startupDigest };
}

/** The configuration a reload would restore, or `undefined` for factory defaults. */
export function startupConfigurationOf(
  running: DeviceConfig,
  startup: DeviceStartupState,
): DeviceConfig | undefined {
  if (startup.state === "implicit") return running;
  if (startup.state === "absent") return undefined;
  return startup.configuration;
}
