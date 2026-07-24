import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  TERMINAL_APPEARANCE_PROFILES,
  TERMINAL_FONT_STACK,
  terminalAppearanceProfile,
} from "./terminal-appearance";
import { TerminalPager } from "./terminal-pager";

describe("terminal appearance", () => {
  it("defaults to the Appliance Console with a near-black background", () => {
    expect(DEFAULT_TERMINAL_APPEARANCE).toBe("appliance");
    const profile = terminalAppearanceProfile(DEFAULT_TERMINAL_APPEARANCE);
    expect(profile.label).toBe("Appliance Console");
    expect(profile.cursorStyle).toBe("block");
    expect(profile.cursorBlink).toBe(true);
    expect(profile.theme.background).toBe("#0b0e14");
  });

  it("uses a system font stack only (no downloaded or bundled font asset)", () => {
    expect(TERMINAL_FONT_STACK).toContain("monospace");
    expect(TERMINAL_FONT_STACK).not.toMatch(/url\(|\.woff|\.ttf|@font-face|https?:/i);
    for (const profile of Object.values(TERMINAL_APPEARANCE_PROFILES)) {
      expect(profile.fontFamily).toBe(TERMINAL_FONT_STACK);
      expect(profile.fontSize).toBeGreaterThanOrEqual(16);
    }
  });

  it("offers the three documented profiles", () => {
    expect(Object.keys(TERMINAL_APPEARANCE_PROFILES).sort()).toEqual(["appliance", "light", "modern-dark"]);
  });
});

describe("terminal pager", () => {
  const output = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join("\n");

  it("only paginates output taller than the viewport", () => {
    expect(TerminalPager.needed(output, 10)).toBe(false);
    expect(TerminalPager.needed(output, 3)).toBe(true);
  });

  it("advances by page (Space) and by line (Enter), then finishes", () => {
    const pager = new TerminalPager(output, 3);
    const first = pager.page();
    expect(first.text).toBe("line 1\nline 2\nline 3");
    expect(first.more).toBe(true);
    expect(pager.line().text).toBe("line 4");
    expect(pager.done).toBe(false);
    const rest = pager.page();
    expect(rest.text).toBe("line 5\nline 6\nline 7");
    expect(rest.more).toBe(false);
    expect(pager.done).toBe(true);
  });
});
