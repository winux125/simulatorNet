# SimulatorNet

Open-source, browser-based network simulator for CCNA-level labs. Devices,
packets, protocols and CLI run entirely on the student's machine; the server
manages users, labs, assignments, results and integrations — no virtual
machines or vendor images.

This is a **simulator**, not an emulator: switch/router/protocol behaviour is
implemented directly in TypeScript with a Cisco-like (not Cisco) CLI.

## Why a shared core

The same deterministic engine (`@sim/sim-core`) runs in two places:

- in the browser (inside a Web Worker) for interactive labs;
- on the server (headless) to re-verify a submission and compute the grade.

Given identical topology, configuration, seed and input events, both must
produce **exactly** the same result. That is what makes server-side grading
tamper-proof — the browser is never trusted to report its own score.

## Monorepo layout

```
packages/
  contracts/   Shared types + Zod schemas (topology, lab and grading contracts)
  sim-core/    Deterministic simulation engine (no DOM, no Node, no timers)
  cli-engine/  Cisco-like CLI adapter over public sim-core methods
  lab-format/  Versioned validation, canonical JSON, rebuild and serialization
  sim-worker/  Typed worker protocol, runtime owner and browser client
  grading-core/ Pure deterministic checks, scoring, redaction and resource limits
  db/          Node-only PostgreSQL schema, migrations and tenant repositories
apps/
  web/         React/Vite browser simulator (React Flow + xterm.js)
  verifier/    Headless Node adapter and JSON fixture CLI
  api/         Minimal internal Fastify validation/verification API
```

`sim-core` and `grading-core` remain independent of Fastify, DOM and Node file
APIs. The deterministic engine has no `Date.now()` / `Math.random()` /
`setTimeout` simulation paths.

## Requirements

- Node.js 24 LTS (see `.nvmrc`)
- pnpm (via `corepack enable`)
- Docker with Compose (for PostgreSQL/Keycloak integration workflows)

## Getting started

```bash
pnpm install
pnpm dev         # start the browser simulator at http://127.0.0.1:4173
pnpm build       # production web + worker bundles
pnpm build:server # production verifier + API bundles
pnpm test        # run the full test suite once
pnpm test:watch  # watch mode
pnpm typecheck   # type-check every package
pnpm test:e2e    # run the Chromium browser vertical slice
pnpm dev:api     # start the internal API at http://127.0.0.1:3000
pnpm verify:fixture # run the deterministic verifier JSON fixture
pnpm db:migrate     # apply committed PostgreSQL migrations
pnpm db:seed:dev    # idempotently create the local development tenant
```

## Milestone 1

Deterministic core with an L2 data plane: virtual clock, seeded PRNG,
event queue, Ethernet, MAC learning + flooding, ARP, IPv4, ICMP — proven by an
end-to-end PC↔switch↔PC ping and a determinism golden test.

## Milestone 2

The full CCNA protocol layer in `sim-core`:

- **Router** — routed interfaces and dot1Q subinterfaces, connected + static
  routes resolved by longest-prefix match, per-router ARP, and IPv4/ICMP
  forwarding with TTL decrement plus net-unreachable / time-exceeded replies.
- **VLANs** — the L2 switch gained access/trunk ports, 802.1Q tagging, native
  VLAN and allowed-VLAN lists, with a per-VLAN forwarding database.
- **Router-on-a-stick** — inter-VLAN routing over a single tagged trunk.
- **DHCP** — a server (per-subnet pools) on the router and a DORA client on the
  PC.

Proven by 31 Vitest tests, including a router-on-a-stick determinism golden test.

## Milestone 3

A Cisco-like **CLI engine** (`packages/cli-engine`): a mode-aware console
session (user/privileged EXEC, global/interface/VLAN config) with a lexer,
pattern parser, per-mode command handlers, table formatters and typed errors.
The CLI contains no network logic — handlers only call public `sim-core`
methods (e.g. `switchport access vlan 10` → `switch.setAccessVlan(...)`), so the
same engine still grades headless. Includes golden transcript tests and an
end-to-end check that a router-on-a-stick configured entirely from the CLI
produces a working data plane.

## Milestone 4

The pure TypeScript **versioned lab format** (`packages/lab-format`) connects
contracts to the simulation core. Its public API is:

- `parseLabDocument` / `migrateLabDocument` for schema-versioned validation;
- `canonicalizeLabDocument` / `stringifyLabDocument` for stable JSON;
- `buildLabFromDocument` for a deterministic engine and typed device registry;
- `serializeLabDocument` for a structured snapshot of current configuration.

`LabDocument` stores topology, stable interface definitions, structured PC /
switch / router configuration and the simulation seed. It does **not** store
runtime state such as ARP or MAC tables, DHCP leases, packet queues, counters,
event queue, virtual time or trace. Those are re-derived by the engine after a
rebuild. Browser submissions use a separate `LabSubmissionDocument`; hidden
grading tests/specifications are server-only and never enter the browser lab
document.

## Milestone 5

The browser simulator vertical slice introduced the React Flow topology,
per-device xterm.js CLI, virtual-time controls, event trace and versioned JSON
import/export. The main thread owns only React, editor/UI state and plain JSON;
the module Web Worker remains the sole owner of the simulation engine, device
instances, CLI sessions, event queue, virtual clock and trace.

## Milestone 6

The vertical slice is now a professional, desktop-first network-lab workspace:

- a compact application bar, mode-aware tool rail and searchable device
  library surround a canvas that remains the primary surface;
- the resizable Inspector exposes Overview, Interfaces, Configuration and
  bounded Runtime views from typed worker snapshots;
- the resizable bottom dock contains independent Terminal, Events, Packet
  Trace and Problems views, including persistent tabs for multiple isolated
  CLI sessions;
- device, link and empty-canvas context menus expose only working actions;
- selected devices, link/port labels, topology status, pending edits and worker
  state are explicit and are not communicated by colour alone.

### Edit and Simulate

**Edit** enables device placement, drag/drop, links, deletion, duplication,
renaming and auto-arrange. Changes remain a draft and are marked visibly.
**Apply & Rebuild** serializes the current worker configuration, merges it with
the edited topology through `lab-format`, then performs the existing safe
worker rebuild. Moving back to **Simulate** therefore preserves CLI
configuration while deliberately resetting transient runtime state. Simulate
enables Run, Step, Pause, Reset, CLI commands and packet operations.

### Topology, terminals and keyboard

Click a device or link to inspect it; right-click a device to open its CLI or
Inspector. The terminal dock keeps one deterministic worker session per device
and supports switching, closing, copying and clearing without discarding other
open sessions. Useful shortcuts include `Ctrl/Cmd+O` for Import, `Ctrl/Cmd+S`
for Export, `Ctrl/Cmd+Enter` for Run until idle, `Ctrl/Cmd+K` for the command
palette, `Delete` for the selection, `F` for Fit, `Escape` to clear/close and
`?` for the shortcut reference. Shortcuts are suppressed while typing in
inputs or CLI.

The layout targets desktop lab work at 1440×900 and 1280×720 with no page
scrolling. Below 1000 px, the device library and Inspector become overlay
drawers; this milestone does not attempt a phone-optimised topology editor.

### M6 build notes

The requested official `frontend-skill` was not present in either the curated
Codex skill catalog or the available official experimental path, so no
third-party skill was installed; the redesign follows the milestone design
specification directly. New runtime dependencies are `lucide-react` and
`react-resizable-panels`.

Compared with the M5 production build, the eager application JavaScript fell
from 827.43 kB to 367.30 kB (108.83 kB gzip). Topology (186.83 kB), terminal
(338.63 kB), terminal-fit (1.20 kB) and bottom-dock (10.25 kB) code now loads in
separate chunks. CSS changed from 30.91 kB to 49.20 kB (9.53 kB gzip), and the
worker from 110.26 kB to 112.23 kB.

M1 through M6 are complete. The browser remains an untrusted grading
environment: a future headless server verifier will rebuild submissions and
grade them. No backend, authentication, database or grading evaluator is part
of M6.

## Milestone 6.1

The application now starts in a compact welcome workspace instead of loading a
laboratory implicitly. **New Lab** creates an empty deterministic schema-v1
document in Edit mode, **Import Lab** opens an existing JSON document, and
**Load Demo Lab** explicitly opens the router-on-a-stick fixture. Closing a lab
returns to the welcome state and asks for confirmation before discarding edits.

The engineering workspace supports persistent **System**, **Dark** and
**Light** themes. System follows `prefers-color-scheme`; the selected preference
is stored in `localStorage` and applied immediately through the root
`data-theme` attribute. Both palettes use shared semantic design tokens. The
light palette uses cool grey surfaces rather than pure white, while the dark
palette remains the primary visual reference. React Flow's minimap has been
removed; zoom, fit-to-view, panning and the dotted canvas remain available.

CLI parsing now distinguishes incomplete commands, invalid tokens and domain
validation failures. Incomplete commands include usage, syntax errors place a
caret under the first invalid token, and validation errors retain their direct
message. Mode- and device-aware help is available through `?`, `help`,
`ping ?` and `show ?`. Terminal tabs keep separate command histories, prompts
have consistent spacing, empty Enter produces a fresh prompt, clearing output
preserves the session, and output follows the latest line automatically.

M1 through M6.1 are complete. The browser remains an untrusted grading environment.

## Milestone 7 (current)

M7 adds a deterministic server verification boundary without adding storage,
identity or deployment concerns. The browser sends only a
`LabSubmissionDocument` containing topology, structured persistent
configuration and seed. `grading-core` validates it, creates a fresh
`LabDocument`, rebuilds the same `sim-core` engine through `lab-format`, resets
transient state by construction, performs deterministic DHCP/ping actions and
calculates points. Browser-provided scores, traces, ping results, ARP/MAC
caches, DHCP leases, event queues and virtual time are never trusted.

Hidden `GradingSpec` definitions are separate server-side contracts and are not
part of `LabDocument` or imported by the web application. Student results
redact hidden titles, expected values and diagnostics; instructor results add
bounded diagnostics without arbitrary stack traces. Verification IDs and core
results are stable for identical input.

### Supported grading checks

- routed or local `ping` success/failure;
- physical interface administrative state;
- switchport mode and optional access VLAN;
- VLAN existence;
- connected or static route existence;
- deterministic DHCP address membership in an IPv4 subnet.

No grading contract accepts JavaScript, regex, dynamic imports or network
callbacks.

### Resource limits

The central MVP envelope is 64 nodes, 128 links, 512 interfaces, 100 grading
checks, 50,000 processed virtual events, 60 seconds of simulated virtual time,
2,000 retained trace records and a 1,000,000-byte JSON payload. Limits are
checked before build where possible and during every verifier-driven event
step. Exceeding one produces a typed `resource-limit` error.

### Verifier CLI

The Node adapter owns file access and timing; grading business logic stays in
the pure package. Run the checked-in routed/DHCP fixture with:

```bash
pnpm --filter @simulatornet/verifier verify \
  --submission ./fixtures/submission.json \
  --grading ./fixtures/grading.json
```

It writes a structured JSON result to stdout and exits `0` after completed
verification, or writes a structured error to stderr and exits `1` for invalid
input or failed execution.

### Fastify API

`apps/api` uses Fastify 5 with Zod domain contracts, OpenAPI, request IDs,
Pino-backed Fastify logging, strict JSON content types, a body-size cap and
graceful `SIGINT`/`SIGTERM` shutdown. CORS is not registered and therefore is
disabled by default.

- `GET /health`
- `GET /ready`
- `GET /openapi.json`
- `POST /v1/labs/validate` — validate and return a canonical lab document;
- `POST /v1/verifications` — rebuild, run checks and return a server-calculated result.

Start it with `pnpm dev:api`; production bundles are created by
`pnpm build:server` and the API bundle runs with
`pnpm --filter @simulatornet/api start`.

> **Internal API warning:** `/v1/verifications` accepts a grading spec directly
> only for M7 development and integration. It must not be exposed publicly
> before M8 authentication and assignment-owned hidden-spec lookup. M7 has no
> users, organizations, roles, OAuth, persistence, queues or browser API client.

## Milestone 8.1 — PostgreSQL persistence

`@sim/db` is a Node-only persistence package built on PostgreSQL 18,
`node-postgres` and Drizzle. It owns the versioned SQL migrations and repository
boundary for organizations, users and identities, organization memberships,
integration clients, external-user links, one-time launch codes, browser
sessions and audit events. It does not import Fastify, HTTP middleware or the
simulation engine.

All tenant operations require a parsed `TenantContext` and include the
organization predicate in reads and mutations. Cross-tenant operations are
limited to the explicit platform-admin repository and narrow authentication
lookups that establish a tenant from an already verified credential. M8 does
not claim database-enforced RLS: the deployment has not yet introduced
separate restricted DB roles, `FORCE ROW LEVEL SECURITY`, or transaction-local
tenant settings. Application-level tenant predicates are covered against a
real database, including connection-pool reuse and cross-tenant read/update
attempts.

Launch codes and browser session tokens are 32 random bytes encoded as
base64url. Only their SHA-256 hashes are stored; plaintext credentials never
enter PostgreSQL or audit metadata. Code consumption is a single conditional
update, so expired/reused codes fail and concurrent exchanges have exactly one
winner.

Create `.env` from `.env.example`, then run:

```bash
pnpm db:generate       # generate a committed migration after a schema change
pnpm db:check          # validate migration history
pnpm db:migrate        # apply committed migrations (never drizzle push)
pnpm db:seed:dev       # safe, idempotent kai-dev development data
pnpm db:test:integration
```

The integration suite uses `packages/db/compose.test.yaml` and
`TEST_DATABASE_URL`. The development seed creates no passwords, client secrets,
tokens or production credentials.
