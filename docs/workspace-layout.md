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

The workflow is device-first, similar to professional network-lab editors
without copying their assets:

1. drag the single cable handle on a device, or choose Connect… / the toolbar
   connection tool;
2. drop on another valid device;
3. use the modal to choose connection type and available From/To interfaces;
4. confirm the domain link.

Occupied or incompatible endpoints are not offered as valid choices. Cancelling
the modal creates no link. The modal owns type/interface selection; dragging is
only spatial target selection.

The cable handle is the only visual connection control. Interface ports exist
internally as invisible anchor geometry so a link always binds exact device and
interface IDs, but no port dots, magnets or hover markers are drawn in any icon
profile, and there is no direct port-to-port drag UI. Port Labels display
interface names; they are not connection points. See
`docs/canvas-navigation.md`.

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

Wireless association is intentionally not drawn as a cable. View ▸ Wireless
Associations toggles a dashed curved runtime overlay from station to AP, with
the SSID as an optional label and association-state color. The overlay has no
interface port, is not selectable as a physical link, never enters the cable
workflow, and is not persisted. Laptop `eth0` remains available to the ordinary
cable modal; `wlan0` never appears there. Smartphone has no Ethernet cable
endpoint, while an Access Point exposes only its `eth0` uplink.

Laptop and Smartphone device windows own scan/connect/disconnect/forget actions.
Access Point windows own Wireless and Associated Clients views. Wireless Router
windows group Setup, Wireless, LAN, WAN, DHCP, IPv6, NAT, Firewall, Connected
Clients, and Runtime views while reusing the existing protocol runtime rather
than maintaining UI-only network state.

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

### Resizable panel registry

The application has one `react-resizable-panels` group. Its registry is stable:

| Group ID | Orientation | Ordered Panel IDs | Conditional content |
| --- | --- | --- | --- |
| `workspace-layout-v2` | vertical | `workspace-main`, `workspace-bottom-dock` | Bottom Dock content and `workspace-bottom-separator` |

Both `Panel` elements remain direct children of the group. Minimized, hidden,
and welcome states collapse `workspace-bottom-dock` to zero after registration;
they do not remove its panel identity or apply a one-panel layout. The
separator and dock content are absent while collapsed, so no visible row,
resize target, border, or reserved height remains.

The Inspector is an overlay inside `workspace-main`, not a resizable panel.
Opening or closing it therefore never changes the registered panel set.
Device windows, management/service sections, and QoS sections use their own
bounded content regions and do not create nested `PanelGroup` instances.

The ordered layout is stored under `simulatornet.workspaceLayout.v2`. Every
entry records its exact panel IDs and rejects missing, unknown, non-finite,
zero, out-of-constraint, or stale values before they reach the library. The
legacy `react-resizable-panels:workspace-layout` value is migrated only when it
matches the current ordered panel set; otherwise only that layout preference is
discarded. Theme, terminal, Bottom Panel, and other SimulatorNet preferences
are preserved.

### Bottom panel states

The panel has three presentations:

| State | Occupies | Contents |
| --- | --- | --- |
| Expanded | the resizable panel height | tabs and full tab content |
| Minimized | a 34 px strip | tabs, badges, Expand and Hide only |
| Hidden | 0 px | nothing; counts move to the status footer |

Minimized and Hidden render no panel row at all — no invisible resizer, no
stale border, no reserved height — so the canvas receives the freed space. The
panel returns from View ▸ Bottom Panel ▸ Show, from the minimized strip, from
the status footer entries, or with `Ctrl/Cmd+J`.

**Hiding or minimizing the panel is a display change only.** Terminal tabs, CLI
sessions, authentication, input buffers, command history, scrollback, a pending
paste, event data and filters all stay exactly as they were. Closing a terminal
tab is the separate action that ends a CLI session.

Events, Packet Trace and Problems keep accumulating (bounded) while collapsed.
The minimized strip shows live counts; a hidden panel moves them to a compact
status entry in the footer, where a new Problems error is marked. Nothing
force-expands the panel without a user action, and no event raises a toast.

`Ctrl/Cmd+J` toggles: anything collapsed opens, an open panel hides. Minimizing
stays a deliberate choice from the menu or the panel controls.
`Ctrl/Cmd+Shift+J` is left to the browser. Because xterm cancels the key events
it consumes, these panel shortcuts are also captured before the terminal sees
them.

The expanded height is restored across every collapse round trip and clamped
after a viewport resize: at least 180 px, never more than 48% of the workspace.
Both the state and the height are local preferences stored under
`simulatornet.bottomPanelState` and `simulatornet.bottomPanelExpandedHeight`. A
first run on a viewport shorter than 620 px starts minimized.

### Terminal presentations

The terminal has Docked, Floating, and Maximized presentations. Docked terminal
height follows the bottom workspace; Floating/Maximized render in the terminal
presentation layer without changing the topology model. All three present the
same mounted tabs and CLI sessions.

Panel state and terminal presentation are independent concepts:

- a hidden panel leaves a floating or maximized terminal fully visible;
- a docked terminal behind a collapsed panel keeps its session and simply has
  no slot to draw into, so xterm is not fitted while it has no measurable size;
- Dock at Bottom expands the panel and activates the Terminal tab;
- showing the panel again returns the docked terminal with the same buffer.

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
- bottom panel state and expanded height;
- multi-line paste confirmation;
- browser Auto/Step mode.

Never persist X6 graph JSON, DOM geometry, worker instances, terminal state,
transient protocol caches, or a client-computed verification result.

## Site-to-site VPN surfaces

A Router or Firewall device window carries exactly one top-level **VPN** tab,
the same shape as the consolidated QoS tab. Tunnels, IKE Peers, IPsec Profiles,
Sessions and Counters are secondary navigation *inside* it — never five
top-level tabs, and never a nested modal window. Which section is open is local
UI state: it never reaches `LabDocument`, a submission, grading or the database.
A device with no tunnel capability gets no VPN tab at all.

The IKE Peers section can set or reset a pre-shared key. The key is derived into
an opaque verifier in the main thread and only that value crosses the worker
boundary; the panel never reads a key or a verifier back, and shows only whether
one is configured. Sessions and Counters show SPIs, sequence numbers, virtual
age and packet/byte counts — all runtime, none of it persisted.

**View → Protocol Overlays** groups the derived runtime overlays: Wireless
Associations and VPN Tunnels. A VPN overlay is a curved, dashed presentation
edge between two tunnel peers, coloured by what the engine reports — plain GRE,
protected, negotiating or failed. Like a wireless association it has no port
identity, never enters `LabDocument.topology.links`, never opens the cable
modal and never triggers Apply Topology. Whether it is drawn is local workspace
state (`simulatornet.vpnTunnelOverlay`).

Packet Trace adds a `VPN` filter for the whole family plus `GRE`, `IKE`, `IPsec`
and `ESP` for one stage each. Problems reports a tunnel that is down with the
reason the engine gave — source unavailable, destination unreachable, recursive
route, protection unavailable — and an IKE failure as authentication failed,
proposal mismatch, peer unreachable, no pre-shared key, identity mismatch or
rekey failed. No VPN surface ever renders a key or a verifier. See
[vpn-tunnels.md](vpn-tunnels.md).
