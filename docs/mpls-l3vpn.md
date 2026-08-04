# Deterministic MPLS, LDP and Layer 3 VPN

SimulatorNet implements a bounded educational MPLS L3VPN model for Router
devices. It is a protocol simulator, not a provider-router emulator: packets,
labels, control messages and routing tables are structured TypeScript values;
no vendor image or raw MPLS wire encoding is involved.

## Data plane

An MPLS packet carries an IPv4 payload and a label stack. Each entry has a
20-bit label, Traffic Class, bottom-of-stack flag and TTL. The Router LFIB
supports push, swap, pop, local/VRF delivery and typed drop. Labels 0–15 are
reserved; deterministic dynamic allocation starts at 16. Label 3 is implicit
null and drives penultimate-hop popping.

The uniform TTL model copies IPv4 TTL into the ingress label, decrements the
top label at each LSR and restores the remaining value after the final pop.
Traffic Class is derived from DSCP at ingress and preserved through the core.
M10.11 does not provide pipe-mode TTL, MPLS QoS policy, OAM, multicast,
pseudowires, IPv6 payloads or raw frame encoding.

## LDP

Directly connected, MPLS-enabled Router interfaces exchange structured Hello
messages and establish a bounded TCP-646-like session. The state progression is
`Nonexistent → Initialized → OpenSent → OpenReceived → Operational`. LDP uses
downstream-unsolicited IPv4 FEC mappings, stable router IDs and canonical FEC
ordering, so rebuilding the same lab produces the same local labels and LFIB.

LDP advertises connected and OSPF core prefixes, not BGP customer prefixes.
Session loss, interface shutdown, route withdrawal and Router stop remove the
affected bindings. Control-protocol activity becomes quiescent; steady state
does not keep `runUntilIdle()` alive.

## VRF and VPNv4

Every VRF owns a separate connected, static and imported VPN route table. Every
lookup supplies an explicit global or VRF routing context. Customer-facing
interfaces move their connected routes out of the global table, allowing the
same address in different VRFs while still rejecting duplicates inside one
VRF.

MP-BGP reuses the existing TCP/179 FSM, keepalives, UPDATE transport, best-path
logic and policy infrastructure. The additional VPNv4 NLRI carries RD, route
targets, a per-VRF VPN label, PE next hop and normal path attributes. A peer
must activate VPNv4 on both sides and send extended communities. An imported
route must intersect the receiving VRF import RT set.

Ingress PE forwarding performs a VRF lookup, pushes the inner VPN label, then
uses OSPF/LDP reachability to push the outer transport label. P routers process
only the transport label and do not install customer prefixes. The egress PE
maps the VPN label to a VRF and forwards toward the CE. Matching RTs are the
only route-leaking mechanism; manual inter-VRF leaking is not implemented.

## IPv6 payload and VPNv6 (M10.13)

An MPLS packet's payload is `IPv4Packet | IPv6Packet`. There is one forwarding
engine and one LFIB: push, swap, pop, PHP, the two-label L3VPN stack and the
uniform hop-limit/TTL model are identical whichever payload is inside. An
unknown label is dropped, and an oversized packet is reported as Packet Too Big
(IPv6) or Fragmentation Needed (IPv4) — never fragmented.

The LDP core stays IPv4. PE and P loopbacks and every LDP FEC are IPv4, and the
outer transport label resolves the remote PE's IPv4 loopback. Only the inner
payload is IPv6. A P router therefore reads its LFIB and nothing else: it never
performs a customer IPv6 lookup and never holds a customer IPv6 route.

Each VRF now carries a separate IPv6 table — connected, static and imported
VPNv6 — behind an explicit `address-family ipv6`. Every routing lookup takes an
explicit routing context, and there is no fallback in either direction: a
missing VRF IPv6 route never falls back to the global IPv6 table. Two VRFs may
hold the same IPv6 prefix; one VRF may not hold it twice.

A VPNv6 NLRI carries the route distinguisher, the IPv6 prefix, route targets,
the VPN label, the PE transport next hop and the ordinary path attributes. The
RD makes overlapping customer prefixes unique and the RT decides import, exactly
as with VPNv4. In this milestone the transport next hop is the PE's **IPv4**
loopback, resolved through the OSPF/LDP core — a deliberate simplification of
the educational model, not a claim about real VPNv6 next-hop encoding.

**A VPN label is allocated per VRF *and* address family.** This is the
documented decision: one VRF gets one label for IPv4 delivery and a separate
label for IPv6 delivery, so the egress PE maps a label to a VRF *and* a family
rather than inferring the family from the payload. Both values are deterministic
and are rebuilt identically by the browser worker and the verifier.

Route reflection serves VPNv6 through the same BGP process — client/non-client
rules, `ORIGINATOR_ID`, `CLUSTER_LIST` and extended route targets — with no
second FSM.

## Trust and persistence

LabDocument stores MPLS interface enablement, the configured LDP router-ID
source, VRF/RD/RT definitions, interface membership, VRF static routes,
explicit connected/static redistribution, VPNv4 activation and
`send-community extended`. M10.13 adds the VRF `address-family ipv6` flag, VRF
IPv6 static routes, VPNv6 activation and per-VRF IPv6 redistribution flags. It
never stores packet label stacks, LFIB, LDP sessions/bindings, learned VPNv4 or
VPNv6 routes, allocated labels, NDP state or counters.

The browser worker and server verifier rebuild those runtime structures from
the same configuration and seed. Browser traces, LFIB, labels and scores are
not trusted grading input.

Router Config groups MPLS/LDP, VRFs and L3VPN under Routing; Monitor exposes
the LFIB, LDP neighbors/bindings, VRF routes (both families), VPNv4 routes,
VPNv6 routes and the VPN-label map, which reports the address family each label
serves.
`View → Protocol Overlays` can add runtime MPLS operations to physical links
and a logical PE-to-PE L3VPN relation. Both overlays are local presentation
preferences: neither creates a cable, changes an interface, nor enters the
LabDocument or grading input.

## Scope limits

MPLS and L3VPN are Router-only. The core (OSPF, LDP, loopbacks and transport
labels) is IPv4; M10.13 adds IPv6 payloads, VRF IPv6 tables and VPNv6 on top of
it. It intentionally excludes MPLS-TE/RSVP, L2VPN/xconnect/pseudowires, EVPN,
Segment Routing, targeted LDP, an IPv6 LDP core, labeled-unicast,
authentication, external VPN route redistribution and PE-CE dynamic routing —
PE-CE redistribution stays connected/static only, for IPv4 and IPv6 alike.
