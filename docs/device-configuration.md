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
