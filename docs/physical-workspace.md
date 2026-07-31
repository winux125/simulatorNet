# Physical workspace

SimulatorNet shows one lab through two representations. The **Logical** view is
the topology canvas: devices, cables, diagram annotations. The **Physical** view
answers a different question — *where is the equipment* — with sites, rooms and
racks.

The switch sits in its own strip above the workspace. It is deliberately not
mixed with Edit/Operate (which controls whether the topology may be changed) or
with Auto/Step (which controls packet execution). Which view is on screen is
local workspace state; it never enters `LabDocument`, a submission, grading or
the database.

## The one rule

Physical placement is **presentation only**. It never affects:

- `DeviceType`, interfaces or links;
- routing, forwarding or firewall/NAT/ACL decisions;
- wireless reachability, signal or association;
- latency, capacity or QoS;
- grading, or the verifier in any way;
- the running data plane.

Consequently, changing a placement:

- never shows *Apply Topology*;
- never triggers a worker rebuild;
- never clears ARP, MAC, DHCP leases, TCP state or the packet trace;
- is allowed while the lab is running.

The change-impact classifier enforces this: a document that differs only in
`physical` classifies as `presentation`, and `PhysicalWorkspace` is typed so it
can only ever request that impact.

A small permanent notice states the honest limit:

> Physical placement is visual only. Wireless coverage and cable length are not
> calculated in this version.

Room coordinates are never fed to `WirelessMedium`. Radio reachability keeps
coming only from the structured radio domain, band, channel, enabled state,
SSID and explicit preference — see `docs/wireless-simulation.md`.

## Data model

`LabDocument.physical` is optional presentation metadata, exactly like
`LabDocument.diagram`:

```ts
physical?: {
  sites: PhysicalSite[];              // id, name, rooms
  devicePlacements: DevicePhysicalPlacement[];
}
```

| Type | Fields |
| --- | --- |
| `PhysicalSite` | `id`, `name`, `rooms` |
| `PhysicalRoom` | `id`, `name`, `backgroundAssetId?`, `racks` |
| `PhysicalRack` | `id`, `name`, `rackUnits` (default 42), `position`, `width`, `height?` |
| `DevicePhysicalPlacement` | `deviceId`, `siteId`, `roomId`, `rackId?`, `rackUnit?`, `rackUnitSpan` (1-4), `x?`, `y?`, `orientation?` |

A rack-mounted device carries `rackId` plus `rackUnit`; a free-placed device
carries `x`/`y` inside the room. A device with no placement is **Unplaced**,
which is a normal state and never blocks Start Lab.

`rackUnitSpan` is drawing height only. Nothing here models power, cooling,
weight, real dimensions, cable length, patch panels, PDUs or cable capacity, so
the workspace never shows an invented value.

### Ordering and validation

`lab-format` canonicalizes sites, rooms and racks by id and placements by device
id, and omits the whole block when nothing is placed — so a lab written before
M10.8.1 still round-trips byte-identically.

Semantic validation rejects an incoherent layout even if it was hand-edited:

- duplicate site, room, rack or device-placement ids;
- a placement whose device, room or rack does not exist;
- a room that does not belong to the site the placement names;
- a rack unit outside `1..rackUnits`, or a device that would overflow the rack;
- two devices claiming the same rack unit;
- a `backgroundAssetId` that is not a stored diagram asset.

Deleting a device drops its placement, so a stale placement can never outlive
its device.

### Background images

A room floor plan references an id in `diagram.assets`. That is deliberate: it
reuses the diagram editor's validated PNG/JPEG/WebP pipeline and its size
budget. SVG, remote URLs, embedded scripts and executable content stay rejected
by exactly the same rules, and there is no second image path to audit — see
`docs/diagram-editor.md`.

## Workspace surfaces

| Surface | Role |
| --- | --- |
| Hierarchy tree (left) | Sites, rooms and racks; create, select, rename, delete |
| Room stage (center) | Racks and free-placed devices; one pan/zoom viewport |
| Properties (right) | The selected site, room, rack or device placement |
| Unplaced Devices (bottom) | Devices with no placement yet |

Devices can be dragged from the tray onto a rack unit or into the room, dragged
between rack units, or moved with the explicit controls in the Properties panel
(which is also the keyboard path). A rack unit holds exactly one device: a
collision is **rejected** rather than silently displacing the occupant.

Double-clicking a device opens the ordinary device window.

The stage owns exactly one viewport — one translation and one scale — and its
wheel handling goes through the shared classifier in
`features/topology/canvas-navigation.ts`, so the trackpad model is identical to
the topology canvas. The listener is bound to the stage container, never to
`document`. Pan and zoom are local state and never reach `LabDocument`.

At narrow widths the Properties panel and then the tree drop away so the room
stays usable. Only the stage, the tree list, the properties column and the tray
scroll; the workspace itself never creates a second scrollbar.

## Show Connections

The optional **Show Connections** toggle summarizes the *logical* links between
placed devices. It is an overlay derived from `topology.links`:

- no separate "physical connection" object exists;
- `topology.links` is never modified;
- a peer in another room is reported as a compact off-room entry rather than
  being routed as a cable across the drawing.

## Import and export

A native `LabDocument` saves and restores physical metadata unchanged.

Importers never invent one. PNETLab, GNS3, CML and Containerlab canvas
coordinates are logical-topology positions, not rack placement, so they are not
translated into sites, rooms or racks. Foreign physical metadata is only used
when it is explicitly present and can be represented safely. An imported lab —
like any lab written before M10.8.1 — simply opens with:

```
Default Site
Default Room
all devices Unplaced
```
