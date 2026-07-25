# Workspace layout

SimulatorNet uses a dense engineering workspace designed to keep the topology
visible while tools appear on demand. It does not use dashboard cards, a
permanent marketing panel, or a fake physical/rack mode.

## Regions

From top to bottom, the open-lab workspace contains:

1. a compact application bar with identity, menus, lab power, and global
   actions;
2. a contextual action toolbar with edit controls, device picker, diagram
   tools, and current execution status;
3. the topology workspace, with an optional overlay inspector;
4. a resizable bottom dock for Terminal, Events, Packet Trace, and Problems;
5. a narrow status footer with mode, deterministic virtual time, device count,
   and schema version.

The topology occupies the remaining space. Canvas status and diagram toolbars
reserve actual graph space, so X6 nodes are not hidden behind overlays and
pointer input reaches the intended surface.

The device library is available as a compact toolbar dropdown. It supports
click-then-place and drag-and-drop placement without permanently consuming a
side column.

## Inspector and device windows

Single-clicking a device or link may open the compact inspector. It is closed by
default and can be dismissed without changing selection or runtime state. On a
narrow viewport it is an overlay drawer rather than a column that compresses
the topology.

Double-clicking a device opens its floating/docked device window. A device
window owns configuration and desktop tools, but its CLI action only opens the
shared terminal workspace. Deleting a stopped device closes only the window and
terminal tab associated with that device.

The **Instructions** button in the lower-left canvas opens a resizable panel for
the lab title, description, instructions, and expected outcome. Local labs read
this from `LabDocument` metadata; assignments use assignment instructions. The
panel does not introduce course or cohort concepts.

## Topology rendering

AntV X6 is the rendering and interaction layer.
`TopologyGraphController` is its sole imperative owner:

- create and dispose the graph;
- render device nodes, physical links, labels, and diagram annotations;
- maintain port and transform handles;
- subscribe and unsubscribe graph events;
- translate viewport and client coordinates;
- respond to container size changes;
- fit and re-anchor visuals without changing domain identity.

React owns `LabDocument` and workspace state. It sends explicit domain updates
to the controller and receives typed interaction callbacks. Neither React nor
X6 internal JSON is the persisted topology.

Physical links retain source/target device IDs and interface IDs from
`LabDocument`. Resize, redraw, style, or endpoint visual re-anchoring must never
infer or swap those semantic endpoints.

## Canvas viewport ownership

The canvas owns exactly one viewport: a single graph translation and a single
graph scale. There is no X6 Scroller, no inner topology scrollbar and no second
panning system, so wheel input is classified and applied once.

Two-finger trackpad movement pans on both axes, pinch and `Ctrl`/`Cmd`+wheel
zoom gently around the pointer, and middle-button or `Space` drags pan. While
the pointer is over the canvas the page never scrolls and browser page zoom is
suppressed; everywhere else the narrow content owner keeps its own scrolling.

Pan/zoom is local workspace state. It is remembered for as long as the lab is
open and is never written into `LabDocument`, an export, or grading. See
`docs/canvas-navigation.md`.

## Connection workflow

The default workflow is device-first, similar to professional network-lab
editors without copying their assets:

1. choose Connection or drag from the visible connection handle on a device;
2. drop on another valid device;
3. use the modal to choose connection type and available source/target
   interfaces;
4. confirm the domain link.

Occupied or incompatible endpoints are not offered as valid choices. Cancelling
the modal creates no link. The modal owns type/interface selection; dragging is
only spatial target selection.

Direct port-to-port interaction can remain available as an advanced workflow.
Both paths create the same canonical link object.

## Device and link presentation

The default Classic Lab profile uses small original equipment-style symbols,
hostname below the icon, and a separate red/green status square. Education Flat
and Minimal Network are visual-only alternatives. The selected icon profile is
stored locally under `simulatornet.deviceIconProfile`; it never changes device
type, lab data, simulation, or grading.

Links are thin and blue by default. Interface labels sit near their endpoint and
can be Always, Selected, or Hidden. Editable subnet/WAN labels and
straight/orthogonal visual routes belong to `LabDocument.diagram`; forwarding
still uses the physical domain link.

## Lab power and edit impact

The workspace distinguishes three classes of change:

| Change | Examples | Runtime action |
| --- | --- | --- |
| Presentation | positions, annotations, labels, visual routes | Apply immediately; no worker rebuild |
| Configuration | host IP, CLI configuration, server service settings | Typed worker update; preserve physical topology |
| Structural | add/delete device, connect/reconnect/delete link | Require stopped lab; rebuild from lab-format |

Structural controls are disabled while running. Diagram and position editing
remain available because they cannot alter packet forwarding.

Pending topology changes are explicit. Applying them serializes current
structured device configuration, merges presentation state, rebuilds through
`lab-format`, and resets only transient runtime state.

## Bottom dock and terminal

The bottom dock is always the bottom region of the application workspace. Its
horizontal separator changes dock height while preserving a usable topology
minimum. Events, Packet Trace, and Problems render inside that bounded region.

The terminal has Docked, Floating, and Maximized presentations. Docked terminal
height follows the bottom workspace; Floating/Maximized render in the terminal
presentation layer without changing the topology model. All three present the
same mounted tabs and CLI sessions.

Packet Trace owns the **Auto/Step** execution control:

- Auto completes bounded actions automatically;
- Step queues deterministic virtual events for Step or Run All.

The indicator may remain compact when Packet Trace is closed. There is no
wall-clock Realtime mode.

## Responsive behavior

The desktop layout is optimized for 1440×900 and 1920×1080 while remaining
usable at 1280×720.

At 1,300 px and below, labels and identity details compact before controls are
removed. At 999 px and below:

- the device library and inspector become overlay drawers;
- large toolbar labels collapse to icons where the accessible label remains;
- canvas status metadata compacts;
- terminal identity and search controls reduce;
- the topology keeps the central width.

At small heights, modal and empty-state padding reduce. At 680 px and below the
import wizard uses a near-full-viewport layout and one-column mapping cards.

## Scroll and measurement ownership

The document body and application shell do not scroll during normal workspace
use. Fixed regions use `min-width: 0`, `min-height: 0`, and clipped overflow so
flex/grid children can measure correctly.

Scrolling belongs to the narrowest content owner:

- inspector content;
- device-window content;
- import-wizard body;
- table wrappers;
- Instructions panel;
- xterm viewport.

This rule prevents nested scrollbars and ensures X6 and xterm consume newly
available space after a resize. `ResizeObserver` work must be bounded and
cleaned up on unmount; avoid observer loops caused by writing an unconstrained
size back to the element being observed.

## Persistence boundary

Persist in `LabDocument`:

- topology and structured device configuration;
- deterministic seed and lab metadata;
- device positions;
- link labels and visual routes;
- diagram annotations, assets, styles, and z-order.

Keep local-only:

- theme and icon profile;
- port-label display preference;
- open panels, selection, active tools, and smart guides;
- terminal presentation and bounds;
- browser Auto/Step mode.

Never persist X6 graph JSON, DOM geometry, worker instances, terminal state,
transient protocol caches, or a client-computed verification result.
