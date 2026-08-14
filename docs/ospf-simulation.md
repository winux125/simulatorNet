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
| Dijkstra SPF and intra-area routes | yes |
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

Retransmission is bounded **per LSA instance**, never per flood. A neighbour
that stops acknowledging stops costing repeat updates, but an advertisement the
neighbour has never been offered is not a retransmission: nothing here refreshes
an LSA periodically, so dropping it would leave a permanent hole. A newer
instance of the same LSA starts the count over.

SPF is a deterministic Dijkstra. Candidates are always taken in the same order —
total cost, then advertising router id, then the stable interface identifier — so
the same database always produces the same tree and the same next hops. `Map`
insertion order never affects the result. A run whose inputs are unchanged is
skipped, so `show ip ospf` counts real computations; the guard is a fingerprint
of the values the walk reads rather than a dirty flag, so it cannot hide a
change.

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
  acknowledgement, SPF start/completion and route installation as individual
  events. The Packet Trace `OSPF` filter isolates them.

Both use the same deterministic virtual time and reach the same result.

## Resource limits

| Limit | Value |
| --- | --- |
| OSPF routers per lab | 128 |
| Neighbours per device | 64 |
| Interfaces per device | 64 |
| LSAs per lab | 4,096 |
| LSA floods per operation | 20,000 |
| SPF runs per operation | 256 |
| Adjacency transitions per operation | 4,096 |
| OSPF protocol events per operation | 50,000 |

## Browser / verifier determinism

Nothing in the OSPF implementation reads the wall clock, uses `Math.random`, or
depends on unordered iteration. Given the same `LabDocument` and seed, the
browser worker and the headless verifier reach identical router ids,
adjacencies, DR/BDR results, link-state databases, SPF trees and routing tables.
Neighbour state, the LSDB, DR/BDR results, SPF results and learned routes are
runtime and are **never** written into a `LabDocument`.

See also [`layer2-control-protocols.md`](layer2-control-protocols.md) and
[`neighbor-discovery.md`](neighbor-discovery.md).
