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

Wireless source kinds are mapped conservatively: an explicit AP becomes an
Access Point, a combined home/wireless gateway becomes a Wireless Router, a
laptop becomes a Laptop, and an unambiguous phone/tablet-like end device becomes
a Smartphone. Ambiguous appliances remain External Appliance placeholders.
Recognized plaintext wireless keys are converted immediately into an
SSID-scoped SimulatorNet verifier and the raw source line is redacted from the
report. Unsupported vendor hashes and enterprise security settings are never
reused; the report records **Credential Reset Required**.

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

## Control-protocol configuration (M10.4)

The IOS-like startup-config subset now also recognises:

| Command | Applied as |
| --- | --- |
| `spanning-tree mode pvst` / `rapid-pvst` | spanning-tree mode |
| `spanning-tree vlan <id> priority <n>` | per-VLAN bridge priority |
| `spanning-tree portfast` | PortFast on the interface |
| `spanning-tree bpduguard enable` | BPDU Guard (only together with PortFast) |
| `spanning-tree cost` / `port-priority` | per-port cost and priority |
| `channel-group <id> mode <mode>` | EtherChannel membership |
| `cdp run` / `no cdp run`, `cdp enable` / `no cdp enable` | CDP configuration |
| `lldp run` / `no lldp run`, `lldp transmit` / `receive` | LLDP configuration |
| `interface Loopback<n>` with `ip address`, `description`, `shutdown` | loopback interface |
| `router ospf <id>`, `router-id`, `network … area 0`, `passive-interface` | OSPF process |
| `ip ospf <id> area 0`, `ip ospf cost/priority/network/hello-interval/dead-interval` | OSPF interface configuration |

Deliberately **not** imported, and reported as unparsed rather than silently
applied: MST and MST regions, a non-zero OSPF area, OSPF authentication,
redistribution, other routing protocols (EIGRP, BGP, IS-IS), advanced
EtherChannel features and vendor-specific extensions. A firewall is not an OSPF
speaker in this release, so its OSPF lines are preserved and reported too.

Import safety is unchanged: nothing is executed, unknown lines are preserved as
bounded redacted artifacts, and every recognised-but-unsupported construct is
listed honestly in the import report.

## Management, AAA and SNMP configuration (M10.7)

The IOS-like management subset is imported into structured `LabDocument`
fields. Nothing is executed: lines are matched literally and converted.

Recognized:

- the L2 management SVI (`interface vlan <id>` with `ip address`, `shutdown` /
  `no shutdown`, `description`) and `ip default-gateway`;
- `username`, `enable secret`, and console `line` credentials;
- `ip domain-name`, `crypto key generate rsa`, `ip ssh version`;
- `line vty`, `login`, `login local`, `login authentication`,
  `authorization exec`, `transport input`, `exec-timeout`;
- `aaa new-model`, `aaa authentication login`, `aaa authorization exec`,
  `aaa authorization commands`, `aaa accounting exec`,
  `aaa accounting commands`;
- `radius server` and `tacacs server` blocks with `address`, `key` and
  `timeout`;
- `snmp-server community … ro`, `snmp-server location`, `snmp-server contact`,
  `snmp-server host … version 2c`, `snmp-server enable traps`.

Secret handling is the same as for console credentials:

- a plaintext line password, AAA key or SNMP community is converted into a
  scope-bound verifier and **removed from the preserved artifact**;
- a vendor password hash (type 5/7/8/9) cannot be verified, so no active
  credential is created and the device is flagged as needing a reset;
- a known default vendor password is never substituted automatically;
- an imported configuration never carries usable SSH key material — the
  simulated host key is derived when the lab is built.

Anything recognized as management configuration but deliberately not applied —
for example `aaa server radius dynamic-author`, a read-write SNMP community, or
an SNMP version other than 2c — is reported in the import report rather than
silently dropped. Read-write communities and SNMP SET are out of scope, so
importing one would imply a capability the simulator does not have.

## Quality-of-service configuration (M10.8)

The IOS-like MQC subset the importer recognises:

- \class-map [match-all|match-any] <name>\ with \match any\, \match dscp\,
  \match precedence\, \match cos\, \match protocol icmp|tcp|udp\ and
  \match access-group [name] <acl>\;
- \policy-map <name>\ with \class <name>\ and the actions \set dscp\,
  \set precedence\, \set cos\, \priority percent\, \andwidth percent\,
  \police <bps> <burst> [conform-action transmit] [exceed-action drop|set-dscp-transmit <dscp>]  and \shape average <bps>\;
- \service-policy input|output <policy-map>\ on a recognised interface.

Consistency is enforced rather than guessed: a policy class that names a class
map the file never defined is dropped, and a \service-policy\ that names a
missing policy map or an unmapped interface is not imported. Both cases stay in
the import report.

Unsupported advanced QoS lines — \andom-detect\, \air-queue\, \mls qos\,
hierarchical \service-policy\ inside a policy class, NBAR \match protocolapplication names, MPLS EXP and platform queue commands — are preserved in the
import report as unparsed rather than silently dropped, because applying them
would imply a capability SimulatorNet does not have.

## Site-to-site VPN configuration (M10.9)

The IOS-like subset the importer recognises:

- `interface Tunnel<n>` with `ip address`, `ipv6 address`, `description`,
  `shutdown` / `no shutdown`;
- `tunnel source <interface|address>` (an abbreviation is resolved against the
  interfaces the device actually has), `tunnel destination <address>`,
  `tunnel mode gre ip`, `tunnel mtu`, `tunnel ttl`;
- `tunnel protection ipsec profile <name>`;
- `crypto ikev2 proposal <name>` with `encryption` and `integrity` — a real
  vendor transform name is mapped to the nearest **simulated** one
  (`sim-aes128` / `sim-aes256`, `sim-sha256`), never accepted as if SimulatorNet
  implemented it;
- `crypto ikev2 peer <name>` with `address`, `proposal`, `lifetime` and
  `identity local|remote`;
- `crypto ipsec profile <name>` with `set ikev2-peer`, `set proposal` and
  `lifetime`.

**A vendor pre-shared key is never imported.** A plaintext key, a `key 6`
encrypted key and a password hash are all treated the same way: the
`pre-shared-key` line is recognised so it is not reported as unparsed, the key
itself is discarded, and the peer is flagged as needing a credential reset. The
learner sets a key explicitly before the tunnel can protect anything.

Consistency is enforced rather than guessed: a tunnel that names a profile the
file never defined loses the binding but keeps its other settings; a tunnel with
no destination, or whose source interface does not exist on the mapped device,
is dropped; and a peer or profile with an unresolvable proposal is not imported.
Every one of those stays in the import report.

Unsupported crypto — `crypto isakmp` policies and keys, `crypto map`, transform
sets, `crypto pki` trustpoints and certificates, IKEv1, `tunnel mode ipsec ipv4`
and any other tunnel mode, DMVPN/NHRP, GETVPN and NAT traversal — is preserved
as unparsed warnings rather than approximated, because applying it would imply a
capability SimulatorNet does not have. See [`vpn-tunnels.md`](vpn-tunnels.md).
