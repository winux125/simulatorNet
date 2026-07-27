/**
 * Pure, DOM-free clipboard-paste primitives for the xterm CLI surface.
 *
 * Pasting is a browser-only presentation concern — the verifier never pastes —
 * so this lives beside the line editor rather than in a shared package. Keeping
 * the sanitizer, newline rules, bounded limits and interactive-prompt detection
 * here means the risky parts are unit-testable without a browser, and
 * `TerminalPanel` only wires them to xterm reads/writes and worker requests.
 */
import { stripControlSequences } from "@sim/importers";

export interface TerminalPasteLimits {
  /** Sanitized characters accepted for one paste. */
  readonly maximumCharacters: number;
  /** Lines accepted for one paste. */
  readonly maximumLines: number;
  /** Complete commands a single paste may queue for sequential execution. */
  readonly maximumPendingCommands: number;
  /** Raw clipboard text scanned at all, before any other work. */
  readonly maximumRawCharacters: number;
  /** Characters accepted while a credential prompt is active. */
  readonly maximumSecretCharacters: number;
}

/** One central place for every paste bound; nothing else invents its own. */
export const TERMINAL_PASTE_LIMITS: TerminalPasteLimits = {
  maximumCharacters: 100_000,
  maximumLines: 1_000,
  maximumPendingCommands: 500,
  maximumRawCharacters: 1_048_576,
  maximumSecretCharacters: 1_024,
};

/** Shown in the terminal when a pasted sequence stops for a prompt. */
export const PASTE_PAUSED_FOR_INPUT = "Pasted command sequence paused for interactive input.";
/** Shown when the next pasted command would race a queued Step-mode operation. */
export const PASTE_PAUSED_FOR_OPERATION = "Pasted command sequence paused until the queued network operation completes.";
/** Shown when the Clipboard API is unavailable, empty or denied. */
export const CLIPBOARD_UNAVAILABLE_MESSAGE = "Clipboard access was not granted.\nUse Ctrl+V to paste into the terminal.";

export const CONFIRM_MULTILINE_PASTE_STORAGE_KEY = "simulatornet.confirmMultilinePaste";

/** Local-only preference. Never enters LabDocument, a submission or grading. */
export function readConfirmMultilinePaste(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(CONFIRM_MULTILINE_PASTE_STORAGE_KEY) !== "false";
}

export function persistConfirmMultilinePaste(confirm: boolean): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(CONFIRM_MULTILINE_PASTE_STORAGE_KEY, confirm ? "true" : "false");
  }
}

export type TerminalPastePlan =
  | { readonly status: "empty" }
  | { readonly status: "rejected"; readonly message: string }
  | {
    readonly status: "ready";
    /** Lines terminated by a newline: each is executed like typing + Enter. */
    readonly commands: readonly string[];
    /** An unterminated final line: it stays in the input buffer, unexecuted. */
    readonly remainder: string;
    /** True when this is a bulk sequence rather than one command or fragment. */
    readonly bulk: boolean;
  };

export type TerminalSecretPaste =
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "ready"; readonly text: string };

// NUL and the file/record separators never appear in text a person meant to
// paste into a console; they signal binary content, so the paste is refused
// rather than silently repaired.
const BINARY_PATTERN = /[\u0000\u000E-\u001A\u001C-\u001F]/;
// Anything a terminal would act on rather than display. ESC is excluded: escape
// sequences are stripped by the sanitizer instead of rejecting the whole paste.
const CONTROL_PATTERN = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/;

function tooLarge(what: string): { status: "rejected"; message: string } {
  return { status: "rejected", message: `Paste is too large.\nMaximum: ${what}.` };
}

/**
 * Collapse CRLF and lone CR to LF so a Windows, classic-Mac or Unix clipboard
 * produces exactly the same command sequence.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Reduce raw clipboard text to plain terminal input.
 *
 * Escape sequences (CSI, OSC clipboard/title/hyperlink, DCS/SOS/PM/APC and lone
 * escapes), C1 controls and DEL are removed; printable Unicode, spaces and line
 * breaks survive untouched. A tab becomes a single space: the CLI lexer splits
 * on whitespace anyway, and a real tab would advance the cursor to the next tab
 * stop, desynchronizing the line editor's caret arithmetic during a redraw.
 */
export function sanitizePasteText(text: string): string {
  return stripControlSequences(normalizeNewlines(text)).replace(/\t/g, " ");
}

/**
 * Turn raw clipboard text into a bounded execution plan.
 *
 * A trailing newline means the last command runs; without one the final line is
 * left in the input buffer so the user still presses Enter themselves.
 */
export function prepareTerminalPaste(
  raw: string,
  limits: TerminalPasteLimits = TERMINAL_PASTE_LIMITS,
): TerminalPastePlan {
  if (raw.length === 0) return { status: "empty" };
  if (raw.length > limits.maximumRawCharacters) {
    return tooLarge(`${limits.maximumRawCharacters.toLocaleString("en-US")} characters of clipboard text`);
  }
  if (BINARY_PATTERN.test(raw)) {
    return { status: "rejected", message: "Paste contained binary or NUL data and was rejected." };
  }
  const text = sanitizePasteText(raw);
  if (text.length === 0) return { status: "empty" };
  if (text.length > limits.maximumCharacters) {
    return tooLarge(`${limits.maximumCharacters.toLocaleString("en-US")} characters`);
  }

  const lines = text.split("\n");
  if (lines.length > limits.maximumLines) {
    return tooLarge(`${limits.maximumLines.toLocaleString("en-US")} lines`);
  }
  // "a\nb\n" -> ["a","b",""]: every element but the last is newline-terminated,
  // so it runs. The last element is either the newline itself ("") or an
  // unterminated fragment ("a\nb" -> ["a","b"]) that stays in the buffer.
  const commands = lines.slice(0, -1);
  const remainder = lines.at(-1) ?? "";
  if (commands.length > limits.maximumPendingCommands) {
    return tooLarge(`${limits.maximumPendingCommands.toLocaleString("en-US")} commands`);
  }
  return {
    status: "ready",
    commands,
    remainder,
    bulk: commands.length > 1 || (commands.length === 1 && remainder.length > 0),
  };
}

/**
 * Validate a paste made while a Username/Password/enable-secret prompt is
 * active. The text is never sanitized — a credential must reach the verifier
 * byte-for-byte — so anything that is not a single plain line is refused.
 */
export function prepareSecretPaste(
  raw: string,
  limits: TerminalPasteLimits = TERMINAL_PASTE_LIMITS,
): TerminalSecretPaste {
  if (raw.length > limits.maximumSecretCharacters) {
    return { status: "rejected", message: `Paste is too large.\nMaximum: ${limits.maximumSecretCharacters.toLocaleString("en-US")} characters.` };
  }
  if (/[\r\n]/.test(raw)) {
    return { status: "rejected", message: "A multi-line paste cannot be used for a password." };
  }
  if (CONTROL_PATTERN.test(raw)) {
    return { status: "rejected", message: "Pasted credential contained control characters and was rejected." };
  }
  return { status: "ready", text: raw };
}

/**
 * True when the device is asking a question rather than offering a shell
 * prompt, so a queued paste must stop instead of answering it blindly.
 *
 * Shell prompts end in `>` or `#` (`C:\>`, `R1#`, `R1(config-if)#`). Interactive
 * prompts end in `:` or `?`, or carry an IOS confirmation marker
 * (`Target IP address:`, `Password:`, `[confirm]`, `[yes/no]:`).
 */
export function isInteractivePrompt(prompt: string): boolean {
  const value = prompt.trimEnd();
  if (value.length === 0) return false;
  if (value.endsWith(">") || value.endsWith("#")) return false;
  return /[:?]$/.test(value) || /\[(?:confirm|yes\/no)\]$/i.test(value);
}

export interface TerminalPastePreview {
  readonly lines: readonly string[];
  readonly hidden: number;
  readonly total: number;
}

/** Bounded preview for the confirmation popover: never renders a huge paste. */
export function pastePreview(
  commands: readonly string[],
  remainder: string,
  maximum = 12,
): TerminalPastePreview {
  const all = remainder.length > 0 ? [...commands, remainder] : [...commands];
  return {
    lines: all.slice(0, maximum),
    hidden: Math.max(0, all.length - maximum),
    total: all.length,
  };
}
