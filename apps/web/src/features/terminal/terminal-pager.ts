/**
 * `--More--` pagination for long terminal output, matching a network console:
 * Space advances a full page, Enter advances one line, q/Esc stop. Pagination is
 * a terminal-UI concern only — it never touches the simulation's virtual time.
 */
export interface TerminalPage {
  readonly text: string;
  readonly more: boolean;
}

export class TerminalPager {
  private readonly lines: string[];
  private index = 0;

  constructor(text: string, private readonly rows: number) {
    this.lines = text.split("\n");
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] === "") this.lines.pop();
  }

  get done(): boolean {
    return this.index >= this.lines.length;
  }

  /** Advance a full page (Space). */
  page(): TerminalPage {
    return this.take(Math.max(1, this.rows));
  }

  /** Advance one line (Enter). */
  line(): TerminalPage {
    return this.take(1);
  }

  private take(count: number): TerminalPage {
    const chunk = this.lines.slice(this.index, this.index + count);
    this.index += chunk.length;
    return { text: chunk.join("\n"), more: !this.done };
  }

  /** Whether the text is long enough to need paging in a viewport of `rows`. */
  static needed(text: string, rows: number): boolean {
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return rows > 0 && lines.length > rows;
  }
}
