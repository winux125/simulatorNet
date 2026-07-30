import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY,
  normalizePanelLayout,
  persistWorkspacePanelLayout,
  readWorkspacePanelLayout,
  WORKSPACE_BOTTOM_PANEL_ID,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  WORKSPACE_MAIN_PANEL_ID,
  WORKSPACE_PANEL_CONSTRAINTS,
  WORKSPACE_PANEL_GROUP_ID,
  WORKSPACE_PANEL_IDS,
  type PanelLayoutStorage,
} from "./workspace-panel-layout";

const defaults = {
  [WORKSPACE_MAIN_PANEL_ID]: 73.333,
  [WORKSPACE_BOTTOM_PANEL_ID]: 26.667,
};

function memoryStorage(initial: Record<string, string> = {}): PanelLayoutStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
}

describe("workspace panel layout normalization", () => {
  it("accepts a valid two-panel layout in explicit DOM order", () => {
    const layout = normalizePanelLayout({
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: {
        [WORKSPACE_BOTTOM_PANEL_ID]: 30,
        [WORKSPACE_MAIN_PANEL_ID]: 70,
      },
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    });
    expect(Object.keys(layout)).toEqual([...WORKSPACE_PANEL_IDS]);
    expect(layout).toEqual({
      [WORKSPACE_MAIN_PANEL_ID]: 70,
      [WORKSPACE_BOTTOM_PANEL_ID]: 30,
    });
  });

  it("rejects a stale two-panel layout for a single-panel set", () => {
    expect(normalizePanelLayout({
      orderedPanelIds: [WORKSPACE_MAIN_PANEL_ID],
      candidateLayout: defaults,
      defaultLayout: { [WORKSPACE_MAIN_PANEL_ID]: 100 },
      constraints: { [WORKSPACE_MAIN_PANEL_ID]: { minPercent: 100, maxPercent: 100 } },
    })).toEqual({ [WORKSPACE_MAIN_PANEL_ID]: 100 });
  });

  it("normalizes harmless rounding drift and falls back for an invalid sum", () => {
    const almost = normalizePanelLayout({
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: {
        [WORKSPACE_MAIN_PANEL_ID]: 73.333,
        [WORKSPACE_BOTTOM_PANEL_ID]: 26.666,
      },
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    });
    expect(Object.values(almost).reduce((sum, value) => sum + value, 0)).toBe(100);

    expect(normalizePanelLayout({
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: {
        [WORKSPACE_MAIN_PANEL_ID]: 60,
        [WORKSPACE_BOTTOM_PANEL_ID]: 20,
      },
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    })).toEqual(defaults);
  });

  it("rejects unknown panel IDs and values outside constraints", () => {
    for (const candidateLayout of [
      { [WORKSPACE_MAIN_PANEL_ID]: 70, unknown: 30 },
      { [WORKSPACE_MAIN_PANEL_ID]: 90, [WORKSPACE_BOTTOM_PANEL_ID]: 10 },
    ]) {
      expect(normalizePanelLayout({
        orderedPanelIds: WORKSPACE_PANEL_IDS,
        candidateLayout,
        defaultLayout: defaults,
        constraints: WORKSPACE_PANEL_CONSTRAINTS,
      })).toEqual(defaults);
    }
  });

  it("migrates the legacy array without relying on Object.values order", () => {
    const storage = memoryStorage({
      [LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY]: JSON.stringify([73.333, 26.667]),
    });
    const layout = readWorkspacePanelLayout({
      storage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
      legacyStorageKeys: [LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY],
    });
    expect(layout).toEqual(defaults);
    expect(storage.getItem(LEGACY_WORKSPACE_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!)).toMatchObject({
      version: 2,
      groups: {
        [WORKSPACE_PANEL_GROUP_ID]: {
          orderedPanelIds: [...WORKSPACE_PANEL_IDS],
          layout: defaults,
        },
      },
    });
  });

  it("drops only a stale group while preserving other stored groups and preferences", () => {
    const storage = memoryStorage({
      [WORKSPACE_LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 2,
        groups: {
          [WORKSPACE_PANEL_GROUP_ID]: {
            orderedPanelIds: [WORKSPACE_MAIN_PANEL_ID],
            layout: { [WORKSPACE_MAIN_PANEL_ID]: 100 },
          },
          unrelated: {
            orderedPanelIds: ["left", "right"],
            layout: { left: 50, right: 50 },
          },
        },
      }),
      "simulatornet.theme": "dark",
      "simulatornet.bottomPanelState": "hidden",
    });
    const warning = vi.fn();
    expect(readWorkspacePanelLayout({
      storage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
      onInvalid: warning,
    })).toEqual(defaults);
    expect(warning).toHaveBeenCalledOnce();
    expect(storage.getItem("simulatornet.theme")).toBe("dark");
    expect(storage.getItem("simulatornet.bottomPanelState")).toBe("hidden");
    expect(JSON.parse(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)!)).toMatchObject({
      groups: { unrelated: { layout: { left: 50, right: 50 } } },
    });
  });

  it("removes malformed v2 data without clearing unrelated local preferences", () => {
    const storage = memoryStorage({
      [WORKSPACE_LAYOUT_STORAGE_KEY]: "{not-json",
      "simulatornet.deviceIconProfile": "minimal",
    });
    expect(readWorkspacePanelLayout({
      storage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      defaultLayout: defaults,
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    })).toEqual(defaults);
    expect(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(storage.getItem("simulatornet.deviceIconProfile")).toBe("minimal");
  });

  it("persists only exact positive layouts and keeps ordered panel IDs", () => {
    const storage = memoryStorage();
    expect(persistWorkspacePanelLayout({
      storage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: {
        [WORKSPACE_MAIN_PANEL_ID]: 68,
        [WORKSPACE_BOTTOM_PANEL_ID]: 32,
      },
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    })).toEqual({
      [WORKSPACE_MAIN_PANEL_ID]: 68,
      [WORKSPACE_BOTTOM_PANEL_ID]: 32,
    });
    const before = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    expect(persistWorkspacePanelLayout({
      storage,
      groupId: WORKSPACE_PANEL_GROUP_ID,
      orderedPanelIds: WORKSPACE_PANEL_IDS,
      candidateLayout: {
        [WORKSPACE_MAIN_PANEL_ID]: 100,
        [WORKSPACE_BOTTOM_PANEL_ID]: 0,
      },
      constraints: WORKSPACE_PANEL_CONSTRAINTS,
    })).toBeUndefined();
    expect(storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(before);
  });
});
