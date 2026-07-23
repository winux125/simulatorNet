# Visual asset provenance

SimulatorNet uses two, and only two, sources of iconography. This keeps the
interface consistent and the licensing unambiguous.

## Control icons — Lucide

Toolbar, menu, dock and device-window **action** icons come from
[`lucide-react`](https://lucide.dev) (ISC license). Lucide is the single control
icon set; Material, Font Awesome and ad-hoc SVGs are intentionally not mixed in
for the same actions.

## Device icons — original SimulatorNet SVGs

Network **device** symbols are original artwork created for SimulatorNet and
live in [`apps/web/src/assets/device-icons/`](../apps/web/src/assets/device-icons):

| Type        | File            |
| ----------- | --------------- |
| PC          | `pc.svg`        |
| Server      | `server.svg`    |
| Hub         | `hub.svg`       |
| Bridge      | `bridge.svg`    |
| L2 Switch   | `l2-switch.svg` |
| L3 Switch   | `l3-switch.svg` |
| Router      | `router.svg`    |

They are rendered through the single [`DeviceIcon`](../apps/web/src/components/DeviceIcon.tsx)
component, which is reused across the palette, topology nodes, device windows and
the inspector so a device looks identical everywhere.

Design rules (enforced by `DeviceIcon.test.tsx`):

- one visual language: `0 0 24 24` viewBox, 1.6 stroke width, round caps/joins;
- `currentColor` only — no gradients, embedded shadows or hard-coded palette;
- theme-aware (inherit text colour), legible at 20/24/32/48/64 px;
- no embedded raster images, no external URLs, no embedded text;
- runtime status is shown by a **separate** indicator, never baked into the SVG.

## What is explicitly excluded

- No Cisco or Packet Tracer icons, logos or branding.
- No photographs of hardware.
- No AI-generated raster (PNG/WebP/JPEG) or vector assets.
- No remotely-loaded images.
- No emoji used as a final device symbol.

Licensing: Lucide is ISC-licensed; the SimulatorNet device SVGs are part of this
repository and covered by the repository license.
