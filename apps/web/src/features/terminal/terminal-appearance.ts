/**
 * Terminal visual profiles (View → Terminal Appearance). The default is
 * "Appliance Console": a near-black console with neutral light-grey monospace
 * text and a blinking block cursor, echoing a real network-appliance console.
 * Fonts use a system stack only — no font asset is downloaded or committed. The
 * preference is local-only (localStorage) and never enters a LabDocument.
 */
export type TerminalAppearance = "appliance" | "modern-dark" | "light";

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export interface TerminalAppearanceProfile {
  id: TerminalAppearance;
  label: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontWeight: number;
  fontWeightBold: number;
  cursorStyle: "block";
  cursorBlink: boolean;
  scrollback: number;
  theme: TerminalTheme;
}

/** System monospace stack only — nothing is fetched or bundled. */
export const TERMINAL_FONT_STACK =
  '"DejaVu Sans Mono", "Liberation Mono", Consolas, "Courier New", monospace';

const DARK_ANSI = {
  black: "#2b303b", red: "#e06c75", green: "#8cc265", yellow: "#d5b06b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#c8d0da",
  brightBlack: "#5c6570", brightRed: "#e8909a", brightGreen: "#a6d68a", brightYellow: "#e6c88a",
  brightBlue: "#8fc7f5", brightMagenta: "#d7a3e8", brightCyan: "#82ccd6", brightWhite: "#f2f5f9",
};
const LIGHT_ANSI = {
  black: "#20262e", red: "#b1384a", green: "#3f7d34", yellow: "#9a6b16",
  blue: "#2f6ea8", magenta: "#8046a6", cyan: "#2a7d88", white: "#41505f",
  brightBlack: "#5c6a78", brightRed: "#c1495b", brightGreen: "#4a8f3e", brightYellow: "#a97b1f",
  brightBlue: "#3a7cb8", brightMagenta: "#8f55b5", brightCyan: "#358994", brightWhite: "#1c2430",
};

export const TERMINAL_APPEARANCE_PROFILES: Record<TerminalAppearance, TerminalAppearanceProfile> = {
  appliance: {
    id: "appliance", label: "Appliance Console", fontFamily: TERMINAL_FONT_STACK,
    fontSize: 16, lineHeight: 1.15, letterSpacing: 0, fontWeight: 400, fontWeightBold: 700,
    cursorStyle: "block", cursorBlink: true, scrollback: 8000,
    theme: { background: "#0b0e14", foreground: "#c8d0da", cursor: "#c8d0da", cursorAccent: "#0b0e14", selectionBackground: "#2d4a63", ...DARK_ANSI },
  },
  "modern-dark": {
    id: "modern-dark", label: "Modern Dark", fontFamily: TERMINAL_FONT_STACK,
    fontSize: 16, lineHeight: 1.2, letterSpacing: 0, fontWeight: 400, fontWeightBold: 700,
    cursorStyle: "block", cursorBlink: true, scrollback: 8000,
    theme: { background: "#11151c", foreground: "#d5dce6", cursor: "#61afef", cursorAccent: "#11151c", selectionBackground: "#2f4b66", ...DARK_ANSI },
  },
  light: {
    id: "light", label: "Light Console", fontFamily: TERMINAL_FONT_STACK,
    fontSize: 16, lineHeight: 1.2, letterSpacing: 0, fontWeight: 400, fontWeightBold: 700,
    cursorStyle: "block", cursorBlink: true, scrollback: 8000,
    theme: { background: "#f6f7f9", foreground: "#1c2430", cursor: "#2f6ea8", cursorAccent: "#f6f7f9", selectionBackground: "#bcd4ec", ...LIGHT_ANSI },
  },
};

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = "appliance";
export const TERMINAL_APPEARANCE_STORAGE_KEY = "simulatornet.terminalAppearance";

export function terminalAppearanceProfile(id: TerminalAppearance): TerminalAppearanceProfile {
  return TERMINAL_APPEARANCE_PROFILES[id] ?? TERMINAL_APPEARANCE_PROFILES[DEFAULT_TERMINAL_APPEARANCE];
}

export function getTerminalAppearance(): TerminalAppearance {
  try {
    const stored = globalThis.localStorage?.getItem(TERMINAL_APPEARANCE_STORAGE_KEY);
    if (stored === "appliance" || stored === "modern-dark" || stored === "light") return stored;
  } catch { /* storage unavailable */ }
  return DEFAULT_TERMINAL_APPEARANCE;
}

export function setTerminalAppearance(id: TerminalAppearance): void {
  try { globalThis.localStorage?.setItem(TERMINAL_APPEARANCE_STORAGE_KEY, id); } catch { /* storage unavailable */ }
}

/** Event open terminals listen for to re-apply the appearance live. */
export const TERMINAL_APPEARANCE_EVENT = "simulatornet:terminal-appearance";

/** Persist the choice and notify every open terminal to re-theme immediately. */
export function applyTerminalAppearance(id: TerminalAppearance): void {
  setTerminalAppearance(id);
  try { globalThis.dispatchEvent?.(new Event(TERMINAL_APPEARANCE_EVENT)); } catch { /* no window */ }
}
