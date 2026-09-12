// @vitest-environment jsdom

/**
 * M10.17.6 — UI density and visual hierarchy.
 *
 * These are structural invariants, not a snapshot of every CSS declaration:
 * each one names a permanent row, a duplicated control or a second scroll
 * container that this milestone removed, so a later change that quietly brings
 * one back fails here instead of in a screenshot review.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(webSrc).filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file));
const read = (relative: string) => readFileSync(join(webSrc, relative), "utf8");
const appCss = read("styles/app.css");
const tokensCss = read("styles/tokens.css");

/** `--name: value;` from tokens.css. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(tokensCss);
  expect(match, `token --${name} is defined`).not.toBeNull();
  return match![1]!.trim();
}

describe("M10.17.6 spacing and control tokens", () => {
  it("1. defines one compact spacing scale and desktop control sizes", () => {
    expect(token("space-0")).toBe("2px");
    expect(token("space-1")).toBe("4px");
    expect(token("space-1-5")).toBe("6px");
    expect(token("space-2")).toBe("8px");
    expect(token("space-3")).toBe("12px");
    expect(token("space-4")).toBe("16px");
    for (const name of ["control-height", "control-height-sm", "input-height", "icon-button-size", "panel-padding", "section-gap"]) {
      expect(token(name)).toMatch(/^\d+px$/);
    }
  });

  it("2. keeps desktop controls in the compact 24-32px band", () => {
    for (const name of ["control-height", "control-height-sm", "input-height", "icon-button-size"]) {
      const height = Number.parseInt(token(name), 10);
      expect(height, `--${name} is a desktop control, not a touch target`).toBeGreaterThanOrEqual(22);
      expect(height, `--${name} is a desktop control, not a touch target`).toBeLessThanOrEqual(32);
    }
  });

  it("3. keeps the top chrome and the status bar within one compact band", () => {
    const menuBar = Number.parseInt(token("menu-bar-height"), 10);
    const toolbar = Number.parseInt(token("action-toolbar-height"), 10);
    const footer = Number.parseInt(token("footer-height"), 10);
    expect(menuBar + toolbar, "menu row plus action toolbar").toBeLessThanOrEqual(64);
    expect(footer).toBeLessThanOrEqual(24);
  });
});

describe("M10.17.6 no duplicated permanent controls", () => {
  it("4. shows the bottom-panel counts in the status bar only while the panel is hidden", () => {
    // A minimized panel already renders the same counts on its tab strip.
    const app = read("app/App.tsx");
    expect(app).toContain('workspace.bottomPanelState === "hidden" && <BottomPanelStatus');
    expect(app).not.toContain("!bottomPanelExpanded && <BottomPanelStatus");
  });

  it("5. carries no decorative schema caption in the status bar", () => {
    expect(read("app/App.tsx")).not.toMatch(/deterministic runtime<\/span>/);
  });

  it("6. offers exactly one cable tool in the connection palette", () => {
    const palette = read("components/DevicePalette.tsx");
    expect([...palette.matchAll(/selectTool\("add-link"\)/g)]).toHaveLength(1);
    expect(palette).not.toMatch(/label="Ethernet Link"/);
  });

  it("7. keeps one close control per terminal tab and none duplicated in the window chrome", () => {
    const presentation = read("features/terminal/TerminalPresentation.tsx");
    expect(presentation).not.toContain("Close active terminal tab");
    expect(presentation).toContain("Close terminal window");
    expect(read("features/terminal/TerminalPanel.tsx")).toContain("terminal-tab-close");
  });

  it("8. renders no dialog eyebrow above a title that already names the dialog", () => {
    const app = read("app/App.tsx");
    expect(app).not.toMatch(/\seyebrow="/);
    expect(app).not.toMatch(/<p>\{eyebrow\}<\/p>/);
  });
});

describe("M10.17.6 bottom dock and terminal are one IDE panel", () => {
  it("9. gives the docked terminal no titlebar of its own", () => {
    expect(appCss).toContain(".terminal-presentation--docked > .terminal-presentation__titlebar { display: none; }");
    expect(read("features/terminal/TerminalPresentation.tsx")).toContain("windowActions={docked ? windowActions : undefined}");
  });

  it("10. shares one row between the terminal tabs and the session actions", () => {
    // The sessions layer spans both grid rows, so the action group lands in the
    // tab row rather than costing a row of its own.
    expect(appCss).toMatch(/\.terminal-sessions \{[^}]*grid-row: 1 \/ -1;[^}]*grid-column: 1;/);
    expect(appCss).toMatch(/\.terminal-tabs \{[^}]*grid-row: 1;[^}]*grid-column: 1;/);
    expect(appCss).toMatch(/\.terminal-session__actions \{[^}]*width: fit-content;/);
  });

  it("11. drops the decorative terminal tab metadata caption", () => {
    expect(sourceFiles.some((file) => readFileSync(file, "utf8").includes("terminal-tabs__meta"))).toBe(false);
    expect(sourceFiles.some((file) => readFileSync(file, "utf8").includes("isolated session"))).toBe(false);
  });

  it("12. keeps Packet Trace to a single contextual toolbar above its table", () => {
    // The protocol filter used to be a second sticky row inside the table wrap.
    expect(sourceFiles.filter((file) => readFileSync(file, "utf8").includes("trace-filter"))).toEqual([]);
    const dock = read("features/dock/BottomDock.tsx");
    expect(dock).toContain('aria-label="Packet trace protocol filter"');
    expect(dock).toContain('aria-label="Packet execution controls"');
    // Neither the "events run automatically" gloss on Auto nor a second copy of
    // the status bar's virtual-time readout.
    expect(dock).not.toContain("Events are processed automatically");
    expect(dock).not.toContain("Virtual time:");
  });
});

describe("M10.17.6 layout has one scroll owner", () => {
  it("13. never makes the document itself the workspace scroll container", () => {
    expect(read("styles/reset.css")).toMatch(/body \{[^}]*overflow: hidden;/);
    expect(appCss).toMatch(/\.app-shell \{[^}]*overflow: hidden;/);
  });

  it("14. gives the import wizard exactly one scrolling region", () => {
    const scrollingImportRules = [...appCss.matchAll(/\.import-wizard(__[a-z-]+)?\s*\{[^}]*overflow: auto[^}]*\}/g)];
    expect(scrollingImportRules.map((match) => match[0].split("{")[0]!.trim())).toEqual([".import-wizard__body"]);
  });

  it("15. keeps the canvas free of a second panning or scrolling system", () => {
    expect(appCss).toMatch(/\.topology-panel \.topology-graph \{[^}]*overflow: hidden;/);
    expect(sourceFiles.some((file) => /x6-scroller|Scroller\(/i.test(readFileSync(file, "utf8")))).toBe(false);
  });
});

describe("M10.17.6 no landing-page chrome in a utility console", () => {
  it("16. opens on a compact start panel rather than a branded hero", () => {
    const canvas = read("features/topology/TopologyCanvas.tsx");
    expect(canvas).toContain("<h1>No laboratory open</h1>");
    // The application is already named in the menu bar.
    expect(canvas).not.toContain("<h1>SimulatorNet</h1>");
    expect(appCss).toMatch(/\.welcome-workspace h1 \{[^}]*font-size: var\(--font-size-13\);/);
  });

  it("17. adds no gradient, glassmorphism or oversized shadow", () => {
    const css = `${appCss}\n${tokensCss}`;
    expect(css).not.toMatch(/linear-gradient|radial-gradient\(.*rgba|backdrop-filter/);
    for (const [, blur] of css.matchAll(/box-shadow:[^;]*?(\d{3,})px/g)) {
      expect(Number(blur), "no oversized shadow").toBeLessThan(100);
    }
  });

  it("18. keeps one moderate radius scale instead of pill-shaped blocks", () => {
    for (const name of ["radius-sm", "radius-md", "radius-lg"]) {
      expect(Number.parseInt(token(name), 10)).toBeLessThanOrEqual(8);
    }
    // A round dot and a 999px status pill are different things: only the first
    // should survive, so no layout block is fully pill-shaped.
    const pills = [...appCss.matchAll(/border-radius: 999px/g)];
    expect(pills.length).toBeLessThanOrEqual(1);
  });
});
