# Import compatibility

SimulatorNet imports external lab files through a one-way, local conversion into
the current `LabDocument` schema. Importing does not emulate a vendor platform,
install an appliance image, or promise feature parity with the source product.
The original file is never modified.

## Formats

| Source | Accepted form | Compatibility |
| --- | --- | --- |
| SimulatorNet | canonical JSON | Full schema validation and canonicalization |
| PNETLab | `.unl` or archive containing `.unl` | Topology, positions, labels, supported configuration; unsupported devices become explicit placeholders |
| EVE-NG | `.unl` or archive containing `.unl` | Topology, positions, labels, supported configuration; unsupported devices become explicit placeholders |
| GNS3 | `.gns3`, portable `.gns3project`/ZIP | Topology, positions, drawings, bounded raster assets, supported configuration |
| Containerlab | `.clab.yml` or `.clab.yaml` | Topology and supported host/link configuration |
| Cisco Modeling Labs | YAML | Topology, positions, annotations, supported configuration |
| VIRL | `.virl` XML | Topology, positions, annotations, supported configuration |
| Packet Tracer | `.pkt`, `.pka` | Recognized only; direct conversion is not available |

Detection is content-first. File extensions help disambiguate known structures
but do not override unsafe or unrecognized content. Packet Tracer files are
reported honestly as recognized-but-unsupported; they are never guessed or
partially decoded.

Device support is reported per mapping:

- **Full**: topology and the supported structured behavior are representable.
- **Configuration partial**: topology is imported and only recognized
  configuration is applied.
- **Topology only**: the device is represented, but vendor behavior and
  configuration are not reproduced.
- **Visual placeholder**: an external appliance remains visible in the diagram
  but has no simulated protocol behavior.
- **Excluded**: the source node and links that depend on it are omitted by the
  user's explicit choice.

## Import wizard

The wizard has five deliberate steps:

1. **Select File** detects and validates the source locally.
2. **Inspect** summarizes the format, topology, configuration, annotations,
   ignored files, and safe-conversion boundary.
3. **Map Devices** lets the user accept a suggested SimulatorNet type, keep a
   visual placeholder, or exclude each source node.
4. **Review Warnings** groups material loss and blockers before conversion.
5. **Import Result** reports the final status and counts, then allows the
   converted lab or report to be opened.

Device mapping includes hostname/kind search, support filters, **Accept All**,
and **Reset**. On a narrow viewport, each mapping becomes a readable card
instead of an overflowing desktop table.

The wizard is a bounded workspace:

- its header, progress steps, and footer remain reachable;
- only the wizard body owns vertical scrolling;
- action buttons do not disappear below the viewport;
- focus remains inside the modal while it is open;
- Escape or the close action exits without importing.

Conversion does not begin until the review is accepted. Imported labs always
open stopped so placeholders, interface mappings, and partial configuration can
be inspected before simulation starts.

## Warning groups

The review screen groups the report into stable categories:

- **Blocking Errors**
- **Device Mapping Warnings**
- **Partial Configuration**
- **Ignored Vendor Images**
- **Unsupported Nodes**
- **Credential Reset Required**

Warnings are not generic success messages. They identify affected source
devices or artifacts whenever possible. The result screen distinguishes
**Imported**, **Partially Imported**, and **Failed**, and reports imported node,
link, annotation, placeholder, warning, and error counts.

## Configuration and credentials

Only configuration understood by SimulatorNet is restored as structured domain
data. A bounded, redacted source artifact may be retained for review when the
adapter cannot translate every line.

Imported plaintext passwords, secrets, and vendor password hashes are not
stored. Recognized console-access intent may be converted into SimulatorNet's
own credential flow; otherwise the report marks that a credential reset is
required. Never present imported vendor authentication as if it remained valid.

## Images and executable content

Vendor appliance images, VM disks, kernels, executables, scripts, and nested
archives are ignored or rejected. They are never run, mounted, dynamically
imported, or sent to a remote service.

Diagram images are accepted only when their bytes validate as a bounded PNG,
JPEG, or WebP. Remote URLs, SVG, embedded bitmap wrappers, and files whose
extension disagrees with their actual content are rejected. Imported text is
plain text, not executable HTML.

## Resource limits

`packages/importers/src/config/limits.ts` is the single source of truth. Current
defaults bound:

- input to 100 MiB;
- archive entries to 500;
- total expansion to 200 MiB;
- a topology/config text file to 10 MiB;
- retained diagram assets to 20 MiB;
- compression ratio to 100:1;
- topology to 500 nodes, 2,000 links, and 5,000 annotations;
- configuration/artifact text per device;
- XML and YAML depth/node counts.

YAML aliases and nested archives are disabled. ZIP paths are normalized and
validated before extraction. Limit failures stop inspection with a structured
error; they do not produce a truncated lab that looks successful.

## Determinism and persistence

Inspection produces an immutable plan. Execution applies the user's mapping
selection and creates a normal schema-valid document. Canonical ordering and ID
derivation make the same source and mapping choices produce the same converted
document.

The conversion persists domain data only. It never stores parser objects,
archive entry handles, vendor runtime state, X6 internal JSON, imported scores,
or transient simulation caches.
