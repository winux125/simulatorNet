# Device configuration

SimulatorNet keeps **one** source of truth for what a device is configured to
do: the structured `DeviceConfig` inside `LabDocument`. Everything a person
reads — `show running-config`, a `.cfg` file, a Compare view — is a *projection*
of that model, produced by one renderer. There is deliberately no second copy
that can drift out of sync.

```text
CLI command
  → public device configuration API (sim-core)
    → structured running configuration (DeviceConfig)
      → deterministic renderer (@sim/device-config)
        → configuration text
```

Text never flows back the same way by accident: it is parsed into structured
configuration, previewed, and applied atomically.

## Running and startup configuration

The **running configuration** is what the live device holds. It changes through
the CLI, the structured device panels, an applied text configuration, or a typed
worker request.

The **startup configuration** is a separate structured snapshot stored in
`LabDocument.startupConfigurations`. It stores configuration only — never
ARP/MAC tables, learned routes, DHCP leases, TCP sessions, NAT translations,
VPN security associations, QoS queues, protocol neighbours or packet trace.

A device is in exactly one of three states:

| State | Meaning |
| --- | --- |
| *implicit* | No snapshot is stored. Startup equals running — what every lab written before M10.9.1 has, so an older file opens without a migration and without a false "unsaved" badge. |
| `saved` | A snapshot exists; comparing it with the running configuration gives **Saved** or **Modified**. |
| `absent` | `erase startup-config` emptied the NVRAM. A reload boots factory defaults. |

Drift is computed from **canonical structured snapshots**, never from rendered
strings, so a renderer change can never turn a saved device into a modified one,
and two configurations that differ only in property order compare equal.

## Commands

Router, L2 Switch, L3 Switch, Bridge and Firewall support the full lifecycle:

```text
show running-config
show startup-config
copy running-config startup-config      (copy run start)
write memory                            (write, wr)
erase startup-config
reload
```

`erase startup-config` asks `[confirm]` and leaves the running configuration
alone until the next reload. `reload` asks
`System configuration has been modified. Save? [yes/no]:` when the two differ —
`yes` saves first, `no` discards the unsaved changes, anything else cancels —
and then `Proceed with reload? [confirm]`.

### Reload semantics

A reload replaces **one device instance**:

- the topology is not rebuilt and no other device is disturbed;
- the device's cables are detached and reattached with their exact capacity,
  propagation delay and queue limit;
- its runtime state disappears with the old instance;
- its CLI and remote sessions are closed, because the device they were attached
  to no longer exists — every other terminal keeps its session;
- it boots from its startup configuration, or from factory defaults after an
  erase, and re-arms its protocols and management listeners.

## The renderer

`renderDeviceConfiguration(config)` in `@sim/device-config` is the only place
configuration text is produced. It:

- emits sections in one fixed order and sorts every list canonically;
- uses Cisco IOS-like syntax for Router, Cloud, L2/L3 Switch and Bridge, and
  SimulatorNet's own vocabulary for the Firewall policy model, the Access Point,
  the Wireless Router and the Server — a host is never dressed up as a Cisco
  appliance;
- omits settings that are already the default, exactly as IOS does;
- never prints runtime state;
- never prints credential material. A password, key, community string,
  passphrase, verifier, salt, hash or fingerprint is rendered as
  `<configured>`, and nothing else:

```text
enable secret <configured>
username admin privilege 15 secret <configured>
 pre-shared-key <configured>
 security wpa2-personal passphrase <configured>
```

A PC, laptop, smartphone, hub or traffic generator has no configuration file:
those devices keep the Desktop / IP Configuration surface, and
`supportsDeviceConfigurationText` returns false for them.

### The logical Port-channel block

An EtherChannel bundle is a real logical interface, so the settings that live on
it are written down rather than inferred from a member. The L2 Switch and the L3
Switch render the same block:

```text
interface Port-channel10
 description CE-DUAL-HOMED
 switchport mode trunk
 switchport trunk native vlan 99
 switchport trunk allowed vlan 10,20
 ethernet-segment ES-CE1
 port-channel min-links 2
!
interface Gi0/1
 channel-group 10 mode active
!
```

Membership is never duplicated. It stays exactly one `channel-group` line per
member, so the bundle block and the member lines can never disagree about which
port belongs to which bundle. A bundle block that no member ever declares
describes a bundle that cannot exist, so it is dropped — and any Ethernet
Segment naming it loses that attachment rather than pointing at a port the
device does not have.

Two things are deliberately **not** in the block:

- **administrative state.** A bundle's is derived from its members, so
  `shutdown` on a Port-channel is reported as unsupported rather than accepted
  into a field nothing could apply back.
- **`switchport trunk allowed vlan add|remove|except|none`.** Those mutate a set
  the parser never sees whole; only the plain list is read.

Before M10.17 an L3 Switch rendered no Port-channel block at all, which is
exactly why an Ethernet Segment could not be bound to one: the binding had
nowhere to be written down. `LabDocument → running-config → parse/apply →
LabDocument` now preserves the bundle and its segment binding.

## The parser

One parser serves the importer and the device Configuration workspace, so an
imported `.cfg` and a pasted one produce identical structured configuration:

```ts
inspectDeviceConfigurationText(text, options): ConfigApplyPlan
applyDeviceConfigurationPlan(plan, options): ConfigApplyResult
```

`inspect` is pure and synchronous. It reports every source line with its 1-based
number and an outcome (`applied` or `unsupported`), plus warnings, blocking
problems and a **value-free** credential summary. Nothing is replayed through an
interactive terminal.

`apply` is atomic. A plan carrying any problem is rejected; a plan with
unsupported lines requires an explicit `acceptUnsupportedLines`. Settings the
parser does not read — console access, remote access, AAA and SNMP — are carried
over from the device's current configuration, so pasting an interface block
never silently erases a device's credentials.

Text is bounded by `DEFAULT_DEVICE_CONFIGURATION_LIMITS`. A credential line is
redacted *before* it reaches a report, a preview or a log, and a plaintext
secret never appears in a plan. Converting a credential to a verifier is
asynchronous (Web Crypto), so it is injected rather than imported — the same
rule the wireless, management and VPN credentials already follow.

Router, Firewall, L2 Switch, L3 Switch and Bridge accept applied text. An Access
Point, Wireless Router and Server render and export a readable configuration but
are configured through their own panels; inventing a parser for a format nothing
else writes would be a second, weaker source of truth.

## The Configuration workspace

A device that owns a configuration file gets exactly one top-level
**Configuration** tab in its device window. Running Config, Startup Config,
Compare and Import / Paste are secondary navigation inside it, exactly as QoS
and VPN work. The CLI stays its own top-level tab.

| Section | What it does |
| --- | --- |
| Running Config | Read-only, monospace, line-numbered, with Copy, Download `.cfg`, Copy Running to Startup and Apply Text Config… |
| Startup Config | Read-only, with Copy, Download, Replace from text/file, Erase, and Load into Running — each destructive action behind an explicit confirmation |
| Compare | A line diff of the two rendered projections, with `Running configuration has N unsaved changes.` The diff is never a configuration source. |
| Import / Paste | Choose Running or Startup, paste or upload, **Parse**, review the report, then **Apply** |

The editor is a plain textarea and a `<pre>` with line numbers and
`Ctrl/Cmd+F` search — no embedded code editor was added for a read-mostly
surface. A file upload is bounded and refused outright if it is not plain text.

`Configuration: Saved` / `Configuration: Modified` appears in the device-window
title bar and in the device context menu; the topology node gets only a small
marker, never a large badge. The context menu adds Open Configuration, Save
Running Configuration and Reload Device, and Lab ▸ Save All Device
Configurations runs `copy running-config startup-config` everywhere after a
confirmation.

The device window shows **no raw JSON**. Structured views that used to dump JSON
now render labelled values. The canonical `LabDocument` JSON is still exactly
the model everything uses — it simply lives under **File ▸ Advanced ▸ Import /
Export Lab JSON**, behind a note that it is for diagnostics and integration.

## Academic labs

Assignment autosave stores the whole canonical document, so the running
configuration *and* the startup snapshot travel with it. A submission is graded
on the **running** configuration; the startup snapshot rides along because it is
configuration, and only a spec that explicitly asks looks at it:

```json
{ "type": "configuration-saved", "configuration": { "deviceId": "switch-1" } }
```

That check compares canonical structured snapshots. A submission with no
snapshot at all — every lab written before M10.9.1 — counts as saved, so the
check can never fail retroactively.

## The `.simlab` lab package

A learner saves **one file**:

```text
my-network.simlab
```

It is a ZIP container:

```text
manifest.json
lab.json
configs/
  R1-running.cfg
  R1-startup.cfg
  SW1-running.cfg
  SW1-startup.cfg
import-report.json        (optional)
```

`manifest.json` declares the format, the schema version, the title, the
document path, the configuration directory and one validation entry per
projection. It carries **no timestamp**, so the same lab always produces the
same bytes.

`lab.json` is the only source of truth. The `.cfg` files are projections
generated at export: they exist to be read, diffed and version-controlled, and
they are validated on import against the projections the document produces right
now. A mismatch is reported —

```text
Configuration projection differs from the canonical lab document.
```

— and the document wins. A hand-edited `.cfg` is never applied silently; the
device Configuration tab's Import / Paste flow is the explicit way to apply it.

Reading a package goes through the same archive guards as any untrusted upload:
ZIP-slip and absolute paths, symlinks, duplicate entries, the compression-ratio
and total-size bombs, the entry-count limit, and no nested archives. On top of
those, `SIMLAB_LIMITS` bounds the package size, the number of `.cfg` files, the
size of one `.cfg` and the size of `lab.json`. Nothing in a package is executed,
and no remote resource is ever fetched.

### File menu

| Action | Result |
| --- | --- |
| New Lab / Open Lab… / Close Lab | `Open Lab…` accepts `.simlab`, native `.json`, and external formats through the import wizard |
| Save Lab / Save Lab As… | Writes a `.simlab` package |
| Import External Lab… | The PNETLab/GNS3/CML/containerlab wizard |
| Export Device Configurations… | All devices as a ZIP of `.cfg`, or the selected device's running or startup configuration |
| Advanced ▸ Import / Export Lab JSON | The canonical JSON, for diagnostics and integration |

### Compatibility

Old `.json` labs open exactly as before. The API and the database keep storing
the structured `LabDocument` as JSONB, and the verifier contract is unchanged —
it never receives a ZIP. `.simlab` is a user-facing transport container, not a
second persistence format.

External PNETLab / GNS3 / CML configurations still convert one way: source text
→ structured configuration → SimulatorNet running and startup state. Whatever
the importer could not parse stays in the import report and never becomes an
active running configuration. Packet Tracer `.pkt` / `.pka` remain
recognised-but-unsupported.
