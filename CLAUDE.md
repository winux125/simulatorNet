# SimulatorNet Engineering Guide

This file is the primary repository guide for architecture, ownership, and
implementation constraints. Keep it current when a milestone changes those
boundaries. Product history belongs in `README.md`; detailed workflows belong
in `docs/`.

## Product model

SimulatorNet is a deterministic network **simulator**, not a virtual-machine
emulator. Protocol behavior is implemented in TypeScript and runs through the
same engine in two trust domains:

- the browser uses a Web Worker for interactive labs;
- the server verifier rebuilds a submitted lab and grades it independently.

The browser is not trusted for scores, traces, caches, leases, event results, or
hidden grading checks. The verifier accepts structured topology and
configuration, reconstructs runtime state, performs bounded deterministic
actions, and calculates the result itself.

## Runtime and commands

The supported toolchain is Node.js 24 LTS and pnpm. This workspace is developed
and tested inside WSL Ubuntu; run repository commands from the Linux checkout,
not against it through a Windows Node installation.

```bash
pnpm install
pnpm dev                 # web
pnpm dev:api             # Fastify API
pnpm build               # web production build
pnpm build:server        # API and verifier production builds
pnpm typecheck
pnpm test                # all Vitest projects
pnpm test:e2e            # Playwright
pnpm verify:fixture
```

Infrastructure and database commands:

```bash
cp .env.example .env
docker compose up -d db
docker compose up -d keycloak-db keycloak
docker compose up -d api
# or:
pnpm infra:up

pnpm db:generate
pnpm db:migrate
pnpm db:check
pnpm db:seed:dev
pnpm db:test:integration
pnpm smoke:m8
```

`docker compose up -d db`, `keycloak-db`, `keycloak`, and `api` are deliberately
independently runnable. Do not commit `.env`, credentials, tokens, generated
coverage, Playwright artifacts, build output, or local database data.

For the full PostgreSQL test suite, start the dedicated test database and
provide its URL:

```bash
docker compose -f packages/db/compose.test.yaml up -d --wait
export TEST_DATABASE_URL=postgresql://simulatornet:simulatornet_test_only@localhost:55432/simulatornet_test
pnpm test
```

Do not silently skip database tests in a quality gate.

## Monorepo map

### Applications

| Path | Responsibility |
| --- | --- |
| `apps/web` | React/Vite engineering workspace, AntV X6 topology, xterm terminal, browser worker client |
| `apps/verifier` | Headless Node adapter and fixture/CLI runner around grading-core |
| `apps/api` | Fastify HTTP boundary, authentication, validation, logging, academic APIs |

### Packages

| Path | Responsibility |
| --- | --- |
| `packages/contracts` | Serializable Zod schemas and shared domain types |
| `packages/sim-core` | Deterministic protocol engine, devices, services, transport, event queue |
| `packages/device-config` | Deterministic running/startup-config renderer, shared configuration-text parser, drift comparison |
| `packages/cli-engine` | Lexer, parser, contextual help, session state, command formatting |
| `packages/console-auth` | Device-console login, privilege session behavior, management credential verifiers |
| `packages/remote-management` | Simulated Telnet/SSH remote CLI, VTY lines, AAA decision layer |
| `packages/lab-format` | Canonical LabDocument parsing, migration, semantic validation, build/restore |
| `packages/sim-worker` | Typed browser-worker protocol, runtime ownership, UI-safe snapshots |
| `packages/grading-core` | Pure deterministic grading checks and resource limits |
| `packages/importers` | Safe one-way import detection, parsing, mapping, reports, and conversion |
| `packages/db` | Node-only schema, migrations, repositories, transactions, audit and seed data |
| `packages/authz` | Pure authorization policy evaluation |

Keep application business logic thin. If behavior must be identical in the
browser and verifier, it belongs in a reusable package.

## Dependency and ownership rules

### Contracts

Contracts contain serializable data only. Prefer discriminated unions and Zod
schemas at trust boundaries. Do not put engine instances, DOM objects, X6
objects, Fastify requests, file handles, or callbacks in shared contracts.

`LabDocument` is the canonical persisted domain model. It may contain topology,
structured device configuration, deterministic seed, metadata, positions, link
labels, and diagram annotations. It must not contain:

- X6 internal JSON;
- active selection or tool state;
- terminal tabs, history, or scrollback;
- browser theme, icon profile, execution mode, workspace view, or layout
  preferences;
- ARP/MAC caches, DHCP leases, sockets, pending operations, or event queues;
- computed scores or hidden grading definitions.

`LabDocument.startupConfigurations` is the saved startup snapshot per device. It
holds configuration only, never runtime state. An absent map — every lab written
before M10.9.1 — means startup equals running, so an older file opens without a
migration and without a false "unsaved" state.

### Simulation core

`sim-core` must remain deterministic and environment-neutral:

- no DOM, Fastify, database, Node file APIs, process globals, or network access;
- no `Date.now()`, wall-clock timers, `Math.random()`, or unordered iteration
  that affects behavior;
- use `VirtualClock`, the deterministic event queue, seeded randomness, stable
  identifiers, and explicit resource bounds;
- protocol results must be reproducible from canonical input and seed.

Both browser and verifier must reach protocol behavior through the same core.
Do not recreate protocol logic in React, Fastify handlers, or grading checks.

### Wireless simulation

Wi-Fi is a separate deterministic `WirelessMedium`, not an invisible Ethernet
cable and not a browser-network API. Radio reachability comes only from
structured radio domain, band, channel, enabled state, SSID, and explicit
preference. Canvas positions are presentation-only and never affect signal,
association, grading, or rebuilds.

Management messages and association transitions run through `VirtualClock` and
the bounded event queue. An associated station then exposes the existing
Ethernet/IP/transport stack through its wireless interface. A standalone Access
Point is only a wireless-to-Ethernet bridge; it never gains implicit routing,
DHCP, NAT, or firewall behavior. The Wireless Router composes existing bridge,
router, DHCP/DHCPv6, NAT/PAT, firewall, and wireless components rather than
copying them.

WPA2-Personal is an educational authentication model. Web Crypto derives an
SSID-scoped opaque verifier before packet/event processing; no plaintext key,
real 802.11 encryption, or async cryptography belongs in `sim-core`. Never log,
render, grade, or import raw credentials. See `docs/wireless-simulation.md`.

### Quality of service

A link has finite capacity. A frame is queued on the transmitting interface,
clocked onto the wire at that capacity (virtual serialization delay), then
propagated — all through `VirtualClock` and the bounded event queue. Each
direction owns its own egress queue. `estimatePacketWireSizeBytes` is the single
wire-size API; no protocol computes its own.

One reusable `QosPolicyEngine` serves Router, L3 Switch, Firewall and the
Wireless Router's composed routed plane. Do not add a second classifier, and do
not apply QoS to a Hub or Bridge. The output pipeline order is fixed:
route/policy decision → classification → marking → policing → shaping/queueing →
serialization → transmit; input is receive → classification/marking/policing →
ACL/NAT/routing.

Scheduling is strict priority followed by deficit round robin, ordered by the
policy map and never by packet insertion order. A priority class carries a
built-in policer so it cannot starve other queues. A policer never delays; a
shaper delays and only drops when its bounded queue is full. Both use one
deterministic token bucket driven by virtual time.

`LabDocument` stores link capacity, propagation delay, queue limit, class maps,
policy maps, marking, priority/bandwidth classes, policers, shapers and
service-policy bindings. It must never store queued packets, token counts, the
scheduler cursor, counters, drops or measured waiting times. Capacity is an
educational serialization model, never a hardware throughput claim.

A managed device window carries `QoS` as one capability-driven section under
`Config`; queue and counter inspection is also reachable from `Monitor`.
Overview, Classification, Policies, Interfaces and Queues & Counters remain
secondary navigation inside the reusable panel, an interface row opens its
detail in place, and no nested modal window is created. One `QosPanel` serves
Router, L3 Switch and Firewall; differences are declared as capabilities rather
than forked into near-identical components, and a device with no policy engine
gets no QoS section.
The selected section is UI state and never reaches `LabDocument`, a submission,
grading or the database. See `docs/qos-simulation.md`.

### Site-to-site VPN

A GRE tunnel is a **logical interface**, not a cable. `Tunnel<n>` has an
administrative state, IPv4/IPv6 overlay addresses, an MTU and a TTL, and it
produces connected overlay routes — but it never appears in the connection
modal, never anchors a canvas edge and never becomes a `topology.links` entry.
Router and Firewall terminate tunnels; an L3 Switch does not.

Overlay and underlay stay separate. The tunnel destination resolves in the
underlay routing table; the tunnel's own addresses produce the overlay routes
static routing and OSPF use. A tunnel is up only when it is admin up, its source
resolves to a usable local address, its destination has an underlay route that
does not egress a tunnel, and — when protected — an outbound SA is active. GRE
needs no handshake, so a missing peer is discovered only when traffic fails.
`estimateIpPacketSizeBytes` is the one IP-layer size API tunnel MTU uses;
an oversized packet is dropped and reported, never fragmented.

IKEv2 and ESP are a **deterministic educational model, not cryptography**.
There is no encryption, no key exchange, no certificate handling and no message
authentication code; the `sim-` transform names exist so that is unmistakable.
Web Crypto derives an opaque, fixed-scope pre-shared-key verifier *before* packet
processing — exactly like WPA2-PSK and the management plane — and only that
fingerprint crosses the simulated wire. A key never reaches sim-core, a trace,
`show running-config`, Problems, a log or a grading result.

IKE travels over ordinary simulated UDP 500, so an ACL genuinely blocks it. The
fixed pipeline is: GRE encapsulation → IPsec protection → outer underlay routing
→ ACL/Firewall/QoS → transmit; inbound is outer ACL/Firewall → SA lookup →
replay validation → unprotect → GRE decapsulation. A protected tunnel never
falls back to sending in the clear.

IPsec keeps **no periodic timer**: a repeating event would leave the deterministic
queue permanently non-empty and `runUntilIdle()` would never return. Lifetimes
are evaluated against `VirtualClock` whenever a protected packet, an inspection
or an explicit time advance looks, which produces the same deterministic rekey
with a bounded queue.

`LabDocument` stores tunnels, proposals, peers, key verifiers, profiles and the
tunnel→profile binding. It must never store IKE state, SAs, SPIs, sequence or
replay state, counters, rekey timers or peer reachability. A managed device
window carries one `VPN` section under `Config`, with runtime sessions reachable
from `Monitor`; Tunnels, IKE Peers, IPsec Profiles, Sessions and Counters remain
secondary navigation inside the reusable panel, as with QoS. A VPN
canvas overlay is derived presentation like a wireless association: never a
link, never a cable workflow. NAT-T is not modelled. See `docs/vpn-tunnels.md`.

### BGP and multi-AS routing

BGP is a control-plane process for Router and L3 Switch with `ip routing`;
Firewall and Cloud / ISP do not speak BGP. It uses the shared simulated TCP
stack on port 179, so reachability, ACL/firewall policy and link state remain
part of the session.

There is **one** BGP process, one FSM and one TCP session per neighbor; a
session carries several **address families** — `ipv4-unicast`, `ipv6-unicast`,
`vpnv4-unicast`, `vpnv6-unicast`. Only the RIBs are per family. Do not fork the
FSM, the policy engine or the best-path comparator for a new family. A neighbor
address may be IPv4 or IPv6, and an IPv6 peering depends on real IPv6
reachability, NDP, interface state, IPv6 ACLs and TCP/179 — never a direct call
between devices. IPv4 unicast stays implicit on an IPv4-transport neighbor so a
pre-M10.13 document is unchanged; every other family is activated explicitly.
An `ipv6 prefix-list` is prefix-only with the same `ge`/`le` window and never a
wildcard mask. Aggregation stays IPv4-only by decision, not by omission. Structured OPEN, KEEPALIVE, UPDATE and
NOTIFICATION messages run through a bounded activity window: Auto and verifier
execution must always drain, while explicit virtual-time advancement can expire
the Hold timer.

Keep raw Adj-RIB-In, policy-filtered Adj-RIB-In, Loc-RIB and Adj-RIB-Out
separate. The one routing-policy engine evaluates ordered prefix lists,
community lists, AS-path lists and route maps for both inbound and outbound
paths; no executable policy or unrestricted regular expression is allowed. An
AS-path pattern is parsed once into a structured matcher — an unsupported
pattern is reported, never stored or run. The documented stable best-path
comparator is the single selection implementation used by routing, UI and
grading.

A **route reflector** is the same BGP process, not a second protocol. It serves
IPv4 unicast and VPNv4, its cluster ID defaults to the BGP router ID, and a
client is only ever an iBGP neighbor. A client's path may go to anyone; a
non-client's path only to clients; a path never returns to the peer it came
from; a router with no clients keeps plain iBGP split horizon. Reflection stamps
`ORIGINATOR_ID` and prepends the local cluster ID to `CLUSTER_LIST`; a path is
rejected when either names this device or when the list exceeds its bound. A
reflector never rewrites `NEXT_HOP` — `next-hop-self` stays a separate policy.

**Standard communities** are canonical, deduplicated and sorted, so an
identical input yields an identical RIB. `no-advertise` blocks every peer,
`no-export` blocks only eBGP, and communities cross a session only with
`send-community`. They never change best-path selection by themselves. Standard
communities and VPNv4 route targets are separate attributes: `set community`
can never delete a route target.

An **aggregate** exists only while a contributing more-specific path does.
`summary-only` suppresses advertisements, never the Loc-RIB or the local
forwarding table. `default-originate` is per neighbor and is never installed
locally. Soft reevaluation re-runs policy without resetting TCP.

`LabDocument` stores the BGP process, peers, exact network statements (IPv4 and
IPv6), cluster ID, per-family activation and neighbor policy blocks,
route-reflector-client and send-community flags, default-originate, aggregates,
prefix lists, IPv6 prefix lists, community lists, AS-path lists, route maps and
bindings. It must never store TCP/FSM state, learned RIBs of any family,
`ORIGINATOR_ID` or `CLUSTER_LIST` state, reflected-route flags, communities
learned through BGP, aggregate contribution, suppressed routes, message
counters, policy counters or browser execution mode. The verifier rebuilds these from structured
configuration and ignores client-provided routes, trace and score. See
`docs/routing-bgp.md`.

### Management plane

Remote management is a real path through the simulated network. A Telnet or SSH
command travels over `sim-core` TCP — through routing, ACLs, NAT, firewall
policy and interface state — is authenticated, and is then executed by the same
`cli-engine` parser the local console uses. Never open a target device's CLI
directly to shortcut that path.

`packages/remote-management` owns the management-plane *behavior*; the matching
*configuration* lives on the device in `sim-core` beside ACLs and NAT, so
`lab-format` serializes it uniformly. `cli-engine` depends only on two small
structural interfaces the runtime injects, never on `remote-management`.

Simulated SSH is an educational model: a derived host-key fingerprint, no key
exchange, no encryption, no public-key authentication. Simulated Telnet has no
option negotiation and always warns that it carries credentials in the clear.
RADIUS, TACACS+ and SNMPv2c are protocol models, not implementations.

A credential must be comparable inside the synchronous deterministic engine, so
— exactly like WPA2-PSK — Web Crypto derives an opaque, scope-bound verifier
*before* packet processing and only that fingerprint crosses the simulated wire.
No plaintext password, shared key or community string may reach `sim-core`, a
trace, Problems, a log, `show` output or a grading result. There is exactly one
local-user database per device, shared by console, VTY, Telnet, SSH and the AAA
`local` method.

An AAA method list stops at the first conclusive result: accept succeeds, an
explicit reject fails, and only an unavailable method falls through. A denied
command is never executed. An L2 Switch management SVI terminates management
traffic and never enables routing or forwards transit packets. See
`docs/remote-management.md`, `docs/aaa-simulation.md` and
`docs/snmp-management.md`.

### Device configuration

Structured `DeviceConfig` is the single source of truth. Configuration text is a
*projection* of it, produced by the one renderer in `device-config`; there is no
second copy that can drift. `show running-config`, a `.cfg` file and a Compare
view are the same bytes.

The startup configuration is a separate **structured** snapshot, never a stored
string. Drift is computed from canonical structured snapshots, so a renderer
change can never turn a saved device into a modified one. A rendered
configuration never contains runtime state and never contains credential
material: a password, key, community string, passphrase, verifier, salt, hash or
fingerprint renders as `<configured>` and nothing else.

`reload` replaces exactly one device instance: its cables come back with their
exact performance, its runtime state and sessions are gone, and it boots from
its startup snapshot — or factory defaults after `erase startup-config`. The
topology is not rebuilt and no other device is disturbed.

Text becomes configuration only through
`inspectDeviceConfigurationText` → `applyDeviceConfigurationPlan`: preview with
line numbers, then an atomic apply. Nothing is replayed through an interactive
terminal, unsupported lines are never applied silently, and settings the parser
does not read are carried over rather than erased. A PC, laptop, smartphone,
hub or traffic generator has no configuration file and is never dressed up as a
Cisco appliance.

`.simlab` is the user-facing container: a ZIP with `manifest.json`, the
canonical `lab.json` and `configs/*.cfg` projections. `lab.json` always wins; a
hand-edited projection is reported, never applied. It reuses the importer's
archive guards and adds its own bounds. JSON stays the internal model, reachable
only through File ▸ Advanced. The database and the verifier contract are
unchanged. See `docs/device-configuration.md`.

### Browser worker

The Web Worker owns the live engine, device instances, CLI sessions, virtual
clock, event queue, traces, caches, leases, and runtime operations. React sends
typed requests through `sim-worker`; the main thread must never mutate an
`EndHost` or another engine object directly.

UI state may optimistically present a requested configuration only when the
worker protocol defines and confirms that operation. Structural topology
changes are built through `lab-format`, not by patching a live graph-shaped
object.

### CLI

`cli-engine` owns parsing, modes, contextual help, command errors, prompts, and
formatting. Protocol execution is delegated to device/runtime capabilities.
Keep incomplete syntax, invalid tokens, and domain validation failures as
separate typed outcomes.

Terminal histories and prompts are isolated per device session. Clearing a
terminal clears presentation, not the underlying CLI session.

### Verifier and grading

`grading-core` is pure TypeScript and may depend on contracts, lab-format, and
the simulation engine. It must not import Fastify, database packages, DOM APIs,
Node file APIs, arbitrary modules supplied by a submission, or network clients.
No `eval`, user-authored JavaScript, or unbounded regular expressions.

`apps/verifier` owns Node-specific fixture loading, duration measurement, CLI
exit behavior, and the adapter seam that can later move to a worker/queue.
`apps/api` owns HTTP concerns and calls the verifier layer; it contains no
network-protocol simulation logic.

Hidden grading specs stay server-side. Student results redact hidden expected
values and internal diagnostics. Instructor results may include bounded,
sanitized diagnostics, never secrets or arbitrary stack traces.

### Database and authorization

`packages/db` is Node-only. Tenant-aware repository methods and transactions
must enforce organization/assignment ownership rather than relying on callers
to remember filters. Schema changes require migrations and integration tests.

`authz` stays pure and testable. Authentication verifies identity; authorization
decides whether that identity may perform an action. Do not mix those concerns
into simulation packages.

### Importers

Imports are untrusted, one-way conversions into `LabDocument`. Detection,
parsing, inspection, mapping, and execution must use centralized
`DEFAULT_IMPORT_LIMITS`. The package also owns the *native* `.simlab`
container, because that is where archive safety lives: reading our own package
goes through the same guards as any untrusted upload.

- never execute imported scripts, vendor binaries, or appliance images;
- never fetch remote resources;
- reject unsafe archive paths, nested archives, expansion bombs, excessive
  XML/YAML depth, nodes, aliases, or topology size;
- preserve supported configuration as structured data and bounded redacted
  artifacts;
- never preserve plaintext passwords or vendor password hashes;
- report partial mappings and ignored content honestly.

See `docs/import-compatibility.md`.

## Web workspace architecture

### Topology and X6

`TopologyGraphController` is the sole imperative owner of the X6 graph,
rendering, ports, transforms, event subscriptions, and graph disposal. React
owns domain state and passes explicit updates to the controller.

Topology links retain domain node/interface identifiers. A responsive redraw
may re-anchor visuals, but it must never swap, infer, or mutate semantic
endpoints. Persist only canonical domain data through `lab-format`.

Runtime wireless-association overlays are dashed presentation edges derived
from worker state. They have no X6 port identity, never enter
`LabDocument.topology.links`, never open the cable modal, and never trigger
Apply Topology.

The canvas owns exactly one viewport: one graph translation and one graph
scale. Do not add an X6 Scroller, an inner canvas scrollbar, or a second
panning system beside it. All wheel heuristics belong to the central classifier
in `features/topology/canvas-navigation.ts`, never to React components. Wheel
listeners are bound to the canvas container, never to `document`. Pan and zoom
are local workspace state and must never enter `LabDocument` or grading. See
`docs/canvas-navigation.md`.

Connection creation is device-first:

1. drag the single device cable handle;
2. drop on a valid target device;
3. choose connection type and endpoint interfaces in the modal;
4. commit the resulting domain link.

The cable handle is the only visual connection control. Interface ports remain
internally — they carry the exact source/target interface identity an edge
anchors to — but they are invisible, non-magnetic anchor geometry configured
centrally in the port registry. Do not render port dots, magnets or hover
markers in any icon profile, do not offer a direct port-to-port drag UI, and do
not hide ports with `display: none`. Port Labels show interface names and are
not connection points. Link semantics always come from the domain document.

### Change-impact model

Every edit must be classified before implementation:

| Impact | Examples | While running |
| --- | --- | --- |
| Presentation | positions, labels, annotations, icon profile | allowed; no rebuild |
| Device configuration | host IP, CLI configuration, services | typed worker request; no physical rebuild |
| Structural topology | add/delete device, connect/reconnect/delete link | blocked until stopped, then rebuilt |

Presentation undo/redo must not roll back network configuration that changed
after the history entry. The diagram editor keeps a bounded 150-entry history
and rebases configuration across that history.

Deleting a stopped device must close only its own terminal tab and device
window, clear matching selection, remove its links and stale session IDs, and
never send a later worker request to the deleted ID. Other device sessions stay
open.

### Physical workspace

One lab has two representations. **Logical** is the topology canvas; **Physical**
is where the equipment sits: Sites → Rooms → Racks. The switch is its own
control and is never mixed with Edit/Operate or Auto/Step. Which view is open is
local workspace state.

`LabDocument.physical` is optional presentation metadata beside `diagram`. A
placement never changes DeviceType, interfaces, links, routing, wireless signal,
latency, QoS, grading or the runtime, so it shows no Apply Topology, triggers no
rebuild, clears no ARP/TCP/trace, and stays editable while the lab runs. Room
coordinates never reach `WirelessMedium`.

A rack unit holds exactly one device and a collision is rejected, never
displaced. `rackUnitSpan` (1-4 U) is drawing height only: no power, cooling,
weight, real dimension, cable length, patch panel, PDU or cable capacity is
modelled, and no invented value is shown. Being Unplaced is normal and never
blocks Start Lab. Room background images reference `diagram.assets`, so they
reuse the validated PNG/JPEG/WebP rules rather than adding a second image path.
Show Connections is an overlay over existing `topology.links`; no physical
connection object exists. Importers never derive rack placement from logical
coordinates. See `docs/physical-workspace.md`.

### Diagram editor

Diagram annotations are domain objects rendered by X6. Text is plain text, not
HTML. Raster images are limited to validated PNG, JPEG, or WebP data; SVG,
remote URLs, embedded scripts, and executable content are rejected. See
`docs/diagram-editor.md`.

Ordinary diagram text is edited inline on the canvas — never in a modal window.
The editor is an absolutely positioned overlay that follows the graph transform;
pasting reads `text/plain` only, and no diagram path may use
`dangerouslySetInnerHTML` or `innerHTML`. One edit session produces exactly one
document-history entry.

Diagram data is presentation-only unless a grading spec explicitly checks
topology structure. The standard grading submission intentionally excludes it.

### Terminal workspace

There is one shared terminal workspace with Docked, Floating, and Maximized
presentations. Moving between them must preserve the same tabs and mounted
sessions: authentication state, current input, command history, scrollback,
search, and xterm instances must not restart.

Device windows only launch or focus the shared terminal. Do not mount a second
terminal inside a device window. See `docs/terminal-experience.md`.

Clipboard paste reaches the CLI through the browser paste event on the terminal
container — never a document-level clipboard listener and never a separate HTML
command input. Pasted text is sanitized and bounded by `TERMINAL_PASTE_LIMITS`
before it becomes input. Text without a line break is inserted at the caret and
waits for `Enter`; text with line breaks is merged into the input line and
executed line by line through the ordinary CLI session, never by calling domain
APIs directly. A pasted sequence must pause at any interactive or credential
prompt rather than answer it. Credential input is never echoed, recorded in
history, written to the transcript or Problems, or logged.

### Bottom panel

The bottom panel is `expanded`, `minimized`, or `hidden`. Minimized renders only
a compact tab strip; hidden renders no row at all — never an invisible resizer,
a stale border, or reserved height. Both states are display changes: terminal
tabs, CLI sessions, input buffers, history, scrollback, pending pastes, event
data and filters must survive them, and only closing a tab ends a session.
Panel state is independent of the terminal presentation mode, is local-only
(`simulatornet.bottomPanelState`, `simulatornet.bottomPanelExpandedHeight`), and
never enters `LabDocument`, a submission, grading, or the database. Do not fit
xterm while the panel gives it no measurable size, and do not force the panel
open without a user action. See `docs/workspace-layout.md`.

### Layout and overflow

The application shell owns the viewport. The browser body must not become the
workspace scroll container. Fixed work areas clip overflow; the narrow content
that needs scrolling owns it explicitly:

- inspector content;
- import-wizard body;
- device-window content;
- terminal/xterm viewport;
- tables and menus where appropriate.

Do not fix overflow by adding broad `overflow: auto` to ancestors; that creates
double scrollbars, clipped controls, and incorrect X6/xterm measurements.

At narrow widths, side panels become overlays/drawers so the topology remains
usable. `ResizeObserver`-driven graph and terminal fitting must be bounded and
must clean up observers and animation frames. See `docs/workspace-layout.md`.

### Packet execution

Visible terminology is **Auto** and **Step**:

- Auto drains the bounded deterministic events needed to complete an operation;
- Step queues events for inspection, processes one event at a time, or drains
  them with Run All.

Both use deterministic virtual time. They are not performance speeds and Auto
is not wall-clock realtime. Browser execution mode is local workspace state and
the verifier ignores it.

### MPLS and Layer 3 VPN boundary

MPLS, LDP and VRF/L3VPN are Router-only capabilities. MPLS endpoints remain
ordinary physical topology links; labels and logical VPN relations never
become cables. The global RIB and every VRF RIB are explicit routing contexts.
P routers must not learn customer prefixes. LDP distributes only connected and
OSPF core FECs; MP-BGP distributes customer VPNv4/VPNv6 NLRI with RD/RT and a
deterministic label.

An MPLS payload is `IPv4Packet | IPv6Packet`. There is one forwarding engine and
one LFIB — do not add an MPLSv6 engine. The LDP core stays IPv4: PE/P loopbacks
and every FEC are IPv4, and the outer transport label resolves the remote PE's
IPv4 loopback while the inner payload may be IPv6. A P router reads its LFIB
only; it performs no customer IPv6 lookup and holds no customer IPv6 route.

Each VRF carries a separate IPv6 table behind an explicit `address-family
ipv6`. Every lookup takes an explicit `RoutingContext` and there is **no**
fallback from a missing VRF route to the global IPv6 table. Overlapping IPv6
prefixes across VRFs are legal; duplicates inside one VRF are not. A VPN label
is allocated **per VRF and address family**, so IPv4 and IPv6 delivery are
explicitly separate; the VPNv6 transport next hop is the PE's IPv4 loopback, a
documented educational simplification. Manual inter-VRF leaking is not modelled.

Persist only configuration: MPLS-enabled interfaces, LDP router-ID source,
VRF/RD/RT, VRF membership, IPv4 and IPv6 VRF static routes, the VRF IPv6
address-family flag, redistribution flags and VPNv4/VPNv6 neighbor settings.
LFIB, LDP state/bindings, VPNv4/VPNv6 RIBs, allocated labels and NDP state are
runtime-only and are rebuilt by both browser worker and verifier. See
`docs/mpls-l3vpn.md`.

### VXLAN and EVPN Layer 2 overlays

A VXLAN tunnel is a **logical overlay, not a cable**. `nve1` has an
administrative state, an IPv4 source Loopback and VLAN-to-VNI members — but it
never appears in the connection modal, never anchors a canvas edge and never
becomes a `topology.links` entry. The canvas overlay is derived presentation,
exactly like a wireless association.

The VTEP capability belongs to the **L3 Switch alone**. A Router is the underlay
and may be a BGP EVPN Route Reflector, but is never a VTEP; an L2 Switch stays an
access/aggregation switch. A reflector carries and reflects EVPN routes without
holding an overlay or a tenant MAC.

The outer transport is the ordinary simulated UDP stack on port 4789, so an ACL,
the firewall, QoS, interface state and packet loss all apply to the overlay.
`estimateVxlanOuterSizeBytes` is the one size API; an outer packet over the
underlay MTU is dropped and reported, never fragmented. A peer needs an underlay
route that does not egress the overlay, so no recursive route can form. One VLAN
maps to at most one VNI and one VNI to at most one VLAN; VNI 0 is always
rejected.

BUM traffic is replicated head-end, in stable address order and bounded per
operation. A frame that arrived from a remote VTEP is never re-encapsulated
towards another: the runtime `FrameOrigin` is simulator metadata, not an Ethernet
field, and it is what stops an overlay loop.

**EVPN is an address family on the existing BGP process** — `l2vpn-evpn`. Do not
fork the FSM, the TCP session, the policy engine or the best-path comparator;
only the RIBs are per family. Type 3 advertises VTEP membership and builds
head-end replication before any traffic; Type 2 advertises one locally learned
MAC, never a remote-learned one. A route is imported only when its route targets
intersect a local VNI's import list, and route targets cross a session only with
`send-community extended`. A Type 3 route is keyed by its originating VTEP, not
by RD alone, because two leaves normally share one RD. On a `bgp-evpn` VNI the
remote MAC table is control-plane owned, so a withdrawal genuinely removes an
entry. A duplicate MAC resolves through the one documented comparator, never by
arrival order.

`LabDocument` stores the NVE block, the source Loopback, VLAN-to-VNI mappings,
static peers, the replication mode, per-VNI RD and import/export route targets,
and the neighbor's EVPN activation and extended-community flags — all optional,
so a pre-M10.14 lab opens unchanged. It must never store the remote MAC table,
learned Type 2/3 routes, VTEP membership, BUM replication state, VXLAN counters
or the EVPN RIB; the browser worker and the verifier rebuild every one of them.

A managed L3 Switch window carries one `VXLAN & EVPN` section under `Config`,
with runtime tables reachable from `Monitor`; the secondary navigation stays
inside the reusable panel, as with QoS and VPN, and the selected section never
reaches `LabDocument`, a submission, grading or the database. L3VNI, IRB,
Anycast Gateway, Route Types 1/4/5, ESI/multihoming, multicast underlay,
ARP/ND suppression, EVPN over MPLS and EVPN-VPWS are not modelled. See
`docs/vxlan-evpn.md`.

## TypeScript and code conventions

- ESM packages use explicit, acyclic boundaries.
- With `verbatimModuleSyntax`, use `import type` for type-only imports.
- Avoid `any`; narrow unknown data at boundaries.
- Prefer pure functions and immutable domain updates.
- Keep stable canonical ordering by ID where serialization is observable.
- Errors crossing package or API boundaries must be typed and structured.
- UI colors, spacing, typography, radii, and elevations use design tokens.
- Assets are local, original or documented, and have provenance in
  `docs/assets.md`.

## Testing expectations

Changes should be verified in proportion to their risk:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:server
pnpm test:e2e
pnpm verify:fixture
```

Also check, when relevant:

- lab-format canonical round-trip and stable ordering;
- browser/verifier deterministic equivalence;
- resource and event limits;
- PostgreSQL integration tests with a real test database;
- responsive layouts and light/dark screenshots;
- imported asset provenance and archive safety;
- no hidden grading imports from browser packages;
- no Fastify imports from grading-core;
- no NUL/binary source files, secrets, debug artifacts, or generated output.

Playwright milestone flows must run; do not leave them skipped merely because
infrastructure was not started.

## Repository workflow

- Read `git status`, recent history, and relevant tests before editing.
- Preserve unrelated user changes. Do not apply existing stashes automatically.
- Use small, milestone-scoped atomic commits with the requested message.
- Review the complete staged diff before each commit and confirm the worktree is
  clean afterward.
- Do not begin a later milestone unless the user explicitly requests it.
