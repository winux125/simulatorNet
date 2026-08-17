# OSPFv2 simulation

SimulatorNet implements a deterministic **OSPFv2 educational subset for IPv4**.
It is close enough to RFC 2328 that a CCNA-level single-area lab behaves the way
a learner expects, and it is deliberately not full RFC parity.

## Scope

| Feature | Status |
| --- | --- |
| One OSPF process per device | yes |
| Area 0 (backbone) only | yes |
| Broadcast and point-to-point Ethernet | yes |
| Hello / Dead timers, neighbour discovery | yes |
| DR/BDR election with a wait timer | yes |
| Full adjacency: ExStart → Exchange → Loading → Full | yes |
| Router LSA and Network LSA | yes |
| Reliable bounded flooding with acknowledgement | yes |
| Link State Retransmission List and RxmtInterval | yes |
| LSA ageing, `LSRefreshTime`, `MaxAge` flushing | **no** |
| Dijkstra SPF and intra-area routes | yes |
| Transit (Network LSA) subnets as routes | yes |
| Passive interfaces | yes |
| Configured and automatic router id | yes |
| Network statements and interface activation | yes |
| Link/interface failure reconvergence | yes |
| Multiple areas, ABR, ASBR | **no** |
| External LSAs, redistribution | **no** |
| NSSA, stub areas, summaries, virtual links | **no** |
| Authentication | **no** |
| OSPFv3 / IPv6 | **no** |
| ECMP (more than one best path) | **no** |
| Graceful restart, demand circuits | **no** |

## Supported devices

**Router** and **L3 Switch with `ip routing`**. The L3 switch runs the process
through the same composed routing plane it already uses for SVIs, routed ports,
ACLs and static routes. L2 Switch, Firewall, Cloud, Server and PC do not run
OSPF in this release; a non-zero area or an unsupported device produces a clear
typed error rather than a silent partial configuration.

## Loopback interfaces

`interface Loopback<n>` creates a logical interface with **no cable**:

- it has an administrative state and an IPv4 address;
- it produces a connected route;
- it takes part in router-id selection;
- it can be advertised into OSPF (normally as a passive interface);
- it is **not** a diagram connection point — the canvas cable handle ignores it.

## Router id

Selected in this order:

1. a configured `router-id`;
2. the highest active **loopback** IPv4 address;
3. the highest active non-loopback IPv4 address;
4. otherwise the process cannot start and says so in the Problems panel.

"Active" means up/up, exactly as on a real router: an interface with no cable
cannot supply a router id, but a loopback is always up unless it is shut down.

Once the process is running the router id is **frozen** until an explicit
`clear ip ospf process` (or the Restart action), which resets the runtime and
keeps the configuration.

## Activation

Two ways, with a clear precedence:

```
router ospf 1
 network 10.0.0.0 0.0.0.255 area 0
```

```
interface Gi0/0
 ip ospf 1 area 0
```

**Interface configuration wins.** `ip ospf … area 0` (or an explicit disable)
overrides whatever the network statements say. A wildcard must be a contiguous
mask and the statement must use the matching network address; semantic
validation rejects anything else.

## Packets and adjacency

Hello, Database Description, Link State Request, Link State Update and Link State
Acknowledgment are structured messages, never RFC bytes. They travel as IPv4
protocol 89 to 224.0.0.5 with their own multicast MAC.

**OSPF is terminated before the ACL and NAT pipeline.** A lab that is learning
about ACLs can never accidentally filter away its own adjacencies, and the
existing ACL/NAT/Firewall behaviour is untouched.

Neighbour states: `down`, `init`, `two-way`, `exstart`, `exchange`, `loading`,
`full`. Every transition is traced, so Step mode walks through them one by one.

An adjacency is refused, with the reason shown in Problems and in
`show ip ospf`, when the area, hello interval, dead interval, subnet mask or
network type disagree, when the neighbour claims our own router id, or when the
interface is passive. There is no authentication in this release, so it is never
a factor.

## DR/BDR

On a broadcast segment:

- a priority of 0 never takes part;
- the highest priority wins, with the higher router id as the tie-break;
- the election is **non-preemptive** — a better router joining later does not
  take over from a healthy DR;
- a **wait timer** of two hello intervals runs before the first election, so the
  result depends on the configured priorities and router ids rather than on
  whichever hello happened to arrive first;
- the DR originates the Network LSA for the segment.

A point-to-point segment has no DR or BDR and both ends become fully adjacent.

## LSDB and SPF

Router LSAs and Network LSAs carry a link-state id, advertising router, sequence
number, age derived from virtual time, a deterministic logical checksum over the
body, and their links or attached routers. A duplicate or older LSA is
suppressed.

The database description exchange runs *before* an adjacency reaches Full, so
the Router LSA and Network LSA the adjacency itself creates only exist
afterwards. A neighbour reaching Full is therefore handed the current database
once; duplicate suppression makes that idempotent, so nothing is re-flooded.
Without it a router that brings several segments up together leaves every later
neighbour permanently short of the earlier segments' Network LSAs, and SPF
cannot expand a transit segment whose Network LSA it does not hold.

SPF is a deterministic Dijkstra. Candidates are always taken in the same order —
total cost, then advertising router id, then the stable interface identifier — so
the same database always produces the same tree and the same next hops. `Map`
insertion order never affects the result.

## Reliable flooding

**A link is finite, so handing an update to an interface is not delivery.** The
frame is queued on the transmitting interface and clocked onto the wire at the
link's capacity, and the default egress queue holds 256 packets. A cold start
floods the fabric's whole database across every adjacency at once, so a large
area overruns that queue and part of the burst is tail-dropped — and the OSPF
sender is never told. It finds out because no acknowledgement arrives.

That is the whole design. OSPF is never special-cased inside the link queue, it
never receives synchronous knowledge that a packet was dropped, and it never
retries because it saw a drop.

### The retransmission list

Every advertisement offered to a neighbour is first written to that neighbour's
**Link State Retransmission List**. An entry holds the LSA key, the *instance*
identity — sequence and body checksum together, which is exactly what
`isNewer` compares — the virtual time of the first and the most recent
transmission, and how many transmissions the instance has had.

| Event | What happens to the entry |
| --- | --- |
| The advertisement is offered | the entry is created, or replaced if a newer instance supersedes it |
| An acknowledgement names the same instance | the entry is removed |
| An acknowledgement names an older instance | nothing: the newer one is still in flight |
| The neighbour sends the same instance back | implied acknowledgement, the entry is removed |
| A newer instance is originated | the entry is replaced and the count starts again |
| The database no longer holds the instance | the entry is dropped rather than re-sent |
| The adjacency falls below Exchange | the whole list is cleared |

A list is per neighbour and per instance, so one neighbour's acknowledgement can
never stand in for another's, and an acknowledgement never means "this
neighbour is up to date".

### The retransmission timer

`OSPF_RETRANSMISSION_INTERVAL_NS` is RFC 2328's **RxmtInterval**: five seconds
of virtual time. It is far longer than the milliseconds a flood wave takes to
clock out, so the retry meets an empty queue rather than the congestion that
caused the loss, and far shorter than the forty second dead interval, so a
recovered adjacency is never rebuilt.

When it fires, every instance still unacknowledged is offered again, ordered by
neighbour router id, then interface, then LSA key — so two runs of the same lab
emit the same packets in the same order.

Like the IPsec lifetimes, this keeps **no periodic timer**. A repeating event
would leave the deterministic queue permanently non-empty and `runUntilIdle()`
would never return. One event exists while at least one instance is
unacknowledged, and the walk re-arms only while entries remain, so a converged
area schedules nothing at all.

### The bound

Retransmissions are bounded **per LSA instance**, at three. Three retries span
fifteen virtual seconds, which stays inside the dead interval, and it is what
the supported 128-router area needs: the measured cold start loses its updates
in one burst and recovers every one of them on the first retry, so the remaining
two are headroom rather than the expected path.

When the bound is spent the instance is **reported**, never quietly forgotten:
a problem appears in `show ip ospf` and the Problems panel, and
`ospf-lsa-retransmission-exhausted` appears in the trace. The advertisement
itself stays in the database and the adjacency stays up — as on a real router,
where only the dead interval tears an adjacency down. That bound is also what
guarantees a neighbour which has stopped acknowledging cannot keep the
retransmission timer, and therefore the simulation, alive.

### Duplicates

A retransmitted advertisement the receiver already holds is **acknowledged
anyway** — that is what makes the sender's retry stop — while installing
nothing. It mutates no database, and because the input fingerprint is unchanged
it never even asks for an SPF walk.

### Batching

Reliable retransmission alone makes the area converge. It does not make the
burst smaller: the 128-router cold start still tail-dropped 1,472 packets and
paid a second Dijkstra walk on every router that had to wait for a retry, which
is 255 of the 256 walks the budget allows.

So a flood is **batched**. A Link State Update is conceptually a list of
advertisements, and registrations are collected and drained once rather than
sent one advertisement at a time. Because the batch is built from the
retransmission list itself, there is one place that decides what a neighbour
still owes us — no second mechanism, and no revision can disappear because a
batch was already scheduled. A registration that lands before the drain joins
that batch; one that lands after arms the next; a newer instance replaces the
entry and starts its own count.

A batch is bounded by `MAXIMUM_LSAS_PER_LINK_STATE_UPDATE` (64), so a large
area never builds one unbounded packet. The engine models an OSPF packet as a
fixed educational wire size rather than encoding RFC 2328 bytes, so a byte or
MTU bound would be vacuous here; a real implementation bounds by MTU instead.

`OSPF_FLOOD_BATCH_DELAY_NS` is deliberately **zero**. The drain runs at the same
virtual instant, after every event already queued there, so it batches a whole
wave without adding latency to a single hop. That was measured, not assumed: a
positive interval collapses the same fabrics to exactly the same packet count —
it buys nothing — while paying its cost once per hop, and at half a millisecond
a 128-hop chain no longer fits inside `OSPF_SPF_COALESCE_DELAY_NS` and needs a
second walk on every router. **Pacing here is batching, not delay**, and it is
never a substitute for the acknowledgement logic: correctness comes from
retransmission, and batching only bounds the load.

## SPF scheduling

One stimulus produces a *wave*. An interface comes up, an adjacency reaches
Full, the description exchange completes, and then every advertisement the
fabric holds arrives one link-state update at a time. Recomputing on each of
them rebuilds the same tree over and over, and because every router hears from
every other one the cost of a cold start grows with the **square** of the area.

Everything that can move the topology therefore goes through one request
function rather than starting a walk itself: a tick, an installed update, an
adjacency reaching Full or being lost, and a neighbour ageing out during
inspection. The schedule is deliberately three separate things:

| Step | What it is |
| --- | --- |
| **Request** | "the topology may have moved" — cheap, and there are many |
| **Scheduled event** | one deterministic virtual event, at most one outstanding |
| **Execution** | the actual Dijkstra walk — the only expensive step |

The first request schedules an event `OSPF_SPF_COALESCE_DELAY_NS` (100 ms of
virtual time) ahead. Every further request that arrives before it fires only
advances a revision counter; it never creates a second event. When the event
fires it snapshots the revision, walks once, and marks that revision complete —
so a change that lands *during* the walk is still outstanding afterwards and
schedules exactly one more event. That is what stops the coalescing from losing
an update the way the pre-M10.17.1 dirty flag did.

The delay is virtual, never wall-clock: no `setTimeout`, no `Date.now`, no
debounce. A flood wave settles in a few milliseconds of virtual time, so 100 ms
swallows a whole wave while staying far below the ten second hello interval, and
Auto and Step reach the same state at the same virtual time.

Two walks are skipped rather than performed:

- one whose **inputs are unchanged** would install the same routes. The guard is
  a fingerprint of the values the walk actually reads rather than a dirty flag,
  so it cannot hide a change;
- one over a database holding **nothing but this router's own advertisements**
  describes a tree of one vertex, so while the routing table is already empty it
  can only produce the empty result again. Every router passes through that
  state before the wait timer lets its first adjacency form.

`show ip ospf` counts executions, and so does `maximumSpfRunsPerOperation` —
never requests or coalescing events. Anything that reads the routing table or
the database first flushes a pending computation, so a reader never sees a tree
that lags the database it is shown.

The result is linear rather than quadratic. A cold start costs **one execution
per router** — 4, 8, 16, 32 and 64 routers spend exactly 4, 8, 16, 32 and 64 —
where before it cost 47, 191 and then more than the whole budget.

## Intra-area routes

The walk settles both kinds of vertex the database describes, and both produce
routes:

- a **router** vertex contributes its Router LSA's stub links — a loopback, a
  passive interface, and the subnet of a point-to-point segment;
- a **network** vertex contributes the transit segment itself.

The transit route is a route to the **subnet**, never to the designated
router's address. The prefix comes from the Network LSA: its link-state id is
the designated router's interface address and its mask is the segment's, so
`10.0.23.1` with `255.255.255.252` installs `10.0.23.0/30`. The metric is the
distance to the network vertex and the next hop is the first hop from the root
towards it.

This matters because a broadcast segment is described by a *transit* link and a
Network LSA rather than by a stub. Before, only stub links became routes, so the
subnet between two remote routers was in the database and took part in SPF —
routers behind it were reachable — while the subnet itself was missing from
every remote routing table. A point-to-point segment was unaffected, because
that model emits a stub link beside the neighbour link.

A segment the root is attached to is left to its connected route, which keeps
the better administrative distance; no duplicate or competing OSPF entry is
produced. A Network LSA may list any number of attached routers, and the route
depends on none of their order, the order advertisements arrived, or which
router won the election: vertices settle by cost then identifier, and an equal
cost is broken by the stable egress interface name.

When the segment stops being reachable — a link fails, an adjacency is lost, a
Network LSA is withdrawn, the designated router changes or the area splits — the
network vertex is no longer settled and the route is withdrawn, with
`ospf-route-withdrawn` in the trace. It returns on reconvergence.

## Route selection

OSPF installs routes with source `ospf` and administrative distance **110**.
The routing table picks, in order:

1. the longest prefix;
2. the lowest administrative distance (connected 0, static 1, OSPF 110);
3. the lowest metric;
4. a stable tie-break on next hop and egress interface name.

A prefix that is already connected or statically configured keeps its better
distance. When the LSDB changes so that a prefix is no longer reachable, the
route is withdrawn and `ospf-route-withdrawn` appears in the trace.

## Interface cost

`ip ospf cost <1-65535>`, default **10**. The engine does not model interface
bandwidth, so it never invents a cost from one — the value is explicit or the
documented default.

## Timers and the activity window

Hello 10 s and dead 40 s by default, in virtual time.

Like the other control protocols, OSPF runs inside a bounded activity window and
goes quiescent once it has converged. Because nobody sends hellos while the
process is quiescent, **a quiet stretch is not charged against any neighbour's
dead interval** — re-activating shifts each neighbour's last-hello stamp forward
by the idle duration. Only time during which the process was actually running
counts towards the dead timer, so a converged lab never collapses simply because
virtual time was advanced.

An interface going down tears its adjacencies down immediately: the local link
state is authoritative. A neighbour that stops answering while the local link
stays up is declared down when its dead interval really has expired, which is
evaluated on the next tick or the next inspection.

## Auto and Step

- **Auto** drains the bounded events until the protocol has converged.
- **Step** exposes Hello, each neighbour state change, LSA origination, flooding,
  retransmission, acknowledgement, SPF start/completion and route installation
  as individual events. The Packet Trace `OSPF` filter isolates them.

Both use the same deterministic virtual time and reach the same result.

## Resource limits

| Limit | Value |
| --- | --- |
| OSPF routers per lab | 128 |
| Neighbours per device | 64 |
| Interfaces per device | 64 |
| LSAs per lab | 4,096 |
| LSA floods per operation | 64,000 |
| SPF runs per operation | 256 |
| Adjacency transitions per operation | 4,096 |
| OSPF protocol events per operation | 96,000 |

An **SPF run** is one executed Dijkstra walk. A request that was coalesced into
a pending event, an event that found the fingerprint unchanged, and an event
over a database describing only this router are all free.

The two flooding bounds are measured rather than guessed, from the most
expensive supported shape at `maximumOspfRoutersPerLab`:

| 128-router cold start | Before M10.17.3 | After |
| --- | --- | --- |
| Packets queued | 112,982 | 6,344 |
| Tail drops | 1,472 | 0 |
| LSA offers (`lsaFloods`) | 59,593 | 48,895 |
| Protocol events (`ospfEvents`) | 226,420 | 11,672 |
| SPF executions | 128 | 128 |

An **LSA flood** is one advertisement offered to one neighbour, which is
inherently quadratic: 2N-1 advertisements across 2(N-1) directed adjacencies.
48,895 is identical on a fan-out tree of 2, 8 or 32 and on a 128-hop chain. A
*re-offer* is not counted, because an instance already on a neighbour's
retransmission list is never sent again by a later flood — that is what took the
figure down from 59,593.

An **OSPF protocol event** is one packet sent or received, so batching moves it
by more than an order of magnitude. The 11,672 above is a fan-out tree; the
bound is sized from the worst supported shape, a 128-hop chain that relays every
advertisement at every hop and measures **72,644**. Both budgets keep about a
third of headroom above their worst measurement.

That is deliberately a different judgement from the SPF budget. Repeated SPF was
**redundant** work — the same tree rebuilt from the same inputs — and was
removed rather than budgeted. Offering an advertisement to a neighbour that has
not seen it is work the protocol actually has to do, so it is budgeted instead.

## Supported convergence shape

`maximumOspfRoutersPerLab` is **128**, and since M10.17.3 that is what a single
area actually converges — not merely what a lab may describe — on the default
link model: no custom queue depth, no boosted capacity, no disabled loss model
and no static routes.

A 128-router connected area 0 reaches every adjacency Full, converges one
identical link-state database, installs the remote loopbacks and the remote
transit subnets, finishes `runUntilIdle()` and stays inside every OSPF bound.

**The contract is reliable convergence, not zero packet loss.** Before flooding
was made reliable, the same fabric tail-dropped 1,472 updates on the default
256-packet egress queue and left 127 of 128 routers permanently short, because
no timer ever offered a lost advertisement again. Transient drops are now
recovered by retransmission, so a lossy moment costs a retry rather than a
divergent area.

Beyond 128 routers, or on a shape whose busiest device exceeds
`maximumOspfNeighborsPerDevice`, a lab is outside the supported contract.

## What is still missing

Reliable flooding is deliberately **not** LSA ageing. This release still has no:

- **`LSRefreshTime`** — an advertisement is never re-originated every thirty
  minutes just because time passed;
- **`MaxAge` flushing** — an advertisement is never aged out of the database, and
  a `MaxAge` LSA is never flooded to withdraw one;
- **normal LSA ageing** — `age` is derived from virtual time on read and never
  drives a protocol decision.

Cold convergence belongs to reliable flooding, and that is where it is
implemented; a periodic refresh would have papered over the missing
retransmission rather than fixing it, and a repeating refresh event would leave
the deterministic queue permanently non-empty. Withdrawal is instead driven by
re-origination — a router that loses an adjacency re-issues its Router LSA
without that link — which covers every case a single-area lab can build.

## Browser / verifier determinism

Nothing in the OSPF implementation reads the wall clock, uses `Math.random`, or
depends on unordered iteration. Given the same `LabDocument` and seed, the
browser worker and the headless verifier reach identical router ids,
adjacencies, DR/BDR results, link-state databases, SPF trees and routing tables.
Neighbour state, the LSDB, DR/BDR results, SPF results and learned routes are
runtime and are **never** written into a `LabDocument`.

See also [`layer2-control-protocols.md`](layer2-control-protocols.md) and
[`neighbor-discovery.md`](neighbor-discovery.md).
