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

## Routed EVPN (M10.15)

### Distributed anycast gateway

`fabric forwarding anycast-gateway-mac 0200.0000.0001` declares one MAC for the
whole fabric; `fabric forwarding mode anycast-gateway` on an SVI adopts it. Both
leaves in a stretched tenant VLAN then present the *same* gateway IP and the
same MAC, so a host always talks to its own local leaf and its ARP cache stays
valid if the host moves. That shared address is a distributed gateway, not a
duplicate: an ordinary duplicate host address is still detected as before.

An ARP request whose target is a local gateway address is answered locally and
never head-end replicated — the remote leaf would answer identically, so the
overlay copy would be pure noise. This is gateway-only; ARP suppression for
ordinary tenant hosts is deliberately not modelled. The gateway MAC is never
advertised as a Type 2 route, because every leaf owns it.

### L3VNI

`interface nve1` → `member vni 50001 associate-vrf TENANT-A` declares an
**L3VNI**: a routed transit segment with no VLAN and no broadcast domain, so it
never gets a `vlan configuration` block. One L3VNI belongs to at most one VRF
per VTEP, a VRF carries at most one, and a VNI is either bridged or routed —
never both. It is up only while the NVE is up and the VRF still exists.

Tenant VRFs now exist on the L3 Switch. MPLS, LDP and VPN labels stay
Router-only: the switch gains the routing context, not L3VPN.

### The routed data plane

One VXLAN engine carries two payloads. An L2VNI transports an Ethernet frame; an
L3VNI transports a routed `Ipv4Packet`. `estimateVxlanOuterSizeBytes` sizes
both, so an oversized routed packet is dropped and reported, never fragmented.

**Symmetric IRB** — both ends route:

```text
Host A, VLAN 10 → local anycast gateway on Leaf1
  → TENANT-A VRF lookup → Type 5 prefix via Leaf2
  → encapsulate into L3VNI 50001 → IPv4 underlay
  → Leaf2 maps VNI 50001 → TENANT-A → VRF lookup
  → VLAN 20 → local ARP → Host B
```

The destination's L2VNI is never the transit VNI, and return traffic takes the
same routed overlay independently. A local destination is routed locally and
never encapsulated. Underlay routers see only outer IPv4/UDP 4789.

### EVPN Route Type 5

Type 5 is IPv4-only and rides the existing `l2vpn-evpn` family — one FSM, one
TCP session, one comparator. Origination requires *all* of: an RD, an export
route target, an operational L3VNI, an eligible connected or static VRF route,
an active EVPN address family, and an explicit

```text
router bgp 65000
 address-family ipv4 vrf TENANT-A
  advertise l2vpn evpn
```

There is no hidden redistribution, and a prefix this VTEP imported from EVPN is
never re-originated. Uniqueness is **RD and prefix**, so two tenants may
advertise the same network and remain two routes.

Import is decided by the VRF's route targets alone, never by VNI number. Without
a match the route stays in the EVPN RIB and installs nothing — which is exactly
what keeps overlapping tenants isolated. The global table is never a fallback.
The existing route reflector reflects Type 5 unchanged and needs no overlay.

An imported prefix is withdrawn when the originator's route disappears, its
L3VNI or NVE goes down, the EVPN family is deactivated, the session drops, the
route target is removed, or the underlay route to the VTEP is lost. BGP keeps no
periodic timer, so a Hold timer fires when something looks; the VTEP's VRF
inspections call `refreshSessionState()` for exactly that reason.

Trace events: `evpn-type5-originated`, `evpn-type5-imported`,
`evpn-type5-withdrawn`, `evpn-type5-rt-rejected`, `evpn-irb-routed`,
`evpn-l3vni-encapsulated`, `evpn-l3vni-decapsulated`,
`evpn-anycast-gateway-replied` and `evpn-tenant-isolation-drop`.

Packet Trace adds **L3VNI**, **IRB** and **Type 5** to the existing VXLAN, EVPN,
BUM and VTEP filters, so the whole flow is walkable: ARP for the gateway → the
local anycast reply → the tenant VRF lookup → Type 5 selection → L3VNI
encapsulation → the underlay hop → decapsulation → the egress VRF lookup →
delivery. A Type 5 UPDATE carries its route type in the ordinary `bgp-*` event
detail, so the family reuses the existing BGP trace rather than forking it.

### Inspecting the routed overlay

```text
show nve vni
show fabric forwarding
show ip route vrf <name>
show bgp l2vpn evpn route-type 5
show bgp l2vpn evpn route-type 5 vrf <name>
```

The managed L3 Switch window carries the routed halves inside the same reusable
`VXLAN & EVPN` panel: **L3VNI**, **Anycast Gateway**, **EVPN Type 5**, **VRF
Routes** and **Routed Overlay** sit beside NVE, L2VNI, Peers, RD/RT, BGP EVPN,
Remote MACs and Types 2/3. Selecting an L3VNI row opens its tenant RD, route
targets and `advertise l2vpn evpn` state in place — no nested modal window, and
the selected section never reaches `LabDocument`, a submission, grading or the
database.

The worker answers `GET_EVPN_ANYCAST_GATEWAYS`, `GET_EVPN_L3VNIS`,
`GET_EVPN_TYPE5_ROUTES`, `GET_EVPN_VRF_ROUTES` and
`GET_EVPN_ROUTED_OVERLAY_STATUS` with one plain-JSON view, and offers two
bounded runtime actions — `CLEAR_EVPN_ROUTED_RUNTIME` and `RESTART_EVPN_L3VNI`.
Both drop learned state only; the configuration is untouched and the verifier
rebuilds the same tables from it.

The canvas overlay gains a routed relation beside the bridged one. It is derived
presentation exactly like a wireless association: dashed, never a cable, never a
`topology.links` entry. `unavailable` marks an L3VNI that exists on both leaves
but transports nothing — its VRF is gone or its NVE is down — which is a
different failure from an unreachable peer.

### Problems

Problems explains an *incomplete* routed configuration and nothing else: a
missing fabric MAC under an anycast SVI, an anycast SVI with no address, an
L3VNI whose VRF was removed, an L3VNI that is not operational, a VRF that
advertises into EVPN without an L3VNI, an export route target or an active EVPN
family, a VRF that has everything except `advertise l2vpn evpn`, and a Type 5
prefix whose route targets match no local VRF. Two leaves sharing one gateway IP
and one gateway MAC is never reported — that is the feature working.

### Grading

`evpn-anycast-gateway`, `evpn-l3vni`, `evpn-type5-route`,
`evpn-type5-imported`, `evpn-irb-connectivity`, `evpn-vrf-isolation`,
`evpn-remote-prefix` and `evpn-routed-overlay-operational` join the existing
`evpn-route-reflected`, which now accepts route type 5. Every expected gateway
MAC, RD, route target and VNI stays in the hidden spec: a student result reports
only whether the check passed.

## Deliberately not modelled

Asymmetric IRB, IPv6 L3VNI and Type 5, EVPN Route Types 1 and 4, ESI and
multihoming, MLAG/vPC, VXLAN multicast underlay replication, ARP/ND
suppression, EVPN host-mobility sequence numbers, inter-VRF route leaking,
firewall service insertion, EVPN over MPLS, EVPN-VPWS, MPLS-TE and Segment
Routing.

An importer recognises the safe subset above and reports every one of these as
unsupported rather than inventing an approximation.
