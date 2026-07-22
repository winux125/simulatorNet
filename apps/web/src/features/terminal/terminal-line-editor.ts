/**
 * Pure, DOM-free line-editing primitives for the xterm CLI surface.
 *
 * Keeping the cursor logic and key classification here (rather than inside the
 * React/xterm component) mirrors the determinism-first style of the simulator
 * core: the tricky part is a small pure module that can be unit-tested without a
 * browser, and the panel only wires it to xterm reads/writes.
 */

/** A mutable single-line input buffer with a caret position. */
export class LineBuffer {
  private text = "";
  private caret = 0;

  get value(): string {
    return this.text;
  }

  /** Caret offset, always clamped to `[0, value.length]`. */
  get cursor(): number {
    return this.caret;
  }

  /** Characters between the caret and the end of the line (used for redraws). */
  get tail(): number {
    return this.text.length - this.caret;
  }

  insert(chunk: string): void {
    this.text = this.text.slice(0, this.caret) + chunk + this.text.slice(this.caret);
    this.caret += chunk.length;
  }

  backspace(): boolean {
    if (this.caret === 0) return false;
    this.text = this.text.slice(0, this.caret - 1) + this.text.slice(this.caret);
    this.caret -= 1;
    return true;
  }

  deleteForward(): boolean {
    if (this.caret >= this.text.length) return false;
    this.text = this.text.slice(0, this.caret) + this.text.slice(this.caret + 1);
    return true;
  }

  left(): boolean {
    if (this.caret === 0) return false;
    this.caret -= 1;
    return true;
  }

  right(): boolean {
    if (this.caret >= this.text.length) return false;
    this.caret += 1;
    return true;
  }

  home(): void {
    this.caret = 0;
  }

  end(): void {
    this.caret = this.text.length;
  }

  /** Replace the whole line (e.g. when recalling history) and park the caret at the end. */
  replace(next: string): void {
    this.text = next;
    this.caret = next.length;
  }

  clear(): void {
    this.text = "";
    this.caret = 0;
  }
}

export type TerminalKey =
  | { kind: "enter" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "history-prev" }
  | { kind: "history-next" }
  | { kind: "clear" }
  | { kind: "interrupt" }
  | { kind: "insert"; text: string };

// Terminals emit Home/End with a few historical encodings depending on mode.
const HOME_SEQUENCES = new Set(["\x1b[H", "\x1b[1~", "\x1bOH", "\x01"]);
const END_SEQUENCES = new Set(["\x1b[F", "\x1b[4~", "\x1bOF", "\x05"]);

/**
 * Translate a raw xterm `onData` chunk into a semantic editing intent.
 * Returns `undefined` for control sequences we deliberately ignore.
 */
export function classifyTerminalKey(data: string): TerminalKey | undefined {
  switch (data) {
    case "\r":
    case "\n":
      return { kind: "enter" };
    case "\x7f":
    case "\b":
      return { kind: "backspace" };
    case "\x1b[3~":
      return { kind: "delete" };
    case "\x1b[D":
      return { kind: "left" };
    case "\x1b[C":
      return { kind: "right" };
    case "\x1b[A":
      return { kind: "history-prev" };
    case "\x1b[B":
      return { kind: "history-next" };
    case "\x0c":
      return { kind: "clear" }; // Ctrl+L
    case "\x03":
      return { kind: "interrupt" }; // Ctrl+C
  }
  if (HOME_SEQUENCES.has(data)) return { kind: "home" };
  if (END_SEQUENCES.has(data)) return { kind: "end" };
  // Printable text, including pasted multi-character chunks. Reject anything with
  // control characters so stray escape sequences never land in the command.
  if (data.length > 0 && [...data].every((ch) => ch >= " " && ch !== "\x7f")) {
    return { kind: "insert", text: data };
  }
  return undefined;
}
