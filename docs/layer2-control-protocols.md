# Layer-2 control protocols

SimulatorNet models spanning tree and EtherChannel as **educational subsets**.
They are close enough to IEEE 802.1D/802.1w and to Cisco PVST+/PAgP that a
CCNA-level lab behaves the way a learner expects, and they are deliberately
*not* claimed to be vendor or RFC parity.

Everything on this page is deterministic: virtual time, a stable event queue,
configured priorities and stable identifiers. The browser worker and the server
verifier build the same lab independently and reach the same roots, port roles,
port states and bundles.

## The bounded protocol activity model

A control protocol must never schedule an endless stream of hello events —
`runUntilIdle()` would never return and Auto execution could not finish. Every
periodic protocol therefore runs inside a bounded **activity window**
(`ProtocolActivity`):

- it ticks while it has work to do;
- it goes quiescent a few periods after the last state change;
- any *stimulus* re-opens the window: a link transition, a configuration change,
  or a received PDU that actually changes state.

Steady-state PDUs that change nothing deliberately do **not** re-arm the window,
otherwise two neighbours would keep each other awake for ever.

Two consequences are worth knowing:

- **Timers that measure the absence of messages are only charged while the
  protocol is running.** A quiet stretch of virtual time never ages a spanning
  tree out from under you.
- **Auto always terminates.** So does a headless grading run.

Every protocol also charges a shared per-operation event budget
(`ControlProtocolBudget`). The worker resets it before each Auto/Step run and the
verifier resets it before each graded check, so one operation can never run away.

## Spanning tree (PVST / Rapid-PVST)

### What is modelled

| Feature | Status |
| --- | --- |
| 802.1D-like PVST (`spanning-tree mode pvst`) | yes |
| 802.1w-like Rapid-PVST (`spanning-tree mode rapid-pvst`) | yes |
| One instance per active VLAN | yes |
| Root/designated/alternate/backup/disabled roles | yes |
| disabled / blocking / listening / learning / forwarding | yes (802.1D) |
| disabled / discarding / learning / forwarding | yes (802.1w) |
| PortFast, BPDU Guard, error-disabled recovery | yes |
| Topology change with scoped FDB ageing | yes |
| MSTP and MST regions | **no** |
| Loop Guard, Root Guard, UDLD | **no** |
| UplinkFast, BackboneFast, Flex Links | **no** |

### Supported devices

L2 Switch and L3 Switch. Hub, Bridge, Router, PC, Server, Firewall, Cloud and
Traffic Generator do not participate; the Bridge could gain it in a later
milestone if its model grows a spanning-tree capability.

### Disabled by default

Spanning tree ships **disabled**. Enabling it globally would add a 30-second
forward delay and a different deterministic trace to every existing loop-free
lab. A redundant topology turns it on explicitly:

```
spanning-tree mode pvst
spanning-tree mode rapid-pvst
```

The Ethernet frame traversal budget stays in place as the last-resort protection
for a lab that deliberately leaves spanning tree off — it is a safety net, never
the normal loop-prevention mechanism.

### Bridge and port identifiers

- **Bridge ID** = configured priority + the VLAN extended system id + the stable
  bridge MAC (the lowest interface MAC on the device). Insertion order is never
  a hidden tie-breaker.
- **Port ID** = configured port priority + a stable port number derived from the
  sorted interface list.

Bridge priority must be a multiple of 4096 (0–61440); port priority a multiple of
16 (0–240).

### Election

Root bridge: lowest priority, then lowest MAC.

Root port: lowest root path cost, then lowest sender bridge ID, then lowest
sender port ID, then lowest local port ID.

Designated port: the superior priority vector on the segment wins; a port that
receives a better vector becomes *alternate* (from another bridge) or *backup*
(from this same bridge on another port).

### Link cost

SimulatorNet models a single Ethernet link speed, so every port starts from one
documented default cost of **4** (the Cisco Gigabit Ethernet value). Showing a
speed the engine does not simulate would be dishonest. `spanning-tree cost`
overrides it per port, and a later milestone that models speed profiles can
derive the default instead.

### Timers

Hello 2 s, max age 20 s, forward delay 15 s by default, all in virtual time.
`show spanning-tree` prints them in seconds; the lab document stores seconds and
the engine converts to nanoseconds. Semantic validation enforces the classic
relationships (max age ≥ 2 × (hello + 1), and 2 × (forward delay − 1) ≥ max age).

Rapid-PVST replaces the listening/learning waits with proposal/agreement on
point-to-point links, and an alternate port that becomes a root port may forward
at once when its peer already forwards towards the root.

### PortFast and BPDU Guard

`spanning-tree portfast` makes a port forward as soon as it is operationally up.
It is only an edge port until it has ever received a BPDU; after that it behaves
like any other port. `spanning-tree bpduguard enable` error-disables the port
instead.

Error-disabled state is **runtime**: it is never written to the lab document.
`errdisable recovery <interface>` (or the Reset action in the Spanning Tree tab)
clears it; the configured BPDU Guard setting is untouched.

### Topology change

A topology change is raised when a port leaves forwarding, or when a non-edge
port enters forwarding while another port in the same instance already forwards.
The switch then applies **scoped ageing**: it discards the learned addresses for
that VLAN only, not the whole forwarding database.

## EtherChannel (static, LACP, PAgP)

### What is modelled

| Feature | Status |
| --- | --- |
| Static `on` bundles | yes |
| LACP `active` / `passive` | yes |
| PAgP `desirable` / `auto` | yes |
| Logical `Port-channel<n>` interface with its own switchport | yes |
| Member compatibility validation and suspension | yes |
| Deterministic per-flow member selection | yes |
| Minimum links | yes |
| Layer-3 EtherChannel | **no** (layer 2 only in this release) |
| Multi-chassis (StackWise/VSS/vPC/MLAG) | **no** |
| LACP fast rate, configurable system priority | **no** |
| PAgP silent/non-silent modes | **no** |
| Speed/duplex negotiation | **no** |

### Negotiation rules

| Local | Partner | Result |
| --- | --- | --- |
| on | on | bundles, no negotiation |
| active | active or passive | bundles |
| passive | passive | never bundles — neither side speaks first |
| desirable | desirable or auto | bundles |
| auto | auto | never bundles — neither side speaks first |
| on | active/passive/desirable/auto | member suspended (`protocol-mismatch`) |

Only `active` and `desirable` members initiate; `passive` and `auto` answer a
received message. An initiating member never answers a reply, which is what lets
the exchange quiesce.

Member states follow the mux machine: `detached`, `waiting`, `attached`,
`collecting`, `distributing`, plus `suspended` for an incompatible member.

### Member compatibility

Members of one bundle must agree on their switchport mode, access VLAN, native
VLAN and allowed VLAN set. The bundle's signature comes from the `Port-channel`
interface when one was configured, otherwise from the first member.

**A member that was never configured on its own simply inherits the bundle.**
Only a member carrying its *own conflicting* switchport configuration is
suspended, and its stored configuration is never silently rewritten — the reason
is reported instead. Administrative state is not part of the signature: a shut
member simply detaches.

### Spanning tree and the data plane

Spanning tree sees a bundle as **one logical port**, so parallel members are
never mistaken for a loop. Member links are still tracked individually, and the
forwarding database learns addresses against the logical port, so
`show mac address-table` shows `Port-channel1`.

Frame distribution is a pure hash (FNV-1a) over the addresses the engine
actually models — source/destination MAC, plus source/destination IPv4 when the
frame carries it. One flow therefore always leaves through the same member and
frames are never reordered within a flow. `Math.random` is never involved.

### Failure

While at least one member is distributing (and `minimum-links` is satisfied) the
bundle stays up and future frames rehash onto the remaining members. When every
member fails the Port-channel goes down and spanning tree reconverges.

The topology always keeps the real physical cables; no fake link is invented for
a Port-channel.

## Resource limits

All limits live in `packages/sim-core/src/protocols/limits.ts` and are finite:

| Limit | Value |
| --- | --- |
| Spanning-tree instances per device | 128 |
| Spanning-tree instances per lab | 256 |
| Spanning-tree ports per instance | 64 |
| BPDU events per operation | 10,000 |
| Port transitions per port per operation | 128 |
| Topology changes per operation | 256 |
| Port-channels per device | 64 |
| Members per Port-channel | 8 |
| Aggregators per lab | 256 |
| Negotiation messages per operation | 10,000 |

See also [`neighbor-discovery.md`](neighbor-discovery.md) and
[`ospf-simulation.md`](ospf-simulation.md).
