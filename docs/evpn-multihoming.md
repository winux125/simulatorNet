# Deterministic EVPN Multihoming (M10.16)

SimulatorNet models **Single-Active** EVPN multihoming: one CE attached to two
leaves, discovered through a shared Ethernet Segment Identifier, with exactly one
leaf forwarding toward that CE per VLAN and the other standing by.

All-Active multihoming — and with it aliasing, per-flow load balancing across
several active PEs and MAC mobility — is deliberately **not** modelled here. So
are highest-random-weight and preference-based DF election, AC-DF, duplicate-MAC
dampening, MLAG/vPC, multihoming for an L3VNI or for IPv6, EVPN over MPLS and
Segment Routing. Everything this document describes is what the engine actually
does; nothing below is aspirational.

## The Ethernet Segment

`evpn ethernet-segment <name>` declares one segment. It carries an **ESI**, a
redundancy mode and a set of attachments:

```
evpn ethernet-segment ES-CE1
 identifier 0000:0000:0000:0000:0001
 redundancy-mode single-active
!
interface Ethernet1/10
 ethernet-segment ES-CE1
```

The ESI is a canonical five-group lowercase string — `0000:0000:0000:0000:0001`.
The colon, dot and bare-hex spellings are all accepted and normalize to that one
form, so comparison and ordering are string operations that two engines can never
disagree about. The ten bytes an ESI occupies on a real wire are not modelled as
a byte array: every other protocol field in this engine is structured rather than
encoded, and an ESI is only ever compared, sorted and displayed.

Two values are reserved and are refused everywhere — the CLI, the parser, the
schema and the engine: **ESI 0** (`0000:…:0000`) means "this attachment is
single-homed", and **MAX-ESI** (`ffff:…:ffff`) is reserved by RFC 7432. A
multihomed segment must carry a non-zero ESI.

One ESI may — and must — exist on several VTEPs: that is the whole point. On one
VTEP, an ESI names exactly one segment and an attachment belongs to at most one.

### What may carry a segment

An Ethernet Segment names the port a CE hangs off, so it is an **access
switchport**. A Loopback, an SVI, `nve1` and a routed core port are all refused.
So is a Port-channel: an L3 Switch renders a bundle through its members'
`channel-group` lines and has no Port-channel configuration block to record the
binding in, so accepting one would silently lose it on save. A member port of a
bundle is refused too — the bundle would be the attachment, not the member.

There is deliberately no cross-device LACP: a CE dual-attached to two leaves is
two ordinary links joined by a shared ESI on the EVPN side, which is exactly what
the demos build.

## Route Type 4 — Ethernet Segment

A leaf with an operational segment originates one Type 4 route per segment. It
carries the ESI and the originating VTEP and nothing else: no MAC, no prefix.
The resulting candidate list is what the DF election runs over.

Origination needs four things at once — the segment up, the NVE operational, the
EVPN address family active and at least one route target. Withdrawal is those
same four conditions reversed, which is why losing the last attachment is a
withdrawal rather than a slow decay.

A segment has no route target of its own: it borrows the export targets of the
VNIs its attachment actually serves. An RT mismatch therefore isolates a segment
exactly as it isolates a MAC, with no second import rule to keep in step.

## Route Type 1 — Ethernet Auto-Discovery

Type 1 exists in two scopes, and they answer two different questions.

**Per-ES** says "this VTEP still has a working attachment to this segment".
Withdrawing one invalidates every MAC behind it in a single message instead of
waiting for one Type 2 withdrawal per address. That is the fast **mass
withdrawal**.

**Per-EVI** says "this VTEP can serve this segment in this EVI". It is what makes
a deterministic backup selectable *before* anything has failed, and what keeps a
MAC reachable after its own MAC route is gone.

There is no MPLS ESI label here. The VXLAN data plane's split horizon is built
from the simulator's own origin metadata, not from a label.

## Designated Forwarder election

For each `<ESI, VLAN>` exactly one operational VTEP is the Designated Forwarder.
The election is the documented default modulus one of RFC 7432 §8.5: order the
candidate VTEP addresses numerically, then pick `vlan mod N`.

Every participating leaf runs the same election over the same canonically ordered
candidate list, so they all reach an identical answer without one telling another
what it decided. Input order never matters — the list is sorted first.

Highest-random-weight and preference-based election are not implemented, and
there is no `df-preference` field anywhere in the configuration: a persisted
preference that nothing reads would be a lie.

## Single-Active forwarding

The DF forwards tenant traffic toward the CE for the affected VLAN. The non-DF
**keeps its attachment logically available as a backup** and carries no tenant
data on it in either direction — a frame arriving there is refused before it is
learned, so the standby leaf never advertises a MAC it may not forward to. The
physical interface is never administratively shut merely because this leaf lost
the election; the decision belongs to EVPN forwarding logic alone.

Losing the role flushes what that attachment learned, in that VLAN only. Every
other port's entries stay exactly where they were.

## Split horizon

A frame that entered the fabric on Ethernet Segment X must never be handed back
to X, or a dual-attached CE would see its own frame return. The ingress VTEP
stamps the segment onto the VXLAN packet as **simulator metadata** — never an
Ethernet or VXLAN header field — and the receiving VTEP refuses to send it out
any attachment of that segment.

Split horizon is checked first and independently of the DF role, because it is a
property of where the frame came from rather than of who is forwarding.

## Remote MAC paths: primary and backup

A MAC learned behind a multihomed attachment is advertised as a Type 2 route
carrying a non-zero ESI. The receiving leaf then resolves it through the
**segment**, not through the route's own next hop:

- **primary** — the segment's current Designated Forwarder, among the VTEPs that
  advertise usable per-ES reachability;
- **backup** — the other VTEPs with per-EVI reachability for that EVI, in stable
  address order.

Single-Active never forwards over a backup: that would be aliasing. The backup
exists so a failover is a *selection* rather than a relearn, and so the state is
visible before anything fails.

This dependency lives in one function. There is no `if (esi)` scattered through
the ingress, unicast egress and BUM egress paths.

## Failover

When the DF's attachment fails:

1. the failed leaf flushes what that port learned, then withdraws its Type 4 and
   both Type 1 scopes;
2. remote leaves see the per-ES withdrawal and stop treating that leaf as usable
   for the segment — the mass withdrawal;
3. the candidate set changes, so every participant re-runs the same election and
   the surviving leaf becomes DF;
4. remote MAC entries bound to the segment are redirected to the new forwarder,
   with no address relearned and no topology rebuild;
5. the surviving leaf unblocks its attachment and traffic resumes.

Convergence is bounded: there is **no periodic timer**. A repeating event would
leave the deterministic queue permanently non-empty and `runUntilIdle()` would
never return. Everything above happens as a consequence of BGP UPDATE processing
and interface state changes in virtual time.

## What is persisted

`LabDocument` stores the Ethernet Segments only — name, ESI, redundancy mode and
attachment list — under `evpn.ethernetSegments`. The key is optional, so every
lab written before M10.16 opens unchanged and gains nothing.

It must never store the discovered peer table, the elected Designated Forwarder,
a Type 1 or Type 4 route, a primary/backup path, counters or any failover state.
The browser worker and the verifier rebuild every one of them from the structured
configuration and the imported routes.

## Inspection

```
show evpn ethernet-segment
show evpn ethernet-segment detail
show evpn ethernet-segment esi <esi>
show evpn df
show evpn df vlan <vlan>
show bgp l2vpn evpn route-type 1
show bgp l2vpn evpn route-type 4
show mac address-table remote
```

A managed L3 Switch window carries the same tables under `VXLAN & EVPN` —
Ethernet Segments, ES Peers, DF Election, EVPN Type 1, EVPN Type 4 and
Multihoming Paths — inside the one reusable panel, exactly as QoS, VPN and the
rest of EVPN do. The selected section is UI state and never reaches
`LabDocument`, a submission, grading or the database.

Packet Trace adds four filters: **Ethernet Segment**, **EVPN Multihoming**, **DF
Election** and **Fast Failover**, so the sequence Type 4 discovery → Type 1
advertisement → DF election → Type 2 association → primary/backup programming →
failure → mass withdrawal → new DF → recovery is walkable one step at a time.

## Known limitations

- Single-Active only; All-Active and MAC mobility are M10.17.
- The DF election is the modulus one; HRW and preference are not implemented.
- A segment attaches to an access switchport, never a Port-channel.
- Multihoming applies to bridged L2VNIs; an L3VNI and IPv6 are out of scope.
- There is no ESI label, no EVPN over MPLS and no Segment Routing.

See also `docs/vxlan-evpn.md` and `docs/routing-bgp.md`.
