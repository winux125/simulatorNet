# Visual asset provenance

SimulatorNet uses two sources of iconography. This keeps the interface
consistent and the licensing unambiguous.

## Control icons — Lucide

Toolbar, menu, dock and device-window action icons come from
[`lucide-react`](https://lucide.dev) (ISC license). Lucide is the single control
icon set; other icon libraries and ad-hoc action SVGs are not mixed in.

## Device icons — original SimulatorNet SVGs

All network-device SVGs were drawn specifically for SimulatorNet. They were not
extracted, copied, traced, converted or bundled from Packet Tracer, PNETLab,
EVE-NG, GNS3, Containerlab, a network vendor, or another product. The artwork
uses the broad visual language of professional network tools — compact
equipment silhouettes, port rows, directional routing marks and separate
status indicators — while retaining original SimulatorNet geometry.

The 45 source SVGs live under
[`apps/web/src/assets/device-icons/`](../apps/web/src/assets/device-icons), with
fifteen device types in each profile:

- **Classic Lab** — restrained grey equipment-style symbols, shallow chassis
  depth and small hardware details for professional network labs.
- **Education Flat** — clear, brighter flat silhouettes with strong
  device-to-device differentiation for teaching diagrams.
- **Minimal Network** — strict `currentColor` line symbols for dense
  infrastructure topologies and low zoom levels.

Each `classic/`, `education/` and `minimal/` directory contains `pc.svg`,
`server.svg`, `laptop.svg`, `smartphone.svg`, `hub.svg`, `bridge.svg`,
`l2-switch.svg`, `l3-switch.svg`, `router.svg`, `access-point.svg` and
`wireless-router.svg`, plus the original `firewall.svg`, `cloud.svg`,
`traffic-generator.svg` and `external-appliance.svg`
security/infrastructure/import symbols.

The files are the geometry source of truth and are rendered through the shared
[`DeviceIcon`](../apps/web/src/components/DeviceIcon.tsx) component. The profile
preference is local UI state stored as `simulatornet.deviceIconProfile`; it is
not part of `LabDocument`, submissions, simulation or grading. The same
component and source asset is used by topology nodes, the device palette,
device windows, the Inspector, terminal tabs and import previews.

Design rules enforced by `DeviceIcon.test.tsx`:

- every provenance asset uses the same `0 0 64 64` viewBox;
- each file exposes one `device-icon` fragment used by the renderer;
- `currentColor` only — profile/device color comes from application design
  tokens, not hard-coded SVG paint;
- no gradients, SVG filters or embedded shadows;
- theme-aware and legible at 20/24/32/48/64 px;
- no embedded raster images, external URLs or embedded text;
- runtime status uses a separate indicator and never changes SVG geometry.

## Explicitly excluded

- No third-party network-vendor or simulator icons, logos or branding.
- No user-supplied icon-pack manager, manifest, archive or binary import path.
- No photographs of hardware.
- No AI-generated raster (PNG/WebP/JPEG) or vector assets.
- No remotely loaded images.
- No emoji used as a final device symbol.

Licensing: Lucide is ISC-licensed; the SimulatorNet device SVGs are original
repository assets covered by the repository license.

## User-provided diagram images

Diagram image annotations are user content embedded in the portable
`LabDocument`; they are not repository artwork and never become device icons.
Only decoded PNG, JPEG and WebP raster content is accepted. The importer checks
the binary signature and decoded dimensions instead of trusting the file name
or browser-provided MIME type.

Security and resource boundaries:

- 2 MiB decoded bytes per image, 8 MiB total, and at most 20 images per lab;
- dimensions from 1×1 through 4096×4096 pixels;
- no SVG, GIF, HTML, remote URL, filesystem path or executable content;
- no `dangerouslySetInnerHTML`, network fetch, dynamic import or external image
  reference;
- images are rendered only from their local validated `data:` representation;
- image assets and annotations participate in canonical ordering and hashing,
  but simulation and grading ignore their visual content.
