# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open-source, browser-based network simulator for CCNA-level labs (a
Packet-Tracer-like tool). It is a **simulator, not an emulator**: switch/router/
protocol behaviour is reimplemented in TypeScript with a Cisco-*like* (not Cisco)
CLI. Interactive networking runs entirely in the browser (a Web Worker); the
server manages users/labs/results and re-runs the same engine headless to grade.

Only the deterministic core exists so far (`packages/contracts`, `packages/sim-core`).
The `apps/` (web, api, verifier) and CLI/router/VLAN/DHCP layers are planned but not built.

## Environment & commands

Node, pnpm and git run **inside WSL Ubuntu only** — they are not on the Windows
PATH. Node is 24 LTS via nvm, which is **not** auto-loaded by non-interactive
shells; prefix commands with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24`
when driving from outside an interactive WSL shell.

From the repo root (in a shell with Node 24 + pnpm):

```bash
pnpm install
pnpm test                                  # full Vitest suite (vitest run)
pnpm test:watch                            # watch mode
pnpm typecheck                             # tsc --noEmit per package (src only)

pnpm exec vitest run packages/sim-core/test/ping.test.ts   # one test file
pnpm exec vitest run -t "deterministic"                    # tests matching a name
```

If pnpm's pre-run deps check ever blocks a script, invoke tools directly to
bypass it: `./node_modules/.bin/vitest run`, `./node_modules/.bin/tsc`.

pnpm 11 blocks dependency build scripts by default; esbuild (needed by Vitest)
is approved via `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml`. A hook
re-injects a placeholder there when the file changes — set it back to `true`.

## Architecture

**Two packages, one shared engine.** `@sim/sim-core` is designed to run in two
places: the browser (in a Web Worker) and the server verifier (headless in Node).
Given identical topology, configuration, seed and input events, both must produce
**exactly** the same result — that is what makes server-side grading tamper-proof,
since the browser is never trusted to report its own score.

**Determinism is the load-bearing constraint.** `sim-core` is pure and
dependency-free: no DOM, no Node APIs, no `Date.now()` / `Math.random()` /
`setTimeout`. Instead:
- Time is a `VirtualClock` (integer nanoseconds), advanced only by the event queue.
- Randomness is `SeededRandom` (mulberry32). Never call `Math.random()`.
- Ordering is `EventQueue`, a min-heap keyed by `(time, insertion-sequence)`. The
  stable insertion-order tie-break is essential — same-instant events must run in
  the same order every run. Anything that breaks this breaks the verifier.

**Discrete-event model.** The single model of "the wire" is
`EthernetInterface.transmit()`, which schedules `peer.onReceive(frame)` after the
link's `propagationDelayNs` via `engine.scheduleIn`. Devices implement
`onReceive` and react synchronously (often scheduling further sends). There is no
threading; everything is cooperative events on one timeline. `engine.runUntilIdle()`
drains the queue; `advanceTo(t)` runs up to a time.

**Device model** (`src/devices/`): `Device` is the base (named interface map +
`engine` back-reference set by `engine.add`). `L2Switch` learns source MACs on
ingress, floods broadcast/unknown-unicast, and unicasts known destinations — one
flat broadcast domain (no VLAN/STP yet). `Pc` has a minimal IPv4 stack: ARP table
with a pending-packet queue, next-hop via subnet-or-gateway, and a per-sequence
ping table with timeouts. Trace a ping through `pc.ping` → `sendIpv4` → ARP →
`transmitIpv4` and the switch's `onReceive`/`flood` to understand the whole flow.

**Packets are plain discriminated-union objects, not byte buffers** (`src/packets/`),
tagged by `kind` (`EthernetFrame.payload` is `"arp" | "ipv4"`; `Ipv4Packet.payload`
is `"icmp"`). Correctness first; byte serialization / WASM can come later.

**`contracts` vs `sim-core`.** `@sim/contracts` holds the *serializable*,
vendor-neutral schemas validated with zod — `Topology` and `LabDocument` (topology
+ per-device config + seed) plus protocol/device enums and branded ids. These are
what the API/DB persist (as JSONB) and what the verifier reloads; live runtime
state lives only in `sim-core`. `LabDocument` deliberately stores no simulation
memory — everything is re-derived from topology + config + seed.

## Conventions

- ESM throughout with `verbatimModuleSyntax`: use `import type` for type-only
  imports (and inline `type` in mixed imports).
- `moduleResolution: "Bundler"`, extensionless relative imports. **No build step
  yet**: each package's `exports` points straight at `src/index.ts`, and
  `vitest.config.ts` also aliases `@sim/*` to those sources. `tsc` type-checks
  `src` only; test files are transpiled by Vitest (esbuild), not type-checked.
- `noUncheckedIndexedAccess` is on — indexed access is `T | undefined`; handle it.
- Time is integer nanoseconds; shared constants live in `src/engine/constants.ts`.
- Every protocol/behaviour ships with Vitest tests, including a golden
  determinism trace (`enableTrace()` → compare `engine.traceLog` across runs).
