// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_FLOATING_BOUNDS,
  MIN_TERMINAL_FLOATING_HEIGHT,
  MIN_TERMINAL_FLOATING_WIDTH,
  TERMINAL_PRESENTATION_STORAGE_KEY,
  clampTerminalBounds,
  persistTerminalPresentationMode,
  readTerminalPresentationMode,
} from "./terminal-presentation-state";

describe("terminal presentation state", () => {
  beforeEach(() => window.localStorage.removeItem(TERMINAL_PRESENTATION_STORAGE_KEY));

  it("defaults to a docked terminal", () => {
    expect(readTerminalPresentationMode()).toBe("docked");
  });

  it.each(["docked", "floating", "maximized"] as const)("persists the %s mode locally", (mode) => {
    persistTerminalPresentationMode(mode);
    expect(readTerminalPresentationMode()).toBe(mode);
    expect(window.localStorage.getItem(TERMINAL_PRESENTATION_STORAGE_KEY)).toBe(mode);
  });

  it("ignores an unknown stored presentation", () => {
    window.localStorage.setItem(TERMINAL_PRESENTATION_STORAGE_KEY, "popup");
    expect(readTerminalPresentationMode()).toBe("docked");
  });

  it("clamps all floating edges inside the workspace", () => {
    expect(clampTerminalBounds(
      { x: -30, y: 900, width: 700, height: 400 },
      { width: 1_000, height: 700 },
    )).toEqual({ x: 0, y: 300, width: 700, height: 400 });
  });

  it("enforces the floating minimum size when space permits", () => {
    expect(clampTerminalBounds(
      { x: 0, y: 0, width: 100, height: 100 },
      { width: 1_000, height: 700 },
    )).toMatchObject({
      width: MIN_TERMINAL_FLOATING_WIDTH,
      height: MIN_TERMINAL_FLOATING_HEIGHT,
    });
  });

  it("shrinks safely when the workspace is below the minimum size", () => {
    expect(clampTerminalBounds(
      DEFAULT_TERMINAL_FLOATING_BOUNDS,
      { width: 320, height: 180 },
    )).toEqual({ x: 0, y: 0, width: 320, height: 180 });
  });
});
