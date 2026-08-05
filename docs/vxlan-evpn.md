# VXLAN and BGP EVPN Layer 2 overlays

SimulatorNet stretches one VLAN across a routed IPv4 underlay by encapsulating
Ethernet frames in VXLAN and, optionally, by distributing tunnel-endpoint
membership and MAC bindings with BGP EVPN. Everything here is a deterministic
educational model: there is no real socket, no real UDP datagram and no
hardware claim anywhere in it.

```text
Host A ── access VLAN ── VTEP1 ══ IPv4 underlay ══ VTEP2 ── same VLAN ── Host B
                                (UDP 4789)
```

## Ownership boundaries

| Device | Role |
| --- | --- |
| L3 Switch | The **only** VXLAN tunnel endpoint (VTEP) |
| Router | Underlay router, and BGP EVPN Route Reflector — never a VTEP |
| L2 Switch | Ordinary access/aggregation switch |
| Firewall, Cloud/ISP | No VXLAN, no EVPN |

A **VXLAN tunnel is never a cable**. `nve1` is a logical interface: it has no
physical port, never appears in the connection modal, never anchors a canvas
edge and never becomes a `topology.links` entry. The canvas overlay under
*View ▸ Protocol Overlays ▸ VXLAN Tunnels* is derived presentation, exactly like
a wireless association or an L3VPN relation.

## The NVE interface

```text
interface nve1
 no shutdown
 source-interface Loopback0
 member vni 10010
  ingress-replication protocol bgp

vlan configuration 10
 member vni 10010
```

The VNI and its replication mode are declared on `nve1`; the VLAN it carries is
bound separately by `vlan configuration <id>`. Keeping the two halves apart is
what lets a learner type them in either order — a VNI with no VLAN yet is simply
not a member.

`nve1` is operational when:

- it is administratively up;
- its source interface exists, is a **Loopback**, and has a usable IPv4 address;
- the mapped VLAN exists in the VLAN database.

A per-VNI peer additionally needs an underlay route that does **not** egress the
overlay, so a recursive route through VXLAN itself can never form.

One VLAN maps to at most one VNI, and one VNI to at most one VLAN. The VNI range
is 1–16,777,215; VNI 0 is reserved and always rejected.

## The data plane

A frame reaching the overlay is encapsulated and then handed to the *ordinary*
underlay path, so interface state, ACLs, the firewall, QoS and packet loss all
apply to it exactly as they do to any other IPv4/UDP traffic:

```text
access/trunk port → VLAN → local switching
  → remote delivery required → VLAN-to-VNI → VXLAN encapsulation
  → outer IPv4/UDP 4789 → underlay routing → remote VTEP

outer IPv4/UDP → matching local NVE/VNI → decapsulate
  → inject into the mapped VLAN → local L2 switching
```

The outer transport is the real simulated UDP stack on port 4789, so an ACL
genuinely blocks the overlay. `vxlanSourcePort()` derives the outer source port
from the inner addresses, so a conversation always leaves with the same entropy
and two engines never disagree. `estimateVxlanOuterSizeBytes` is the one size
API: an outer packet larger than the 1500-byte underlay MTU is dropped and
reported, never fragmented.

### BUM traffic and split horizon

Broadcast, unknown-unicast and multicast frames are replicated head-end: one
copy per remote VTEP, in stable address order, never to this device itself, and
bounded per operation so a broadcast storm can never make Auto execution
unbounded.

A frame that *arrived* from a remote VTEP is never re-encapsulated towards
another one. The engine carries a runtime `FrameOrigin` (`local-port`,
`local-device` or `remote-vtep`) for this — simulator metadata, not an Ethernet
protocol field — and that is what prevents an overlay loop.

### MAC learning

A VTEP holds two kinds of entry:

- **local**, learned on an access VLAN like any bridge;
- **remote**, naming the VTEP a MAC sits behind.

On a **static** VNI a remote entry is learned from the decapsulated frame. On a
**bgp-evpn** VNI the remote table is owned by the control plane: it is
programmed only by Type 2 routes, because a data-plane entry would survive every
withdrawal and no session loss could ever remove it.

A local attachment always wins over a remote one. When a station moves here, the
stale remote entry is dropped and the move is traced.

The remote MAC table, EVPN-learned membership and every counter are **runtime**
and are never serialized.

## BGP EVPN

EVPN is an **address family on the existing BGP process** — `l2vpn-evpn`. There
is no second FSM, no second TCP session and no second policy engine; only the
RIBs are per family.

```text
evpn
 vni 10010 l2
  rd 65000:10010
  route-target import 65000:10010
  route-target export 65000:10010

router bgp 65000
 neighbor 10.255.0.2 remote-as 65000
 neighbor 10.255.0.2 update-source Loopback0
 address-family l2vpn evpn
  neighbor 10.255.0.2 activate
  neighbor 10.255.0.2 send-community extended
 exit-address-family
```

### Route types

**Type 3 — Inclusive Multicast Ethernet Tag** advertises this VTEP's membership
of a VNI, which is what builds the head-end replication list *before* any tenant
traffic exists. A Type 3 route is keyed by its **originating VTEP**, not by RD
alone: two leaves normally share one RD, so an RD-only key would collapse the
two memberships into one.

**Type 2 — MAC/IP Advertisement** advertises one locally learned MAC so a remote
VTEP can forward to it as known unicast instead of flooding. In M10.14 the MAC
is mandatory and an IPv4 binding is optional; IPv6 bindings and ARP/ND
suppression are not modelled. The delivery label is the VNI.

A VTEP never re-advertises a MAC it learned from another VTEP.

### Import

A route is imported only when its route targets intersect a local VNI's import
list. That intersection — not the VNI number — is what makes the route target
the control point. Without a match the route stays in the EVPN RIB and programs
nothing, and the rejection is traced and surfaced in Problems.

Route targets are extended communities, so they cross a session only with
`send-community extended`. Without it every EVPN route is advertised and then
silently rejected, which is why semantic validation refuses that combination.

### Route Reflector

A reflector is the same BGP process serving one more family. Client/non-client
rules, `ORIGINATOR_ID`, `CLUSTER_LIST` and loop prevention are unchanged, and a
reflector never rewrites `NEXT_HOP`. **A Route Reflector is never a VTEP**: it
carries and reflects EVPN routes without holding an overlay or a tenant MAC.

### Duplicate MAC

When two VTEPs advertise the same MAC in the same VNI, the winner is chosen by
the one documented best-path comparator, so the result never depends on which
UPDATE arrived first. The conflict is traced and reported. The full RFC 7432 MAC
Mobility extended community is deferred.

## Persistence

`LabDocument` stores **configuration only**, on the L3 Switch alone:

- the `nve` block — source Loopback, admin state, VLAN-to-VNI members, static
  peer lists and the replication mode;
- the `evpn` block — per-VNI RD and import/export route targets;
- `evpnActivated` and `sendCommunityExtended` on a BGP neighbor.

Both blocks are optional, so every lab written before M10.14 opens unchanged,
with no migration and no false "unsaved" state.

It must **never** store the remote MAC table, learned Type 2/3 routes, remote
VTEP membership, BUM replication state, VXLAN counters or the EVPN RIB. The
browser worker and the verifier each rebuild all of it from the same structured
configuration, which is what makes their results identical.

`show running-config`, a `.cfg` file and a `.simlab` projection are the same
bytes, rendered by the one renderer in `device-config`.

## Inspection

```text
show nve interfaces
show nve vni
show nve peers
show vxlan
show mac address-table remote
show bgp l2vpn evpn
show bgp l2vpn evpn route-type 2 | 3
show bgp l2vpn evpn vni <vni>
```

A managed L3 Switch window carries one **VXLAN & EVPN** section under `Config`,
with runtime tables reachable from `Monitor`; NVE, VNI Mappings, Peers, EVPN
RD/RT, BGP EVPN, Remote MACs and the two route types remain secondary
navigation inside the reusable panel, exactly as they do for QoS and VPN. The
selected section is UI state and never reaches `LabDocument`, a submission,
grading or the database.

## Trace events

Data plane: `vxlan-encapsulation-started`, `vxlan-packet-sent`,
`vxlan-packet-received`, `vxlan-decapsulated`, `vxlan-bum-replicated`,
`vxlan-mac-learned-local`, `vxlan-mac-learned-remote`, `vxlan-mac-moved-local`,
`vxlan-split-horizon-dropped`, `vxlan-vni-not-found`,
`vxlan-underlay-unreachable`, `vxlan-mtu-exceeded`.

Control plane: `evpn-mac-route-originated`, `evpn-mac-route-imported`,
`evpn-mac-route-withdrawn`, `evpn-imet-imported`, `evpn-imet-membership-changed`,
`evpn-rt-rejected`, `evpn-duplicate-mac-detected`. Ordinary `bgp-*` events carry
`addressFamily: "l2vpn-evpn"` and a `routeType`, so the EVPN family reuses the
existing BGP trace rather than forking it.

Packet Trace offers **VXLAN**, **EVPN**, **BUM** and **VTEP** filters.

## Resource limits

Every bound is finite and centralized in `DEFAULT_CONTROL_PROTOCOL_LIMITS`:
VNIs per VTEP, remote VTEPs per VNI, remote MAC entries, BUM replicas per
operation, VXLAN events per operation, EVPN routes per device, MAC and IMET
routes per VNI, and EVPN updates per operation.

## Deliberately not modelled

L3VNI, symmetric and asymmetric IRB, Anycast Gateway, EVPN Route Types 1, 4 and
5, ESI and multihoming, VXLAN multicast underlay replication, ARP/ND
suppression, EVPN over MPLS, EVPN-VPWS, MPLS-TE and Segment Routing.

An importer recognises the safe subset above and reports every one of these as
unsupported rather than inventing an approximation.
