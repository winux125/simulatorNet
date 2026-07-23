export class TerminalCommandHistory {
  private readonly entries: string[] = [];
  private cursor = 0;

  record(command: string): void {
    if (!command || command.trimEnd().endsWith("?")) return;
    this.entries.push(command);
    this.cursor = this.entries.length;
  }

  previous(): string {
    this.cursor = Math.max(0, this.cursor - 1);
    return this.entries[this.cursor] ?? "";
  }

  next(): string {
    this.cursor = Math.min(this.entries.length, this.cursor + 1);
    return this.entries[this.cursor] ?? "";
  }
}
