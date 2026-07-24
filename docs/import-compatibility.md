# Import compatibility

SimulatorNet can open topologies authored in several other network-lab tools.
Import is a **one-way conversion** into a native SimulatorNet `LabDocument`: the
source file is never modified, and no reverse export to the original format is
claimed. Everything below runs in the browser (or the Node test runner) via the
`@sim/importers` package — no server, no OS process, no shell, no real network,
and no VM/image execution.

## Supported formats

| Format | Support | Topology | Config | Images | Notes |
|---|---|---|---|---|---|
| SimulatorNet (`.json`) | Full | Yes | Yes | Yes | The only full-fidelity round-trip format. |
| PNETLab / EVE-NG (`.unl`, `.zip`) | Topology + partial config | Yes | Supported IOS-like subset | Safe raster only | Networks become links or an intermediate switch/hub. |
| GNS3 (`.gns3`, `.gns3project`) | Topology + partial config | Yes | Supported subset + VPCS | Safe raster only | Ports/adapters resolved to interfaces. |
| Containerlab (`.clab.yml`) | Topology + partial config | Yes | Inline startup-config | — | Interfaces derived from link endpoints. |
| CML 2.x (`.yaml`) / VIRL 1.x (`.virl`) | Topology + partial config | Yes | Supported subset | — | Node definitions mapped to generic devices. |
| Packet Tracer (`.pkt`, `.pka`) | Recognised, **not convertible** | — | — | — | No documented public conversion contract. |

## What is never imported

Vendor appliance images and binaries are **never** imported, decoded in full, or
uploaded: `qcow2`, `vmdk`, `vdi`, `vhd(x)`, `iso`, `img`, `bin`/`image`, IOL
binaries, ELF/PE/Mach-O executables, Docker image archives, firmware and license
files. When an archive contains them they are skipped and listed in the report:

> Vendor appliance images are not imported. SimulatorNet reimplements supported
> behaviour and never executes these files.

## Device mapping and placeholders

Each source node is mapped declaratively to a generic SimulatorNet device
(router, L2/L3 switch, firewall, PC, server, hub, cloud). A node whose kind is
not recognised becomes an **external-appliance placeholder**: it appears on the
canvas, keeps its hostname, source platform/vendor/kind, interfaces, links,
position and any preserved (never executed) startup text, but has no simulation
logic. Its status is "Unsupported simulation"; you can Inspect Source, Replace
with a Supported Device, or Delete it. It cannot start a CLI as if it were
running, cannot join the data plane, and never yields grading success. The import
wizard lets you accept each suggested mapping, pick another device type, keep the
placeholder, or exclude the node.

## Configuration import

For Cisco IOS-like sources a supported command subset is applied through the
public configuration API (hostname, interface addressing/shutdown/description,
VLANs, switchport access, and directly-connected static routes); VPCS addressing
is applied for VPCS hosts. **Only settings that cannot fail semantic validation
are applied**, so an import never produces a lab that refuses to open. Every
unrecognised line is preserved and reported per device — unknown source config is
never silently dropped. Junos/EOS/PAN-OS/FortiOS configs (no parser) are kept as
source text with support level `topology-only`; they are not passed off as
applied configuration.

## Determinism and boundaries

- The same source file always produces a **byte-identical** canonical
  `LabDocument`. Provenance (`sourceImport`) is timestamp-free and never reaches
  the verifier, so it cannot perturb grading.
- Imported labs always open **stopped**. External appliances are marked
  unsupported; you can replace them before starting.
- Archives are guarded against ZIP-slip, absolute paths, symlinks, duplicates,
  excessive entry counts/sizes and compression bombs; XML rejects DOCTYPE/DTD and
  non-predefined entities; YAML rejects tags, anchors and aliases.
