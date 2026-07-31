# Deterministic Quality of Service

SimulatorNet models deterministic educational QoS behaviour.
It does not benchmark real network hardware or reproduce vendor ASIC queues.

Everything on this page runs on `VirtualClock` and the bounded deterministic
event queue. There is no wall-clock timer, no throughput measurement, no
browser performance timing and no `Math.random()` anywhere in the path, so the
browser worker and the server verifier observe the same queues, drops, marks
and delivery order for the same document and seed.

## Link capacity and serialization delay

Before M10.8 a link handed a frame to the far end after a propagation delay.
A link now has structured performance configuration:

| Field | Default | Meaning |
| --- | --- | --- |
| `capacityBps` | 100 Mbps | How fast bits clock onto the wire |
| `propagationDelayNs` | 500 µs | Time on the wire, after serialization |
| `queueLimitPackets` | 256 | Tail-drop depth of one egress direction |

A packet now travels:

```text
device egress
→ output queue (classified, possibly policed and shaped)
→ serialization delay        (packet bits ÷ link capacity)
→ link propagation latency
→ receiving interface
```

Serialization delay is `ceil(bytes × 8 × 10⁹ ÷ capacityBps)` virtual
nanoseconds, clamped so it is never zero, negative, `NaN` or unbounded. The
one-nanosecond floor is what guarantees a bounded queue always drains in a
bounded number of events.

Every direction of a link owns its own queue on the transmitting interface, so
A→B never blocks B→A on a full-duplex link.

### Wire size

`estimatePacketWireSizeBytes(frame)` is the single wire-size API. It sums the
Ethernet header and FCS, one 802.1Q tag when the frame is tagged, the IPv4 or
IPv6 header, the transport header and the payload, then clamps the result
between the 64-byte minimum frame and a bounded maximum. Application payloads
report their explicit `payloadBytes` when they have one, their string length
when the data is a string, and a bounded default otherwise. No protocol
computes its own size.

### Queue lifecycle

Interface shutdown, link removal, device removal and Stop Lab all follow one
documented rule: **queued packets are dropped**, with a typed reason, and the
runtime is cleared. A packet is never delivered late onto a topology that has
already changed. Reasons are reported separately: `tail-drop`, `queue-limit`,
`interface-down`, `link-removed`, `runtime-cleared`, `resource-limit`,
`policer-exceed`, `shaper-limit`.

Queue depth, byte counts, drop counters, token levels, the scheduler cursor and
measured waiting times are **runtime only**. They never enter a `LabDocument`,
a submission or a grading result.

## Classification

One reusable `QosPolicyEngine` serves Router, L3 Switch, Firewall and the
Wireless Router's composed routed plane. There is no second classifier.

A `class-map` is `match-all` or `match-any` over a closed structural set of
match rules — no regular expressions and no executable matchers:

- IPv4 standard/extended ACL and IPv6 ACL, evaluated as read-only selectors;
- protocol `icmp` / `tcp` / `udp`;
- source and destination port;
- DSCP, IP precedence, 802.1p CoS;
- source and destination prefix, for both families;
- a Traffic Generator flow id — **internal test metadata only**, deliberately
  not part of the Cisco-like CLI, because a real router cannot see which tool
  sent a packet.

Policy classes are evaluated in their configured order; anything unmatched
falls to `class-default`.

Hub and Bridge never carry QoS. The L2 Switch does not host a policy either; it
preserves an 802.1p priority code point across a trunk and strips it together
with the tag on untagged egress.

## Marking

`set dscp`, `set precedence` and `set cos` are supported. DSCP accepts the
symbolic names `default`, `cs0`–`cs7`, `af11`–`af43`, `ef` and numeric `0`–`63`.
IPv4 carries DSCP; IPv6 carries the same value in its Traffic Class field (the
ECN bits are deliberately not modelled).

A CoS only exists inside an 802.1Q tag. An untagged egress frame never gains a
priority code point, however the policy is written.

Marking replaces the packet with an updated copy — fields are never mutated in
place — so a trace can show the value before and after.

## Pipeline order

The order is fixed and covered by tests:

```text
output:  route/policy decision → QoS classification → marking
         → policing → shaping/queueing/scheduling → serialization → transmit

input:   receive → input QoS classification → marking → policing
         → ACL / NAT / routing pipeline
```

## Scheduling

The scheduler model is **strict priority followed by deficit round robin**, and
it is the only model implemented.

- A class configured with `priority` is served before every other queue.
- The remaining classes share the interface by deficit round robin, weighted by
  `bandwidth percent`. Class order comes from the policy map, never from packet
  insertion order, so two engines always choose the same packet.
- Ordering inside one class is always FIFO.
- The scheduler is work-conserving: a class drains fully when nothing competes
  with it. Only a shaper deliberately holds a class back.

A DRR quantum is a share of a fixed scale, floored at one maximum-size frame so
every visit makes progress. That floor is why very small percentages converge
towards an equal share rather than to starvation — an educational
simplification, not vendor behaviour.

### Priority starvation guard

A priority class carries a **built-in policer** sized from
`priority percent × link capacity`. Traffic above that allowance is dropped at
enqueue with reason `policer-exceed` rather than allowed to starve every other
queue. A policy that reserves more than 80% for priority classes is reported in
Problems.

### Not implemented

Deliberately out of scope for this release: WFQ per individual flow, WRED, RED,
hierarchical QoS, MPLS EXP, NBAR and any hardware-specific queue model.

## Token bucket, policing and shaping

One reusable deterministic `TokenBucket` backs both:

```ts
interface TokenBucketConfiguration {
  rateBps: number;
  burstBytes: number;
}
```

Tokens accrue from virtual time only. `readyAtNs` always returns a strictly
future instant when the bucket is short, so a shaper can never reschedule
itself at the same instant forever.

**Policing** never delays a packet. It transmits what conforms and either drops
or marks down what exceeds:

```text
police <bps> <burst-bytes> conform-action transmit exceed-action drop
police <bps> <burst-bytes> conform-action transmit exceed-action set-dscp-transmit <dscp>
```

**Shaping** delays instead of dropping. `shape average <bps>` holds a class in
its bounded egress queue until tokens are available, preserving ordering. It
only drops once that queue is full. Adaptive shaping is not implemented.

## Auto and Step

Auto drains the bounded deterministic events an operation needs, including the
queue drain and every shaper wake-up, and the operation finishes on delivery or
drop. Step exposes each stage separately, in this order:

`qos-classified` / `qos-class-default` → `qos-marked` → `qos-policy-applied` →
`qos-police-conform` / `qos-police-exceed` / `qos-police-dropped` →
`packet-enqueued` → `qos-queue-selected` → `qos-priority-served` /
`qos-weighted-served` → `qos-shape-delayed` / `qos-shape-released` →
`packet-serialization-started` → `packet-serialization-completed` →
`packet-dequeued`.

A terminal or Traffic Generator operation always reaches a final result; it
never hangs without explanation.

## CLI

The recognised subset:

```text
class-map match-any REALTIME
 match dscp ef
 match protocol udp

class-map match-all WEB
 match access-group name WEB-ACL

policy-map WAN-EDGE
 class REALTIME
  priority percent 20
  set dscp ef
 class WEB
  bandwidth percent 30
 class class-default
  bandwidth percent 50

policy-map GUEST-POLICE
 class GUEST
  police 1000000 32000 conform-action transmit exceed-action drop

policy-map WAN-SHAPE
 class class-default
  shape average 2000000

interface Gi0/0
 service-policy input GUEST-POLICE
 service-policy output WAN-EDGE
```

Inspection: `show class-map`, `show policy-map`, `show policy-map interface`,
`show queueing interface <name>`, `show interfaces counters`, and
`clear qos counters`.

IOS QoS commands SimulatorNet does not implement are not offered by contextual
help. This is an educational subset, not full MQC or Cisco hardware parity.

## Resource limits

Every bound is finite and centralized:

| Limit | Value |
| --- | --- |
| Class maps per device | 32 |
| Policy maps per device | 16 |
| Classes per policy | 8 |
| Match rules per class | 8 |
| Service-policy bindings per device | 64 |
| Queues per interface | 8 |
| Queued packets per interface direction | 4096 (link `queueLimitPackets`) |
| Queued bytes per interface | 8 MiB |
| Shaped packets held | 512 |
| Policy evaluations per operation | 200 000 |
| Queue events per operation | 200 000 |

## Persistence

`LabDocument` stores link capacity, propagation delay and queue limit, plus the
device's class maps, policy maps, match rules, marking actions, priority and
bandwidth classes, policers, shapers and service-policy bindings.

It never stores queued packets, token counts, the scheduler cursor, counters,
drops or measured waiting times. A schema-v1 lab written before M10.8 opens
unchanged and uses the documented defaults.

## Device window surface

A Router, L3 Switch or Firewall window carries exactly **one** top-level `QoS`
tab. Everything lives inside it as secondary navigation, so the window keeps a
readable tab row:

| Section | Shows |
| --- | --- |
| Overview | Class-map and policy-map counts, interfaces with a policy, queue / policer / shaper drops, active warnings, and quick links into the other sections |
| Classification | Class maps, match-all / match-any, ACL / protocol / port / prefix / DSCP / precedence / CoS matches, and the runtime class counters |
| Policies | Policy maps and their classes: marking, priority, bandwidth, policing and shaping |
| Interfaces | Interface, input policy, output policy, capacity, queue limit and status; selecting a row opens its detail *inside the same tab* |
| Queues & Counters | Queue depth, transmitted packets/bytes, drops, virtual waiting time, class counters, policer and shaper drops, and **Clear Runtime Counters** |

One reusable `QosPanel` serves all three device kinds. Differences are declared
as capabilities, not forked into near-identical components:

| Capability | Router | L3 Switch | Firewall |
| --- | --- | --- | --- |
| 802.1Q subinterfaces carry a service policy | yes | no | yes |
| Switched virtual interfaces carry a service policy | no | yes | no |
| Zone policy runs on the same routed path | no | no | yes |

A device with no QoS policy engine — Hub, Bridge, L2 Switch, Wireless Router —
has no capabilities and therefore no QoS tab at all.

Which section is open is UI state. It is never written to `LabDocument`, a
submission, grading or the database, and switching sections changes no
configuration. **Clear Runtime Counters** resets transient counters only: class
maps, policy maps and service-policy bindings survive it untouched. The
secondary navigation scrolls horizontally at narrow widths rather than
truncating a section name, and only the panel body scrolls, so the device
window never grows a second scrollbar.

## Known limitations

- Queueing is a property of the physical port. A policy attached to a dot1Q
  subinterface still classifies, marks and polices, but the port keeps one
  shared queue set.
- Capacity drives a virtual serialization delay for teaching. It is not a
  measurement, a benchmark or a claim about real hardware.
- A TCP traffic flow uses the host stack's deterministic ephemeral source port;
  only the destination port is configurable.
- The L2 Switch preserves 802.1p priority but cannot host a policy map.
- Queues & Counters reports policer and shaper *drops*, which the queue exposes.
  Individual shaped packets are observed in the Packet Trace as
  `qos-shape-delayed` and `qos-shape-released`; the engine keeps no aggregate
  delayed/released counter.
