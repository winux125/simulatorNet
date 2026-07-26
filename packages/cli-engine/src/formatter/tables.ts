/** Left-justify `s` into `width` columns (never truncates). */
export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** Join padded cells and strip trailing spaces from the resulting line. */
export function row(cells: Array<[text: string, width: number]>): string {
  return cells.map(([text, width]) => pad(text, width)).join("").replace(/\s+$/, "");
}

/** A dashed underline of the given width. */
export function dashes(width: number): string {
  return "-".repeat(width);
}

/**
 * A simple header + rows table whose columns are as wide as their widest cell.
 * Column widths are derived from the data, so output stays stable for a given
 * device state and golden transcripts keep working.
 */
export function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((cells) => (cells[index] ?? "").length)) + 2);
  const line = (cells: readonly string[]): string =>
    row(cells.map((text, index) => [text, widths[index] ?? text.length + 2]));
  return [line(headers), line(widths.map((width) => dashes(width - 2))), ...rows.map(line)].join("\n");
}
