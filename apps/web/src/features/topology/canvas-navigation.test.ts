// @vitest-environment jsdom

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_MAX_SCALE,
  CANVAS_MIN_SCALE,
  CANVAS_TOOLBAR_ZOOM_FACTOR,
  CANVAS_WHEEL_ZOOM_FACTOR,
  canZoomIn,
  canZoomOut,
  classifyCanvasWheel,
  clampCanvasScale,
  DOM_DELTA_LINE,
  DOM_DELTA_PAGE,
  DOM_DELTA_PIXEL,
  formatZoomPercent,
  MAX_WHEEL_PAN_DELTA,
  MAX_WHEEL_ZOOM_DELTA,
  normalizeWheelDelta,
  panViewport,
  scaleViewportBy,
  wheelZoomMultiplier,
  zoomViewportAtPoint,
  type CanvasViewport,
  type CanvasWheelInput,
} from "./canvas-navigation";
import { attachCanvasNavigation } from "./x6/canvas-navigation-controller";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, "../../"); // apps/web/src

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function productSources(): string[] {
  return walk(webSrc)
    .filter((file) => /\.(ts|tsx|css)$/.test(file))
    .filter((file) => !/\.test\.(ts|tsx)$/.test(file));
}

function read(relative: string): string {
  return readFileSync(join(here, relative), "utf8");
}

/** Assertions about what the code *does* must not trip over what it documents. */
function code(relative: string): string {
  return read(relative).replaceAll(/\/\*[\s\S]*?\*\/|(^|\s)\/\/.*$/gm, "$1");
}

function wheel(overrides: Partial<CanvasWheelInput> = {}): CanvasWheelInput {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: DOM_DELTA_PIXEL,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    clientX: 400,
    clientY: 300,
    ...overrides,
  };
}

interface Harness {
  container: HTMLElement;
  child: HTMLElement;
  viewport: CanvasViewport;
  handle: ReturnType<typeof attachCanvasNavigation>;
  changes: CanvasViewport[];
  wheel(init: WheelEventInit): boolean;
}

const harnesses: Harness[] = [];

function createHarness(size = { width: 800, height: 600 }): Harness {
  const container = document.createElement("div");
  const child = document.createElement("div");
  container.append(child);
  document.body.append(container);
  Object.defineProperty(container, "clientWidth", { value: size.width, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: size.height, configurable: true });
  container.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: size.width, bottom: size.height,
    width: size.width, height: size.height, toJSON: () => ({}),
  }) as DOMRect;

  const state: { viewport: CanvasViewport } = { viewport: { scale: 1, translateX: 0, translateY: 0 } };
  const changes: CanvasViewport[] = [];
  const handle = attachCanvasNavigation({
    container,
    getViewport: () => state.viewport,
    setViewport: (next) => { state.viewport = next; },
  }, (next) => changes.push(next));

  const harness: Harness = {
    container,
    child,
    get viewport() { return state.viewport; },
    handle,
    changes,
    wheel(init) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      const notPrevented = child.dispatchEvent(event);
      handle.flushPan();
      return notPrevented;
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.handle.destroy();
    harness.container.remove();
  }
});

describe("M10.3.3a trackpad wheel classifier", () => {
  it("1. treats a two-finger vertical delta as a vertical pan", () => {
    expect(classifyCanvasWheel(wheel({ deltaY: 42 }))).toEqual({ type: "pan", deltaX: 0, deltaY: 42 });
  });

  it("2. treats a two-finger horizontal delta as a horizontal pan", () => {
    expect(classifyCanvasWheel(wheel({ deltaX: -37 }))).toEqual({ type: "pan", deltaX: -37, deltaY: 0 });
  });

  it("3. pans on both axes for a diagonal gesture", () => {
    expect(classifyCanvasWheel(wheel({ deltaX: 18, deltaY: -24 })))
      .toEqual({ type: "pan", deltaX: 18, deltaY: -24 });
  });

  it("4. never zooms on a plain wheel without Ctrl or Command", () => {
    for (const delta of [1, 40, 120, -260]) {
      expect(classifyCanvasWheel(wheel({ deltaY: delta })).type).toBe("pan");
    }
  });

  it("5. zooms on Ctrl+wheel (including browser trackpad pinch)", () => {
    const intent = classifyCanvasWheel(wheel({ deltaY: -60, ctrlKey: true, clientX: 512, clientY: 288 }));
    expect(intent).toEqual({ type: "zoom", delta: -60, clientX: 512, clientY: 288 });
  });

  it("6. zooms on Meta+wheel for macOS-style modifier zoom", () => {
    expect(classifyCanvasWheel(wheel({ deltaY: 25, metaKey: true })).type).toBe("zoom");
  });

  it("7. converts Shift+mousewheel into horizontal panning", () => {
    expect(classifyCanvasWheel(wheel({ deltaY: 100, shiftKey: true })))
      .toEqual({ type: "pan", deltaX: 100, deltaY: 0 });
  });

  it("8. keeps a device-reported horizontal delta even when Shift is held", () => {
    expect(classifyCanvasWheel(wheel({ deltaX: 12, deltaY: 9, shiftKey: true })))
      .toEqual({ type: "pan", deltaX: 12, deltaY: 9 });
  });

  it("9. ignores an empty wheel event instead of guessing", () => {
    expect(classifyCanvasWheel(wheel()).type).toBe("ignore");
    expect(classifyCanvasWheel(wheel({ ctrlKey: true })).type).toBe("ignore");
  });

  it("10. normalizes line and page delta modes into pixel-like deltas", () => {
    expect(normalizeWheelDelta(3, DOM_DELTA_LINE, MAX_WHEEL_PAN_DELTA)).toBe(48);
    expect(normalizeWheelDelta(1, DOM_DELTA_PAGE, MAX_WHEEL_PAN_DELTA)).toBe(240);
    expect(normalizeWheelDelta(7.5, DOM_DELTA_PIXEL, MAX_WHEEL_PAN_DELTA)).toBe(7.5);
  });

  it("11. keeps tiny trackpad deltas effective", () => {
    expect(classifyCanvasWheel(wheel({ deltaY: 0.5 }))).toEqual({ type: "pan", deltaX: 0, deltaY: 0.5 });
    const multiplier = wheelZoomMultiplier(-1);
    expect(multiplier).toBeGreaterThan(1);
    expect(multiplier).toBeLessThan(1.001);
  });

  it("12. bounds an extreme single-event delta", () => {
    expect(classifyCanvasWheel(wheel({ deltaX: 9_000, deltaY: -9_000 })))
      .toEqual({ type: "pan", deltaX: MAX_WHEEL_PAN_DELTA, deltaY: -MAX_WHEEL_PAN_DELTA });
    const intent = classifyCanvasWheel(wheel({ deltaY: 40_000, ctrlKey: true }));
    expect(intent).toMatchObject({ type: "zoom", delta: MAX_WHEEL_ZOOM_DELTA });
    expect(wheelZoomMultiplier(1e9)).toBeGreaterThan(0.9);
  });

  it("13. uses a gentler zoom factor than the previous 1.2 wheel step", () => {
    expect(CANVAS_WHEEL_ZOOM_FACTOR).toBeCloseTo(1.05, 5);
    expect(CANVAS_WHEEL_ZOOM_FACTOR).toBeLessThan(1.2);
    // A full 100px notch is exactly the documented gentle factor.
    expect(wheelZoomMultiplier(-100)).toBeCloseTo(CANVAS_WHEEL_ZOOM_FACTOR, 6);
    expect(wheelZoomMultiplier(100)).toBeCloseTo(1 / CANVAS_WHEEL_ZOOM_FACTOR, 6);
  });
});

describe("M10.3.3a viewport math", () => {
  it("14. keeps the world point under the pointer while zooming", () => {
    const viewport: CanvasViewport = { scale: 0.8, translateX: -140, translateY: 65 };
    const pointer = { x: 517, y: 231 };
    const world = {
      x: (pointer.x - viewport.translateX) / viewport.scale,
      y: (pointer.y - viewport.translateY) / viewport.scale,
    };
    for (const factor of [1.05, 1 / 1.05, 2.4, 0.4]) {
      const next = zoomViewportAtPoint(viewport, viewport.scale * factor, pointer.x, pointer.y);
      expect(world.x * next.scale + next.translateX).toBeCloseTo(pointer.x, 9);
      expect(world.y * next.scale + next.translateY).toBeCloseTo(pointer.y, 9);
    }
  });

  it("15. enforces the minimum zoom", () => {
    expect(clampCanvasScale(0.0001)).toBe(CANVAS_MIN_SCALE);
    expect(zoomViewportAtPoint({ scale: 0.21, translateX: 0, translateY: 0 }, 0.05, 10, 10).scale)
      .toBe(CANVAS_MIN_SCALE);
    expect(canZoomOut(CANVAS_MIN_SCALE)).toBe(false);
  });

  it("16. enforces the maximum zoom", () => {
    expect(clampCanvasScale(99)).toBe(CANVAS_MAX_SCALE);
    expect(scaleViewportBy({ scale: 2.95, translateX: 0, translateY: 0 }, 4, 0, 0).scale)
      .toBe(CANVAS_MAX_SCALE);
    expect(canZoomIn(CANVAS_MAX_SCALE)).toBe(false);
  });

  it("17. never produces a zero, negative, flipped or NaN scale", () => {
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const scale = clampCanvasScale(value);
      expect(Number.isFinite(scale)).toBe(true);
      expect(scale).toBeGreaterThan(0);
    }
    const recovered = zoomViewportAtPoint({ scale: Number.NaN, translateX: Number.NaN, translateY: 4 }, 1, 5, 5);
    expect(Number.isFinite(recovered.translateX)).toBe(true);
    expect(Number.isFinite(recovered.translateY)).toBe(true);
  });

  it("18. pans without changing scale and reports a readable percentage", () => {
    const panned = panViewport({ scale: 1.5, translateX: 20, translateY: -10 }, 30, -12);
    expect(panned).toEqual({ scale: 1.5, translateX: -10, translateY: 2 });
    expect(formatZoomPercent(0.85)).toBe("85%");
    expect(formatZoomPercent(1)).toBe("100%");
  });
});

describe("M10.3.3a navigation controller", () => {
  it("19. pans vertically, horizontally and diagonally from wheel gestures", () => {
    const harness = createHarness();
    harness.wheel({ deltaY: 60 });
    expect(harness.viewport).toMatchObject({ scale: 1, translateX: 0, translateY: -60 });
    harness.wheel({ deltaX: 45 });
    expect(harness.viewport).toMatchObject({ translateX: -45, translateY: -60 });
    harness.wheel({ deltaX: -15, deltaY: -20 });
    expect(harness.viewport).toMatchObject({ translateX: -30, translateY: -40 });
    expect(harness.viewport.scale).toBe(1);
  });

  it("20. batches many wheel events into one frame-applied translation", () => {
    const harness = createHarness();
    for (const _ of [1, 2, 3, 4, 5]) {
      harness.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 10, cancelable: true, bubbles: true }));
    }
    expect(harness.viewport.translateY).toBe(0); // nothing applied synchronously
    harness.handle.flushPan();
    expect(harness.viewport.translateY).toBe(-50);
    expect(harness.changes).toHaveLength(1);
  });

  it("21. prevents page scroll and browser page zoom over the canvas", () => {
    const harness = createHarness();
    expect(harness.wheel({ deltaY: 80 })).toBe(false);
    expect(harness.wheel({ deltaY: -80, ctrlKey: true })).toBe(false);
    expect(harness.wheel({ deltaY: 0 })).toBe(false);
  });

  it("22. zooms gently around the pointer on Ctrl+wheel", () => {
    const harness = createHarness();
    const world = { x: 300, y: 200 };
    harness.wheel({ deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
    expect(harness.viewport.scale).toBeCloseTo(CANVAS_WHEEL_ZOOM_FACTOR, 6);
    expect(world.x * harness.viewport.scale + harness.viewport.translateX).toBeCloseTo(300, 6);
    expect(world.y * harness.viewport.scale + harness.viewport.translateY).toBeCloseTo(200, 6);
  });

  it("23. increments toolbar zoom by ~10% around the canvas center", () => {
    const harness = createHarness();
    harness.handle.zoomIn();
    expect(harness.viewport.scale).toBeCloseTo(CANVAS_TOOLBAR_ZOOM_FACTOR, 6);
    harness.handle.zoomOut();
    expect(harness.viewport.scale).toBeCloseTo(1, 6);
    for (const _ of Array.from({ length: 40 })) harness.handle.zoomIn();
    expect(harness.viewport.scale).toBe(CANVAS_MAX_SCALE);
    for (const _ of Array.from({ length: 60 })) harness.handle.zoomOut();
    expect(harness.viewport.scale).toBe(CANVAS_MIN_SCALE);
  });

  it("24. returns to exactly 100% on Reset Zoom without fitting", () => {
    const harness = createHarness();
    harness.wheel({ deltaY: -100, ctrlKey: true, clientX: 120, clientY: 90 });
    harness.wheel({ deltaX: 40, deltaY: 30 });
    harness.handle.resetZoom();
    expect(harness.viewport.scale).toBe(1);
    expect(formatZoomPercent(harness.viewport.scale)).toBe("100%");
  });

  it("25. pans with a middle-mouse drag and with Space + left drag", () => {
    const harness = createHarness();
    const x6MouseDown = vi.fn();
    harness.container.addEventListener("mousedown", x6MouseDown);

    harness.child.dispatchEvent(new MouseEvent("mousedown", { button: 1, clientX: 100, clientY: 100, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 130, clientY: 145, bubbles: true }));
    harness.handle.flushPan();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(harness.viewport).toMatchObject({ translateX: 30, translateY: 45 });
    expect(x6MouseDown).not.toHaveBeenCalled();

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    harness.child.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 200, clientY: 200, bubbles: true, cancelable: true }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 180, clientY: 190, bubbles: true }));
    harness.handle.flushPan();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true }));
    expect(harness.viewport).toMatchObject({ translateX: 10, translateY: 35 });
    expect(x6MouseDown).not.toHaveBeenCalled();
  });

  it("26. leaves a plain left-press for the existing Select/Marquee semantics", () => {
    const harness = createHarness();
    const x6MouseDown = vi.fn();
    harness.container.addEventListener("mousedown", x6MouseDown);
    harness.child.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 40, clientY: 40, bubbles: true, cancelable: true }));
    expect(x6MouseDown).toHaveBeenCalledTimes(1);
    expect(harness.viewport).toMatchObject({ scale: 1, translateX: 0, translateY: 0 });
  });

  it("27. never handles a wheel event outside the canvas container", () => {
    const harness = createHarness();
    // Terminal, import wizard, inspector and the inline text editor all live
    // outside the graph container and keep their own scrolling.
    const elsewhere = document.createElement("div");
    document.body.append(elsewhere);
    const event = new WheelEvent("wheel", { deltaY: 300, bubbles: true, cancelable: true });
    const notPrevented = elsewhere.dispatchEvent(event);
    harness.handle.flushPan();
    expect(notPrevented).toBe(true);
    expect(harness.viewport).toMatchObject({ scale: 1, translateX: 0, translateY: 0 });
    elsewhere.remove();
  });

  it("28. removes every listener and pending frame on destroy", () => {
    const harness = createHarness();
    harness.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 50, cancelable: true, bubbles: true }));
    harness.handle.destroy();
    const before = { ...harness.viewport };
    const event = new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true });
    expect(harness.child.dispatchEvent(event)).toBe(true);
    expect(harness.viewport).toEqual(before);
    expect(harness.container.className).toBe("");
  });
});

describe("M10.3.3a canvas ownership guarantees", () => {
  it("29. keeps Fit Topology separate from Reset Zoom", () => {
    const controller = read("x6/graph-controller.ts");
    const resetZoom = controller.match(/resetZoom\(\) \{([\s\S]*?)\n {4}\},/)?.[1] ?? "";
    expect(resetZoom).toContain("navigation.resetZoom()");
    expect(resetZoom).not.toMatch(/zoomToFit|fitToContent/);
    expect(controller).toContain("graph.zoomToFit({ padding: 24, maxScale: 1.4 })");
  });

  it("30. resizes without touching the viewport, so panels and resizes stay stable", () => {
    const controller = read("x6/graph-controller.ts");
    const resize = controller.match(/resize\(width, height\) \{([\s\S]*?)\n {4}\},\n {4}reanchorLinks/)?.[1] ?? "";
    expect(resize).toContain("graph.resize(width, height)");
    expect(resize).toContain("scheduleAdaptiveRefresh()");
    expect(resize).not.toMatch(/zoomToFit|zoomTo\(|centerContent|translate|scale\(/);
  });

  it("31. never registers a document-level wheel listener", () => {
    const offenders = productSources().filter((file) => {
      const source = readFileSync(file, "utf8");
      return /document\.addEventListener\(\s*["'`]wheel|window\.addEventListener\(\s*["'`]wheel/.test(source);
    });
    expect(offenders).toEqual([]);
    expect(read("x6/canvas-navigation-controller.ts"))
      .toContain('container.addEventListener("wheel", onWheel, { passive: false })');
  });

  it("32. runs a single viewport: no X6 Scroller and no duplicated wheel panning", () => {
    const graph = code("x6/create-graph.ts");
    expect(graph).not.toMatch(/Scroller|scroller/);
    expect(graph).not.toMatch(/mousewheel\s*:/);
    expect(graph).toContain('panning: { enabled: false, eventTypes: ["leftMouseDown"] }');
    expect(graph).toContain("scaling: { min: CANVAS_MIN_SCALE, max: CANVAS_MAX_SCALE }");
    const offenders = productSources().filter((file) => /@antv\/x6-plugin-scroller/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("33. gives the topology canvas no scrollbar of its own", () => {
    const css = readFileSync(join(webSrc, "styles/app.css"), "utf8");
    const rule = css.match(/\.topology-panel \.topology-graph \{[^}]*overflow[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("overflow: hidden");
    expect(rule).toContain("overscroll-behavior: contain");
    expect(css).not.toMatch(/\.topology-graph[^{]*\{[^}]*overflow:\s*(auto|scroll)/);
  });

  it("34. treats navigation as local state: no document mutation and no rebuild", () => {
    const navigation = `${code("canvas-navigation.ts")}\n${code("x6/canvas-navigation-controller.ts")}`;
    expect(navigation).not.toMatch(/LabDocument|applyDraft|onChange|REBUILD_LAB|structural|grading|Date\.now|Math\.random/);
    const store = readFileSync(join(webSrc, "state/workspace-store.ts"), "utf8");
    expect(store).toContain("setViewport: (viewport) =>");
    // The viewport is workspace state; it must never reach a serialized lab.
    const labFormat = readFileSync(join(webSrc, "features/lab/document.ts"), "utf8");
    expect(labFormat).not.toMatch(/translateX|viewport/i);
  });

  it("35. keeps drawing and cable gestures untouched by the navigation layer", () => {
    const navigation = code("x6/canvas-navigation-controller.ts");
    expect(navigation).not.toMatch(/annotation|marquee|cable|dragStart/i);
    // Only middle-button and Space drags are intercepted before X6 sees them.
    expect(navigation).toContain("const spaceDrag = event.button === 0 && spaceHeld;");
    expect(navigation).toContain("if (!middleButton && !spaceDrag) return;");
  });
});
