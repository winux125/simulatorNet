# Visual asset provenance

SimulatorNet uses two sources of iconography. This keeps the interface
consistent and the licensing unambiguous.

## Control icons — Lucide

Toolbar, menu, dock and device-window action icons come from
[`lucide-react`](https://lucide.dev) (ISC license). Lucide is the single control
icon set; other icon libraries and ad-hoc action SVGs are not mixed in.

## Device icons — original SimulatorNet SVGs

Network device symbols are original artwork created for SimulatorNet. The 21
source SVGs live under
[`apps/web/src/assets/device-icons/`](../apps/web/src/assets/device-icons), with
seven device types in each profile:

- **Classic Lab** — compact equipment-style symbols for dense network labs.
- **Education Flat** — clear flat symbols for teaching diagrams.
- **Minimal Network** — lightweight monochrome symbols for large topologies.

Each `classic/`, `education/` and `minimal/` directory contains `pc.svg`,
`server.svg`, `hub.svg`, `bridge.svg`, `l2-switch.svg`, `l3-switch.svg` and
`router.svg`.

They are rendered through the shared
[`DeviceIcon`](../apps/web/src/components/DeviceIcon.tsx) component. The profile
preference is local UI state stored as `simulatornet.deviceIconProfile`; it is
not part of `LabDocument`, submissions, simulation or grading.

Design rules enforced by `DeviceIcon.test.tsx`:

- every provenance asset uses the same `0 0 64 64` viewBox;
- `currentColor` only — no gradients, embedded shadows or hard-coded palette;
- theme-aware and legible at 20/24/32/48/64 px;
- no embedded raster images, external URLs or embedded text;
- runtime status uses a separate indicator and never changes SVG geometry.

## Explicitly excluded

- No third-party network-vendor or simulator icons, logos or branding.
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
