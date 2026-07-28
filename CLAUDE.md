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
- browser theme, icon profile, execution mode, or layout preferences;
- ARP/MAC caches, DHCP leases, sockets, pending operations, or event queues;
- computed scores or hidden grading definitions.

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
`DEFAULT_IMPORT_LIMITS`.

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
