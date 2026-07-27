// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  BOTTOM_PANEL_HEIGHT_STORAGE_KEY,
  BOTTOM_PANEL_STATE_STORAGE_KEY,
  bottomPanelAnnouncement,
  clampBottomPanelHeight,
  COMPACT_VIEWPORT_HEIGHT,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  defaultBottomPanelState,
  MIN_BOTTOM_PANEL_HEIGHT,
  persistBottomPanelHeight,
  persistBottomPanelState,
  readBottomPanelHeight,
  readBottomPanelState,
  toggledBottomPanelState,
  type BottomPanelState,
} from "./bottom-panel-state";

function setViewportHeight(height: number) {
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

describe("bottom panel state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportHeight(900);
  });

  it("defaults to expanded on a normal viewport", () => {
    expect(defaultBottomPanelState(900)).toBe("expanded");
    expect(readBottomPanelState()).toBe("expanded");
  });

  it("defaults to minimized on a short viewport so the canvas stays usable", () => {
    expect(defaultBottomPanelState(COMPACT_VIEWPORT_HEIGHT - 1)).toBe("minimized");
    setViewportHeight(COMPACT_VIEWPORT_HEIGHT - 1);
    expect(readBottomPanelState()).toBe("minimized");
  });

  it.each(["expanded", "minimized", "hidden"] as const)("persists the %s state locally", (state) => {
    persistBottomPanelState(state);
    expect(window.localStorage.getItem(BOTTOM_PANEL_STATE_STORAGE_KEY)).toBe(state);
    expect(readBottomPanelState()).toBe(state);
  });

  it("ignores an unknown stored state", () => {
    window.localStorage.setItem(BOTTOM_PANEL_STATE_STORAGE_KEY, "collapsed");
    expect(readBottomPanelState()).toBe("expanded");
  });

  it("toggles collapsed states open and an open panel closed", () => {
    const cases: Array<[BottomPanelState, BottomPanelState]> = [
      ["hidden", "expanded"],
      ["minimized", "expanded"],
      ["expanded", "hidden"],
    ];
    for (const [from, to] of cases) expect(toggledBottomPanelState(from)).toBe(to);
  });

  it("announces each state for assistive technology", () => {
    expect(bottomPanelAnnouncement("hidden")).toBe("Bottom panel hidden");
    expect(bottomPanelAnnouncement("minimized")).toBe("Bottom panel minimized");
    expect(bottomPanelAnnouncement("expanded")).toBe("Bottom panel expanded");
  });
});

describe("bottom panel height", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setViewportHeight(900);
  });

  it("keeps a comfortable height inside a tall viewport", () => {
    expect(clampBottomPanelHeight(300, 1_080)).toBe(300);
  });

  it("never falls below the readable minimum", () => {
    expect(clampBottomPanelHeight(40, 1_080)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
  });

  it("never covers the whole canvas after a viewport resize", () => {
    // 48% of a 720px workspace, so the topology keeps the majority.
    expect(clampBottomPanelHeight(700, 720)).toBe(345);
    expect(clampBottomPanelHeight(700, 720)).toBeLessThan(720);
  });

  it("still honours the minimum when the viewport is tiny", () => {
    expect(clampBottomPanelHeight(500, 200)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
  });

  it("falls back to the default for a non-finite height", () => {
    expect(clampBottomPanelHeight(Number.NaN, 1_080)).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  });

  it("round-trips a stored expanded height", () => {
    persistBottomPanelHeight(312);
    expect(window.localStorage.getItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY)).toBe("312");
    expect(readBottomPanelHeight()).toBe(312);
  });

  it("clamps a stored height that no longer fits the viewport", () => {
    persistBottomPanelHeight(700);
    setViewportHeight(720);
    expect(readBottomPanelHeight()).toBe(345);
  });

  it("ignores unusable stored values", () => {
    window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY, "not-a-number");
    expect(readBottomPanelHeight()).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  });
});
