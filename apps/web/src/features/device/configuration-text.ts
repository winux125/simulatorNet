/**
 * Pure helpers for the device Configuration workspace.
 *
 * Everything risky about showing and downloading configuration text lives here
 * so it can be unit-tested without a browser: line numbering, search, the
 * filename a `.cfg` gets, and the bounds on what is read from a file.
 *
 * Nothing here renders configuration — that is `@sim/device-config`'s job — and
 * nothing here parses it.
 */
import { DEFAULT_DEVICE_CONFIGURATION_LIMITS } from "@sim/device-config";

export type ConfigurationSection = "running" | "startup" | "compare" | "import";

export const CONFIGURATION_SECTIONS: ReadonlyArray<{ id: ConfigurationSection; label: string }> = [
  { id: "running", label: "Running Config" },
  { id: "startup", label: "Startup Config" },
  { id: "compare", label: "Compare" },
  { id: "import", label: "Import / Paste" },
];

export interface NumberedLine {
  readonly number: number;
  readonly text: string;
  /** True when the line matches the active search term. */
  readonly match: boolean;
}

/** Split configuration text for display, tagging search matches. */
export function numberedLines(text: string, search = ""): NumberedLine[] {
  const term = search.trim().toLowerCase();
  const body = text.replace(/\n$/u, "");
  if (body.length === 0) return [];
  return body.split("\n").map((line, index) => ({
    number: index + 1,
    text: line,
    match: term.length > 0 && line.toLowerCase().includes(term),
  }));
}

/** Control characters that must never survive into a filename. */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/gu;
/** Tab, LF and CR are the only control characters a configuration file has. */
const BINARY_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/**
 * Turn a hostname into a safe `.cfg` filename component.
 *
 * A hostname reaches this from a lab file, so it is untrusted: path separators,
 * traversal and control characters are removed rather than escaped.
 */
export function sanitizeConfigurationFileName(hostname: string): string {
  const cleaned = hostname
    .normalize("NFKD")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.+/gu, ".")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : "device";
}

export function configurationFileName(hostname: string, kind: "running" | "startup"): string {
  return `${sanitizeConfigurationFileName(hostname)}-${kind}.cfg`;
}

export type ConfigurationFileRead =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "rejected"; readonly message: string };

/**
 * Validate text read from a `.cfg` / `.txt` upload before it reaches the parser.
 *
 * A configuration file is plain text; anything with NUL or other binary control
 * bytes is refused outright rather than sanitized into something the learner
 * did not write.
 */
export function readConfigurationFileText(
  raw: string,
  limits = DEFAULT_DEVICE_CONFIGURATION_LIMITS,
): ConfigurationFileRead {
  if (raw.length > limits.maximumTextCharacters) {
    return {
      status: "rejected",
      message: `Configuration file is larger than ${limits.maximumTextCharacters.toLocaleString("en-US")} characters.`,
    };
  }
  if (BINARY_CHARACTERS.test(raw)) {
    return { status: "rejected", message: "That file is not plain configuration text." };
  }
  const text = raw.replace(/\r\n|\r/gu, "\n");
  if (text.trim().length === 0) return { status: "rejected", message: "The configuration file is empty." };
  const lines = text.split("\n").length;
  if (lines > limits.maximumTextLines) {
    return {
      status: "rejected",
      message: `Configuration file has more than ${limits.maximumTextLines.toLocaleString("en-US")} lines.`,
    };
  }
  return { status: "ok", text };
}

/** Wording for the drift badge, shared by the device window and the canvas. */
export function driftSummary(drift: string, changedLines: number): string {
  if (drift === "no-startup-configuration") return "No startup configuration";
  if (drift === "saved") return "Saved";
  return changedLines === 1
    ? "Running configuration has 1 unsaved change."
    : `Running configuration has ${changedLines} unsaved changes.`;
}
