/**
 * Pure, DOM-free state for the workspace bottom panel.
 *
 * The panel's presentation (expanded / minimized / hidden) and its expanded
 * height are local workspace preferences: they never enter `LabDocument`, an
 * assignment, a submission, grading, or the database. Keeping the transitions,
 * clamping and storage keys here makes them testable without a browser.
 */

export type BottomPanelState = "expanded" | "minimized" | "hidden";

export const BOTTOM_PANEL_STATE_STORAGE_KEY = "simulatornet.bottomPanelState";
export const BOTTOM_PANEL_HEIGHT_STORAGE_KEY = "simulatornet.bottomPanelExpandedHeight";

/** Height of the compact tab strip shown while the panel is minimized. */
export const BOTTOM_PANEL_STRIP_HEIGHT = 34;
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 240;
export const MIN_BOTTOM_PANEL_HEIGHT = 180;
/** The panel never takes more than this share of the workspace from the canvas. */
export const MAX_BOTTOM_PANEL_VIEWPORT_RATIO = 0.48;
/** Below this viewport height a first run starts minimized so the canvas is usable. */
export const COMPACT_VIEWPORT_HEIGHT = 620;

function isBottomPanelState(value: unknown): value is BottomPanelState {
  return value === "expanded" || value === "minimized" || value === "hidden";
}

/**
 * Clamp the expanded height to something that leaves a usable canvas.
 * `viewportHeight` is the full workspace height the panel shares with the canvas.
 */
export function clampBottomPanelHeight(height: number, viewportHeight: number): number {
  const ceiling = Math.max(
    MIN_BOTTOM_PANEL_HEIGHT,
    Math.floor(Math.max(1, viewportHeight) * MAX_BOTTOM_PANEL_VIEWPORT_RATIO),
  );
  if (!Number.isFinite(height)) return Math.min(DEFAULT_BOTTOM_PANEL_HEIGHT, ceiling);
  return Math.min(Math.max(Math.round(height), MIN_BOTTOM_PANEL_HEIGHT), ceiling);
}

/**
 * The default for a first run. A short viewport starts minimized — the tabs and
 * their badges stay reachable while the topology keeps the remaining space.
 */
export function defaultBottomPanelState(viewportHeight: number): BottomPanelState {
  return viewportHeight > 0 && viewportHeight < COMPACT_VIEWPORT_HEIGHT ? "minimized" : "expanded";
}

export function readBottomPanelState(): BottomPanelState {
  if (typeof window === "undefined") return "expanded";
  const stored = window.localStorage.getItem(BOTTOM_PANEL_STATE_STORAGE_KEY);
  return isBottomPanelState(stored) ? stored : defaultBottomPanelState(window.innerHeight);
}

export function persistBottomPanelState(state: BottomPanelState): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(BOTTOM_PANEL_STATE_STORAGE_KEY, state);
  }
}

export function readBottomPanelHeight(): number {
  if (typeof window === "undefined") return DEFAULT_BOTTOM_PANEL_HEIGHT;
  const stored = Number(window.localStorage.getItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY));
  return clampBottomPanelHeight(
    Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_BOTTOM_PANEL_HEIGHT,
    window.innerHeight,
  );
}

export function persistBottomPanelHeight(height: number): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY, String(Math.round(height)));
  }
}

/**
 * `Ctrl/Cmd+J`: anything collapsed opens, an open panel hides. Minimizing is a
 * deliberate choice from the menu or the panel controls, never a toggle step.
 */
export function toggledBottomPanelState(current: BottomPanelState): BottomPanelState {
  return current === "expanded" ? "hidden" : "expanded";
}

/** Announcement text for the panel's live region. */
export function bottomPanelAnnouncement(state: BottomPanelState): string {
  return `Bottom panel ${state}`;
}
