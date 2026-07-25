# Canvas navigation

The topology canvas behaves like a modern diagram tool. It owns a single
viewport — one graph translation and one graph scale — with no inner
scrollbars, no X6 Scroller and no second panning system. Navigation is local
workspace state: it never changes `LabDocument`, the worker runtime, or grading.

## Trackpad

| Gesture | Result |
| --- | --- |
| Two-finger movement | Moves the canvas freely on X and Y, including diagonally |
| Pinch | Smoothly zooms around the pointer |

Two-finger panning needs no `Shift`, `Ctrl` or `Space`. Horizontal trackpad
deltas are used directly, so a sideways gesture pans sideways.

Browsers report a trackpad pinch as a `ctrlKey` wheel event, so pinch and
explicit modifier zoom share exactly one code path.

## Mouse

| Input | Result |
| --- | --- |
| Wheel | Scrolls the canvas vertically |
| `Shift` + wheel | Scrolls the canvas horizontally |
| `Ctrl` / `Cmd` + wheel | Gentle zoom around the pointer |
| Middle-button drag | Pan |
| `Space` + left drag | Pan |
| Left drag on empty canvas | Unchanged Select / Marquee behaviour |

A plain wheel never zooms. Middle-button and `Space` drags are intercepted
before X6 sees them, so they never start a marquee or move a device; every other
left-button gesture keeps its existing meaning.

## Zoom model

Zoom is continuous rather than stepped, so a small pinch produces a small
change instead of a whole step:

```text
scaleMultiplier = exp(-normalizedDelta * sensitivity)
```

- a full 100-pixel notch equals exactly **1.05** (the previous wheel step was
  1.2);
- the toolbar **Zoom In** / **Zoom Out** buttons use a discrete ~10% step around
  the canvas center and disable themselves at the limits;
- the scale range is centralized: minimum **0.20**, maximum **3.00**.

The scale can never become zero, negative, inverted, or `NaN`. Zooming solves
for the translation that keeps the world coordinate under the pointer in place,
so the diagram never jumps away from the cursor.

The canvas status bar shows the current percentage (for example `Zoom: 85%`).
Selecting it performs **Reset Zoom**, which returns to exactly 100% without
changing the pan. **Fit Topology** remains a separate action.

## Wheel classification

All wheel heuristics live in one browser-safe classifier
(`apps/web/src/features/topology/canvas-navigation.ts`) rather than being spread
across React components:

```ts
type CanvasWheelIntent =
  | { type: "pan"; deltaX: number; deltaY: number }
  | { type: "zoom"; delta: number; clientX: number; clientY: number }
  | { type: "ignore" };
```

- `ctrlKey` or `metaKey` means zoom; anything else means pan;
- `DOM_DELTA_PIXEL`, `DOM_DELTA_LINE` and `DOM_DELTA_PAGE` are normalized into
  pixel-like deltas;
- a single event is bounded so a cheap mouse or driver cannot produce a huge
  jump, while small trackpad deltas are preserved exactly;
- panning is accumulated and applied once per animation frame. That accumulator
  is presentation smoothing only and introduces no wall-clock API into
  `sim-core`.

## Scroll ownership

The wheel listener is bound to the topology canvas container only — never to
`document`. While the pointer is over the canvas:

- the canvas consumes the event;
- the page body does not scroll;
- browser page zoom is suppressed.

Everywhere else the narrowest content owner keeps its own scrolling: terminal
viewport, import wizard body, inspector content, device settings, services
tables, and the inline annotation editor.

## What navigation never does

Panning and zooming never move a selected device, create a marquee, draw a
shape, start a cable preview, change text selection, rebuild the topology, or
modify `LabDocument`. Resizing the workspace, toggling the inspector, or moving
the terminal between Docked, Floating and Maximized leaves the viewport
unchanged.

## Persistence

Scale and translation are remembered locally for as long as the lab is open.
They are workspace state, not lab data: they are never written into
`LabDocument`, an export, an assignment submission, or a grading
configuration. Opening or importing a lab performs one reasonable fit; a
resize never re-fits.

There is deliberately no sensitivity slider and no navigation preference — the
default behaviour is correct without configuration.
