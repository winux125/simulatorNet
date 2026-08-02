/**
 * Small text primitives shared by the configuration renderer and the diff.
 *
 * They live apart from the renderer so both the browser workspace and the
 * verifier can compare rendered projections without importing the whole
 * vocabulary of device sections.
 */

/**
 * What a secret is rendered as. A verifier, salt, hash or fingerprint is never
 * printed: the reader learns *that* a credential is configured, never its value.
 */
export const REDACTED_SECRET = "<configured>";

/** Dotted subnet mask for an IPv4 prefix length (`24` -> `255.255.255.0`). */
export function maskFromPrefixLength(prefixLength: number): string {
  const bits = prefixLength <= 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (bits >>> shift) & 0xff).join(".");
}

/** Cisco wildcard mask (the bitwise complement of the subnet mask). */
export function wildcardFromPrefixLength(prefixLength: number): string {
  return maskFromPrefixLength(prefixLength)
    .split(".")
    .map((octet) => String(255 - Number(octet)))
    .join(".");
}

/**
 * Normalize rendered text for comparison and for writing a `.cfg`: LF line
 * endings, no trailing whitespace, exactly one trailing newline.
 */
export function normalizeConfigurationText(text: string): string {
  const lines = text.replace(/\r\n|\r/gu, "\n").split("\n").map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** Split rendered configuration text into comparable lines. */
export function configurationLines(text: string): string[] {
  const normalized = normalizeConfigurationText(text);
  return normalized.length === 0 ? [] : normalized.slice(0, -1).split("\n");
}

export type ConfigurationDiffKind = "unchanged" | "added" | "removed";

export interface ConfigurationDiffLine {
  readonly kind: ConfigurationDiffKind;
  readonly text: string;
  /** 1-based line number in the left (startup) projection, when present. */
  readonly leftLine?: number;
  /** 1-based line number in the right (running) projection, when present. */
  readonly rightLine?: number;
}

export interface ConfigurationDiff {
  readonly lines: readonly ConfigurationDiffLine[];
  readonly added: number;
  readonly removed: number;
}

/**
 * A bounded line diff between two rendered projections.
 *
 * It is presentation only: the diff is never a configuration source. It uses a
 * plain longest-common-subsequence over lines, which is deterministic and, with
 * the bounded configuration sizes this package enforces, cheap.
 */
export function diffConfigurationText(left: string, right: string): ConfigurationDiff {
  const a = configurationLines(left);
  const b = configurationLines(right);
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const lines: ConfigurationDiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "unchanged", text: a[i]!, leftLine: i + 1, rightLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      lines.push({ kind: "removed", text: a[i]!, leftLine: i + 1 });
      removed++;
      i++;
    } else {
      lines.push({ kind: "added", text: b[j]!, rightLine: j + 1 });
      added++;
      j++;
    }
  }
  for (; i < a.length; i++) {
    lines.push({ kind: "removed", text: a[i]!, leftLine: i + 1 });
    removed++;
  }
  for (; j < b.length; j++) {
    lines.push({ kind: "added", text: b[j]!, rightLine: j + 1 });
    added++;
  }
  return { lines, added, removed };
}
