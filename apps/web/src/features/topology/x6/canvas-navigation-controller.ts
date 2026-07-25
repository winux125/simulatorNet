import {
  CANVAS_TOOLBAR_ZOOM_FACTOR,
  classifyCanvasWheel,
  panViewport,
  resetViewportScale,
  scaleViewportBy,
  wheelZoomMultiplier,
  zoomViewportAtPoint,
  type CanvasViewport,
} from "../canvas-navigation";

// Browser wiring for canvas navigation. It owns exactly one viewport: there is
// no X6 Scroller, no inner scrollbars and no second panning system, so wheel
// input is handled once and world coordinates never change behind the graph.
//
// Listeners are bound to the canvas container only — never to `document` — so
// the terminal, import wizard, inspector and inline editors keep their own
// scrolling.

/** Minimal seam onto the graph transform so this module never imports X6. */
export interface CanvasViewportSurface {
  readonly container: HTMLElement;
  getViewport(): CanvasViewport;
  setViewport(viewport: CanvasViewport): void;
}

export interface CanvasNavigationHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  /** Re-publish the current viewport after an external change (fit, restore). */
  notify(): void;
  /** Apply any accumulated pan immediately; used by tests and teardown. */
  flushPan(): void;
  destroy(): void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .xterm, .terminal-session"));
}

export function attachCanvasNavigation(
  surface: CanvasViewportSurface,
  onViewportChanged: (viewport: CanvasViewport) => void,
): CanvasNavigationHandle {
  const container = surface.container;
  // UI-only accumulator: many wheel events per frame become one graph
  // translation. This is presentation smoothing and never enters sim-core.
  let pendingPanX = 0;
  let pendingPanY = 0;
  let frame = 0;
  let spaceHeld = false;
  let dragOrigin: { x: number; y: number } | undefined;

  const apply = (viewport: CanvasViewport) => {
    surface.setViewport(viewport);
    onViewportChanged(surface.getViewport());
  };

  const flushPan = () => {
    frame = 0;
    const deltaX = pendingPanX;
    const deltaY = pendingPanY;
    pendingPanX = 0;
    pendingPanY = 0;
    if (deltaX === 0 && deltaY === 0) return;
    apply(panViewport(surface.getViewport(), deltaX, deltaY));
  };

  const schedulePan = () => {
    if (frame !== 0) return;
    frame = typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(flushPan)
      : (window.setTimeout(flushPan, 16) as unknown as number);
  };

  const localPointer = (clientX: number, clientY: number) => {
    const bounds = container.getBoundingClientRect();
    return { x: clientX - bounds.left, y: clientY - bounds.top };
  };

  const center = () => ({ x: container.clientWidth / 2, y: container.clientHeight / 2 });

  const onWheel = (event: WheelEvent) => {
    const intent = classifyCanvasWheel({
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      clientX: event.clientX,
      clientY: event.clientY,
    });
    // The canvas owns wheel input over its own surface: the page never scrolls
    // and a pinch never becomes a browser page zoom.
    if (event.cancelable) event.preventDefault();
    if (intent.type === "ignore") return;
    if (intent.type === "pan") {
      pendingPanX += intent.deltaX;
      pendingPanY += intent.deltaY;
      schedulePan();
      return;
    }
    const pointer = localPointer(intent.clientX, intent.clientY);
    const viewport = surface.getViewport();
    apply(zoomViewportAtPoint(
      viewport,
      viewport.scale * wheelZoomMultiplier(intent.delta),
      pointer.x,
      pointer.y,
    ));
  };

  const stopDrag = () => {
    if (!dragOrigin) return;
    dragOrigin = undefined;
    container.classList.remove("is-canvas-panning");
    window.removeEventListener("mousemove", onDragMove, true);
    window.removeEventListener("mouseup", stopDrag, true);
  };

  function onDragMove(event: MouseEvent): void {
    if (!dragOrigin) return;
    pendingPanX -= event.clientX - dragOrigin.x;
    pendingPanY -= event.clientY - dragOrigin.y;
    dragOrigin = { x: event.clientX, y: event.clientY };
    schedulePan();
  }

  // Capture phase: X6 binds `mousedown` on this same container, so a middle or
  // Space drag must be stopped immediately — otherwise it would also start a
  // marquee selection or drag a node. Left-drag marquee semantics are untouched.
  const onMouseDownCapture = (event: MouseEvent) => {
    const middleButton = event.button === 1;
    const spaceDrag = event.button === 0 && spaceHeld;
    if (!middleButton && !spaceDrag) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    dragOrigin = { x: event.clientX, y: event.clientY };
    container.classList.add("is-canvas-panning");
    window.addEventListener("mousemove", onDragMove, true);
    window.addEventListener("mouseup", stopDrag, true);
  };

  const panelOwnsFocus = (): boolean => {
    const active = document.activeElement;
    if (!active || active === document.body) return true;
    const panel = container.closest(".topology-panel") ?? container;
    return panel.contains(active);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== "Space" || event.repeat) return;
    if (isTypingTarget(event.target) || !panelOwnsFocus()) return;
    spaceHeld = true;
    container.classList.add("is-canvas-pannable");
    event.preventDefault();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== "Space") return;
    spaceHeld = false;
    container.classList.remove("is-canvas-pannable");
    stopDrag();
  };

  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("mousedown", onMouseDownCapture, true);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onKeyUp as unknown as EventListener);

  return {
    zoomIn() {
      const point = center();
      apply(scaleViewportBy(surface.getViewport(), CANVAS_TOOLBAR_ZOOM_FACTOR, point.x, point.y));
    },
    zoomOut() {
      const point = center();
      apply(scaleViewportBy(surface.getViewport(), 1 / CANVAS_TOOLBAR_ZOOM_FACTOR, point.x, point.y));
    },
    resetZoom() {
      const point = center();
      apply(resetViewportScale(surface.getViewport(), point.x, point.y));
    },
    notify() {
      onViewportChanged(surface.getViewport());
    },
    flushPan,
    destroy() {
      stopDrag();
      if (frame !== 0) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        else window.clearTimeout(frame);
        frame = 0;
      }
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("mousedown", onMouseDownCapture, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onKeyUp as unknown as EventListener);
      container.classList.remove("is-canvas-pannable", "is-canvas-panning");
    },
  };
}
