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

## Trust and persistence

LabDocument stores MPLS interface enablement, the configured LDP router-ID
source, VRF/RD/RT definitions, interface membership, VRF static routes,
explicit connected/static redistribution, VPNv4 activation and
`send-community extended`. It never stores packet label stacks, LFIB, LDP
sessions/bindings, learned VPNv4 routes, allocated labels or counters.

The browser worker and server verifier rebuild those runtime structures from
the same configuration and seed. Browser traces, LFIB, labels and scores are
not trusted grading input.

Router Config groups MPLS/LDP, VRFs and L3VPN under Routing; Monitor exposes
the LFIB, LDP neighbors/bindings, VRF routes, VPNv4 routes and VPN-label map.
`View → Protocol Overlays` can add runtime MPLS operations to physical links
and a logical PE-to-PE L3VPN relation. Both overlays are local presentation
preferences: neither creates a cable, changes an interface, nor enters the
LabDocument or grading input.

## Scope limits

M10.11 is Router-only and IPv4-only. It intentionally excludes MPLS-TE/RSVP,
L2VPN/xconnect/pseudowires, VPNv6, EVPN, Segment Routing, targeted LDP,
authentication, route reflectors, external VPN route redistribution and PE-CE
dynamic routing.
