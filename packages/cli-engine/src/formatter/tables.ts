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
