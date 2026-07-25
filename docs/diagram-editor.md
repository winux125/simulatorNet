# Diagram editor

The topology canvas includes presentation tools for explaining a network
without changing its forwarding behavior. Devices and physical links remain
simulation objects; text, shapes, images, link labels, and visual routes remain
diagram objects.

## Tools

The canvas toolbar provides:

- **Select** for selection, movement, resize, rotation, and marquee selection;
- **Hand** for panning without selecting or moving objects;
- **Text** for plain-text labels;
- **Rectangle** and **Ellipse** for areas and callouts;
- **Line** and **Arrow** for visual relationships;
- **Image** for a bounded local raster image;
- **Connection** for physical topology links between devices.

Diagram tools and Connection are intentionally separate. A line or arrow never
forwards packets. A topology connection always references real device/interface
IDs and is subject to the lab power lock.

Clicking a shape tool once places a useful default size. Dragging creates an
explicit size:

- hold `Shift` for a square/circle or a line constrained to 45-degree steps;
- hold `Alt` to draw a rectangle/ellipse from its center;
- enabled grid snapping rounds placement to the 10-pixel diagram grid.

Creating text enters inline editing. `Ctrl/Cmd+Enter` commits text editing.
Text is always stored and rendered as plain text.

## Images

Images can be added from the Image file picker, pasted from the clipboard, or
dropped on the topology canvas. Only actual PNG, JPEG, and WebP bytes are
accepted.

Security and resource bounds are enforced by contracts and the image reader:

- 2 MiB maximum per asset;
- 8 MiB maximum retained image data per document;
- 20 assets maximum;
- 4,096 pixels maximum in either dimension;
- 12 MiB maximum diagram-document JSON envelope;
- no SVG, remote URL, embedded HTML, script, or executable content;
- the stored original name cannot contain a path or control character.

The editor stores base64 raster bytes in a validated diagram asset and refers to
it by ID. Removing the last annotation that uses an asset removes the unused
asset.

## Selection and transforms

Click selects one diagram object. `Shift`-click adds to the selection. Dragging
an empty canvas area with Select active creates a marquee for multi-selection.
`Ctrl/Cmd+A` selects all diagram annotations when canvas focus is active.

Selected unlocked objects support:

- group movement;
- resize handles;
- rotation handles for text, shapes, and images;
- line/arrow endpoint and bend handles;
- horizontal and vertical align;
- horizontal and vertical distribute;
- Bring Forward, Send Backward, Bring to Front, and Send to Back;
- lock/unlock;
- duplicate and delete.

Locked objects remain visible and selectable for inspection but cannot be moved,
resized, rotated, or edited until unlocked.

The contextual formatting toolbar appears only while an annotation is selected
or an annotation tool is active. Available fields depend on type:

- text font size, bold, italic, alignment, foreground, background, border,
  border width, opacity, fixed/automatic height;
- shape fill, stroke, width, dash, radius where applicable, rotation, opacity;
- line/arrow stroke, width, dash, start/end markers, label, opacity;
- image size, aspect preservation, alt text, rotation, opacity.

Colors are either `transparent`, `auto` where explicitly supported, or a
validated six-digit hexadecimal value such as `#4d7fa9`. The picker supplies
safe presets but never injects arbitrary CSS.

## Snapping and smart guides

Grid snapping and smart alignment guides are local workspace preferences:

```text
simulatornet.diagram.snapToGrid
simulatornet.diagram.smartGuides
```

Smart guides compare the moving bounds with nearby objects and display
temporary horizontal or vertical alignment lines. They are not persisted in the
lab.

Arrow-key movement uses one diagram unit; hold `Shift` for ten. While grid
snapping is enabled, unmodified arrow movement snaps and `Shift` provides the
larger unsnapped move.

## Clipboard and shortcuts

When the topology canvas owns focus:

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+C` | Copy selected annotations as the SimulatorNet clipboard type and safe plain text |
| `Ctrl/Cmd+V` | Paste SimulatorNet annotations, an accepted raster, or plain text |
| `Ctrl/Cmd+D` | Duplicate selected annotations with a small offset |
| `Ctrl/Cmd+A` | Select all annotations |
| `Delete` / `Backspace` | Delete selected unlocked annotations |
| Arrow keys | Move by 1 |
| `Shift` + Arrow keys | Move by 10 |
| `Enter` | Edit selected text |
| `[` / `]` | Send backward / bring forward |
| `Escape` | Cancel the active gesture, clear selection, and return to Select |
| `Ctrl/Cmd+Z` | Undo |
| `Ctrl/Cmd+Shift+Z` or `Ctrl/Cmd+Y` | Redo |

Clipboard handlers ignore form fields, editable text, and xterm, so diagram
paste never hijacks configuration or terminal input.

## History

Topology positions and diagram edits share a bounded 150-entry document
history. A new edit clears the redo branch.

Network configuration is deliberately rebased through past and future entries.
If an IP address, CLI setting, service, or other device configuration changes
after a diagram history entry, undoing the diagram does not roll that
configuration back.

## Running-lab behavior

Presentation editing remains available while the lab is running:

- add, move, resize, style, lock, or delete annotations;
- edit link labels and visual route vertices;
- change device positions.

These operations do not rebuild the worker, clear caches, reset services, or
interrupt a ping.

Structural topology remains locked while running:

- adding or deleting a device;
- creating, deleting, or reconnecting a physical link;
- changing real endpoint interfaces.

Stop the lab before structural edits. A running lab never interprets a diagram
line as a physical connection.

## Persistence

The optional `LabDocument.diagram` section contains:

```text
assets
annotations
linkLabels
linkStyles
```

Supported annotation types are `text`, `rectangle`, `ellipse`, `line`, `arrow`,
and `image`. Link styles contain presentation-only straight/orthogonal routing
and bounded vertices. Physical endpoint identity remains in
`topology.links`.

Canonical export sorts domain collections by stable ID. Older documents without
a diagram section load with empty diagram defaults. Import/export and assignment
autosave preserve diagram data, but X6 internal graph JSON, active selection,
tools, handles, smart guides, and local preferences are never persisted.

Normal grading submissions exclude diagram presentation. Changing an icon,
annotation, image, label, or visual route therefore cannot change a trusted
verification result.

## Current scope

The editor is intentionally not a general illustration application. It does not
provide rich HTML text, arbitrary SVG, image crop/filters, persistent group
objects, freehand drawing, or arbitrary multi-segment vector paths. Those
limitations keep the lab schema safe, deterministic, and portable.
