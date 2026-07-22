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
  contracts/   Shared types + zod schemas (topology, lab document, enums)
  sim-core/    Deterministic simulation engine (no DOM, no Node, no timers)
```

`apps/` (web, api, verifier) and the remaining packages (cli-engine, lab-format)
arrive in later milestones. `sim-core` is intentionally a pure,
zero-runtime-dependency package: no DOM, no Node APIs, no `Date.now()` /
`Math.random()` / `setTimeout`.

## Requirements

- Node.js 24 LTS (see `.nvmrc`)
- pnpm (via `corepack enable`)

## Getting started

```bash
pnpm install
pnpm test        # run the full test suite once
pnpm test:watch  # watch mode
pnpm typecheck   # type-check every package
```

## Milestone 1

Deterministic core with an L2 data plane: virtual clock, seeded PRNG,
event queue, Ethernet, MAC learning + flooding, ARP, IPv4, ICMP — proven by an
end-to-end PC↔switch↔PC ping and a determinism golden test.

## Milestone 2 (current)

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

## Milestone 3 (current)

A Cisco-like **CLI engine** (`packages/cli-engine`): a mode-aware console
session (user/privileged EXEC, global/interface/VLAN config) with a lexer,
pattern parser, per-mode command handlers, table formatters and typed errors.
The CLI contains no network logic — handlers only call public `sim-core`
methods (e.g. `switchport access vlan 10` → `switch.setAccessVlan(...)`), so the
same engine still grades headless. Includes golden transcript tests and an
end-to-end check that a router-on-a-stick configured entirely from the CLI
produces a working data plane.

Next: lab-format (load/save), then the apps (web / api / verifier).
