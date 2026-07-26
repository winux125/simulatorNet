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

## Inline text editing

Diagram text is edited directly on the canvas. Nothing in the normal text
workflow opens a modal window or a properties dialog.

- the **Text** tool places a caret where you click;
- double-clicking existing text opens the editor exactly over it;
- double-clicking a physical link or a diagram line/arrow edits its label
  in place;
- the contextual formatting toolbar stays usable while the editor is open, so
  font size, bold, italic, alignment and colors apply without closing it.

| Key | Result |
| --- | --- |
| `Enter` | New line in a text annotation; commits a single-line label |
| `Ctrl` / `Cmd` + `Enter` | Commit and close |
| `Escape` | Cancel the session — a new annotation is discarded, existing text is unchanged |
| `Tab` | Commit and return focus to the canvas (never inserts a tab) |
| Click outside | Commit |

While the editor is focused, `Delete`, diagram tool shortcuts and global
workspace shortcuts do not fire; terminal shortcuts still work.

Text is stored and rendered as plain text. Pasting reads only `text/plain`,
normalizes line endings, strips control characters and applies a length bound;
clipboard HTML, styles and embedded content are discarded. Nothing in the
diagram path uses `dangerouslySetInnerHTML` or `innerHTML`.

The editor is an absolutely positioned overlay in canvas coordinates. It honours
graph scale, translation, annotation size, rotation and theme, and it follows
pan, zoom and workspace resizes while it is open. A wheel over the editor
scrolls the editor, never the canvas or the page.

One edit session is one undo step: intermediate keystrokes never enter the
document history, and creating text commits the annotation and its content
together. A new annotation that stays empty is discarded and leaves no history
entry; existing text may become empty and stays until it is explicitly deleted.
Emptying a link label removes the label without touching connectivity.

Inline editing is allowed while the lab runs. It is presentation-only: no worker
rebuild, no ARP/TCP/trace reset, and no effect on grading.

## Connecting devices

A device shows exactly one connection control: a **cable handle** that appears
on hover or selection next to the icon, labelled *Connect \<hostname\> to
another device*.

1. drag the cable handle onto a target device;
2. the target highlights, an invalid target shows a forbidden state, and
   cancelling or dropping outside clears the preview without creating a link;
3. the modal fixes the two devices and asks for **Connection Type**,
   **From Interface** and **To Interface**;
4. **Connect** commits one canonical domain link.

The same workflow is available from a device's **Connect…** context menu item
and from the toolbar connection tool. The preview line is never a domain edge;
only the modal creates one.

Only free interfaces are offered. A single free interface is selected
automatically but stays visible; a device with none disables **Connect** and
explains why.

The cable handle is hidden while the Hand/Pan tool is active, while an
annotation tool is drawing, while an inline editor is open, when the lab is
running, and for an appliance with no known interfaces.

### No visible port handles

There are no dots, circles, magnets or hover markers around a device in any
icon profile, on hover, or on selection, and there is no direct port-to-port
drag UI.

Interface ports still exist internally and are required — they give each link
an exact source and target interface for anchoring, labels, import/export and
simulation connectivity. They are configured centrally as invisible anchor
geometry in the port registry: zero opacity, no fill or stroke, no pointer
events, and not a magnet. They are never removed with `display: none`, because
an unrendered port has no geometry and links would lose their endpoints.

### Port Labels are not connection points

`View ▸ Port Labels` (Always / Selected / Hidden) controls the interface **name**
drawn beside a link endpoint — for example `Gi0/1` or `eth0`. It is text, not a
handle. With Hidden, edges remain exactly anchored and no dots appear. There is
deliberately no "show connection points" or "advanced port drag" preference.

## Persistence

Scale and translation are remembered locally for as long as the lab is open.
They are workspace state, not lab data: they are never written into
`LabDocument`, an export, an assignment submission, or a grading
configuration. Opening or importing a lab performs one reasonable fit; a
resize never re-fits.

There is deliberately no sensitivity slider and no navigation preference — the
default behaviour is correct without configuration.
