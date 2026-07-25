export type TerminalPresentationMode = "docked" | "floating" | "maximized";
export type RestorableTerminalPresentationMode = Exclude<TerminalPresentationMode, "maximized">;

export interface TerminalFloatingBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalWorkspaceSize {
  width: number;
  height: number;
}

export const TERMINAL_PRESENTATION_STORAGE_KEY = "simulatornet.terminalPresentation";
export const TERMINAL_DOCK_SLOT_ID = "terminal-dock-slot";
export const DEFAULT_TERMINAL_FLOATING_BOUNDS: TerminalFloatingBounds = {
  x: 96,
  y: 56,
  width: 780,
  height: 420,
};
export const MIN_TERMINAL_FLOATING_WIDTH = 440;
export const MIN_TERMINAL_FLOATING_HEIGHT = 240;

export function readTerminalPresentationMode(): TerminalPresentationMode {
  if (typeof window === "undefined") return "docked";
  const stored = window.localStorage.getItem(TERMINAL_PRESENTATION_STORAGE_KEY);
  return stored === "floating" || stored === "maximized" ? stored : "docked";
}

export function persistTerminalPresentationMode(mode: TerminalPresentationMode): void {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(TERMINAL_PRESENTATION_STORAGE_KEY, mode);
  }
}

/** Keep the complete floating terminal inside the visible workspace. */
export function clampTerminalBounds(
  bounds: TerminalFloatingBounds,
  workspace: TerminalWorkspaceSize,
): TerminalFloatingBounds {
  const width = Math.min(
    Math.max(MIN_TERMINAL_FLOATING_WIDTH, bounds.width),
    Math.max(1, workspace.width),
  );
  const height = Math.min(
    Math.max(MIN_TERMINAL_FLOATING_HEIGHT, bounds.height),
    Math.max(1, workspace.height),
  );
  return {
    x: Math.min(Math.max(0, bounds.x), Math.max(0, workspace.width - width)),
    y: Math.min(Math.max(0, bounds.y), Math.max(0, workspace.height - height)),
    width,
    height,
  };
}
