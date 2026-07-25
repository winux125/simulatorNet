// Centralized canvas navigation model for the topology viewport.
//
// Everything here is pure: wheel classification, delta normalization, scale
// bounds and viewport math. The DOM/X6 wiring lives in
// `x6/canvas-navigation-controller.ts`, so trackpad heuristics are never
// re-derived inside React components and stay unit-testable in Node.
//
// This is presentation-only local workspace state. It never touches sim-core,
// the deterministic clock, the LabDocument or grading.

/** Graph transform as X6 applies it: screen = world * scale + translate. */
export interface CanvasViewport {
  scale: number;
  translateX: number;
  translateY: number;
}

export type CanvasWheelIntent =
  | { type: "pan"; deltaX: number; deltaY: number }
  | { type: "zoom"; delta: number; clientX: number; clientY: number }
  | { type: "ignore" };

/** The subset of `WheelEvent` the classifier needs (plain data, no DOM). */
export interface CanvasWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  clientX: number;
  clientY: number;
}

export const CANVAS_MIN_SCALE = 0.2;
export const CANVAS_MAX_SCALE = 3;
export const CANVAS_DEFAULT_SCALE = 1;

/**
 * Gentle continuous zoom. A full 100px wheel notch is exactly this factor;
 * a small trackpad pinch delta produces a proportionally smaller change
 * instead of a whole step. The previous X6 `mousewheel` default was 1.2.
 */
export const CANVAS_WHEEL_ZOOM_FACTOR = 1.05;
/** Discrete toolbar Zoom In / Zoom Out step (~10%) around the canvas center. */
export const CANVAS_TOOLBAR_ZOOM_FACTOR = 1.1;
/** exp() sensitivity chosen so 100px == CANVAS_WHEEL_ZOOM_FACTOR exactly. */
export const CANVAS_ZOOM_SENSITIVITY = Math.log(CANVAS_WHEEL_ZOOM_FACTOR) / 100;

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

const DELTA_LINE_PIXELS = 16;
const DELTA_PAGE_PIXELS = 400;

/**
 * A single event may never move or scale more than this. Cheap mice and some
 * drivers report enormous per-event deltas; small trackpad deltas are kept
 * verbatim so continuous gestures stay smooth.
 */
export const MAX_WHEEL_PAN_DELTA = 240;
export const MAX_WHEEL_ZOOM_DELTA = 120;

export const IDENTITY_CANVAS_VIEWPORT: CanvasViewport = {
  scale: CANVAS_DEFAULT_SCALE,
  translateX: 0,
  translateY: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Convert a wheel delta of any `deltaMode` into a bounded pixel-like delta. */
export function normalizeWheelDelta(delta: number, deltaMode: number, limit: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const pixels = deltaMode === DOM_DELTA_LINE
    ? delta * DELTA_LINE_PIXELS
    : deltaMode === DOM_DELTA_PAGE
      ? delta * DELTA_PAGE_PIXELS
      : delta;
  return clamp(pixels, -limit, limit);
}

/**
 * Classify one wheel event over the canvas.
 *
 * - `ctrlKey`/`metaKey` means zoom. Browsers report a trackpad pinch as a
 *   `ctrlKey` wheel event, so pinch and explicit modifier zoom share one path.
 * - anything else is free two-dimensional panning, using both axes so a
 *   diagonal two-finger gesture moves the canvas diagonally.
 * - a classic mouse wheel reports no horizontal delta; `Shift` turns its
 *   vertical delta into horizontal panning.
 */
export function classifyCanvasWheel(event: CanvasWheelInput): CanvasWheelIntent {
  if (event.ctrlKey || event.metaKey) {
    const source = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    const delta = normalizeWheelDelta(source, event.deltaMode, MAX_WHEEL_ZOOM_DELTA);
    if (delta === 0) return { type: "ignore" };
    return { type: "zoom", delta, clientX: event.clientX, clientY: event.clientY };
  }
  let deltaX = normalizeWheelDelta(event.deltaX, event.deltaMode, MAX_WHEEL_PAN_DELTA);
  let deltaY = normalizeWheelDelta(event.deltaY, event.deltaMode, MAX_WHEEL_PAN_DELTA);
  if (deltaX === 0 && event.shiftKey && deltaY !== 0) {
    deltaX = deltaY;
    deltaY = 0;
  }
  if (deltaX === 0 && deltaY === 0) return { type: "ignore" };
  return { type: "pan", deltaX, deltaY };
}

/** Keep the scale finite, positive and inside the single central zoom range. */
export function clampCanvasScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return CANVAS_MIN_SCALE;
  return clamp(scale, CANVAS_MIN_SCALE, CANVAS_MAX_SCALE);
}

/** Continuous, bounded exponential mapping from a wheel delta to a scale factor. */
export function wheelZoomMultiplier(delta: number): number {
  const bounded = clamp(Number.isFinite(delta) ? delta : 0, -MAX_WHEEL_ZOOM_DELTA, MAX_WHEEL_ZOOM_DELTA);
  return Math.exp(-bounded * CANVAS_ZOOM_SENSITIVITY);
}

export function normalizeCanvasViewport(viewport: CanvasViewport): CanvasViewport {
  return {
    scale: clampCanvasScale(viewport.scale),
    translateX: Number.isFinite(viewport.translateX) ? viewport.translateX : 0,
    translateY: Number.isFinite(viewport.translateY) ? viewport.translateY : 0,
  };
}

/**
 * Scale to `nextScale` while keeping the world coordinate currently under
 * (`pointerX`, `pointerY`) — container-relative pixels — under it afterwards,
 * so a pinch never makes the diagram jump away from the pointer.
 */
export function zoomViewportAtPoint(
  viewport: CanvasViewport,
  nextScale: number,
  pointerX: number,
  pointerY: number,
): CanvasViewport {
  const current = normalizeCanvasViewport(viewport);
  const scale = clampCanvasScale(nextScale);
  const worldX = (pointerX - current.translateX) / current.scale;
  const worldY = (pointerY - current.translateY) / current.scale;
  return {
    scale,
    translateX: pointerX - worldX * scale,
    translateY: pointerY - worldY * scale,
  };
}

/** Multiply the current scale, anchored at a point (toolbar uses the center). */
export function scaleViewportBy(
  viewport: CanvasViewport,
  factor: number,
  pointerX: number,
  pointerY: number,
): CanvasViewport {
  const current = normalizeCanvasViewport(viewport);
  return zoomViewportAtPoint(current, current.scale * factor, pointerX, pointerY);
}

/** Reset to 100% around a point. Deliberately not a fit — Fit stays separate. */
export function resetViewportScale(
  viewport: CanvasViewport,
  pointerX: number,
  pointerY: number,
): CanvasViewport {
  return zoomViewportAtPoint(viewport, CANVAS_DEFAULT_SCALE, pointerX, pointerY);
}

/** Translate the viewport by a pan delta; scrolling down moves content up. */
export function panViewport(viewport: CanvasViewport, deltaX: number, deltaY: number): CanvasViewport {
  const current = normalizeCanvasViewport(viewport);
  return {
    scale: current.scale,
    translateX: current.translateX - (Number.isFinite(deltaX) ? deltaX : 0),
    translateY: current.translateY - (Number.isFinite(deltaY) ? deltaY : 0),
  };
}

export function canZoomIn(scale: number): boolean {
  return clampCanvasScale(scale) < CANVAS_MAX_SCALE - 1e-6;
}

export function canZoomOut(scale: number): boolean {
  return clampCanvasScale(scale) > CANVAS_MIN_SCALE + 1e-6;
}

export function formatZoomPercent(scale: number): string {
  return `${Math.round(clampCanvasScale(scale) * 100)}%`;
}

export function isSameCanvasViewport(a: CanvasViewport, b: CanvasViewport): boolean {
  return Math.abs(a.scale - b.scale) < 1e-6
    && Math.abs(a.translateX - b.translateX) < 1e-3
    && Math.abs(a.translateY - b.translateY) < 1e-3;
}
