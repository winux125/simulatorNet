# IPv6 simulation

SimulatorNet implements a bounded educational IPv6 subset in the same
deterministic engine used by the browser worker and server verifier. IPv4 and
IPv6 share interface, route-selection and TCP/UDP service abstractions; IPv6 is
not a second transport stack.

## Addressing and neighbor discovery

The core parses and emits canonical compressed IPv6 addresses and supports
prefix lengths from 0 through 128. Hosts and routed interfaces receive a stable
link-local address derived from their deterministic interface identity.
Structured ICMPv6 messages implement echo, destination-unreachable,
time-exceeded, Neighbor Solicitation/Advertisement and Router
Solicitation/Advertisement.

Neighbor resolution, pending packets, DAD probes and control events all have
finite limits. Neighbor cache entries, DAD results and pending packets are
runtime state and are not serialized. A DAD collision leaves configuration
intact and produces a runtime problem.

## Host assignment and routing

PC and Server support Static, SLAAC and stateful DHCPv6 modes. Router
Advertisements carry prefix and router lifetimes plus Managed and Other flags.
The educational DHCPv6 subset implements Solicit, Advertise, Request, Reply,
Renew and Release with a stateful address and DNS option. It does not implement
prefix delegation, relay, rapid commit, vendor options or authentication.

Router and L3 Switch support IPv6 addresses on routed physical ports,
subinterfaces, SVIs and loopbacks, connected and static routes, longest-prefix
match, default routes, hop-limit processing and ICMPv6 errors. DNS supports
AAAA records; HTTP, TCP and UDP use the existing family-neutral services.

## OSPFv3 and IPv6 ACL

OSPFv3 reuses the bounded neighbor state machine, reliable flooding, LSDB,
Dijkstra SPF and activity-window model shared with OSPFv2. The implemented
scope is area 0, one process per Router or L3 Switch, link-local neighbors,
broadcast and point-to-point links, DR/BDR, interface cost, passive interfaces,
intra-area prefixes and deterministic reconvergence. OSPFv2 and OSPFv3 may run
together.

Named IPv6 ACLs use the shared packet policy engine. Ordered permit/deny rules
match source and destination prefixes, TCP/UDP ports or ICMPv6, use first match
and implicit deny, and bind inbound or outbound to a routed interface.
Counters are runtime-only. There is no hidden NDP/RA exception: explicitly
blocking essential ICMPv6 can break neighbor discovery or autoconfiguration,
and the runtime reports that likely cause.

## IPv6 routing protocols

Beyond static routes and OSPFv3, IPv6 prefixes also reach the routing table
through MP-BGP. A BGP neighbor may use an IPv6 transport address, and one BGP
session can carry IPv4 unicast, IPv6 unicast, VPNv4 and VPNv6 at the same time
with separate RIBs per family. Inside a VRF, IPv6 gets its own table — never a
fallback to the global one — so two customers may reuse the same prefix. See
`docs/routing-bgp.md` for the address-family model and `docs/mpls-l3vpn.md` for
VPNv6 over the IPv4 MPLS core.

## Integration boundary

Schema-v1 `LabDocument` stores IPv6 configuration only: host mode and static
fields, routed-interface addresses, RA and DHCPv6 settings, static routes,
OSPFv3, IPv6 ACLs/bindings and DNS AAAA records. Old documents without those
optional fields remain valid. The worker owns live devices and exposes typed
configuration/status requests; the main thread never mutates an `EndHost`.

The verifier rebuilds the submitted document and supports `ipv6-address`,
`ipv6-neighbor`, `slaac-address`, `dhcpv6-address`, `ipv6-route`,
`ipv6-connectivity`, `ospfv3-neighbor`, `ospfv3-route`, `ipv6-acl-rule`,
`ipv6-packet-permitted` and `ipv6-packet-denied`, plus the M10.13 IPv6 BGP and
VPNv6 checks documented in `docs/routing-bgp.md` and `docs/mpls-l3vpn.md`. It
ignores browser runtime state and redacts hidden expectations from student
results.

Four explicit demos are available from Load Demo Lab: IPv6 Static LAN, SLAAC
and Router Advertisement, DHCPv6 and DNS AAAA, and OSPFv3 and IPv6 ACL; M10.13
adds eBGP over IPv6, Dual-Stack BGP and VPNv6 Over MPLS. None is ever loaded
automatically.

Known limits include no IPv6 extension-header chains, fragmentation, IPsec,
privacy/temporary addresses, MLD, DHCPv6 prefix delegation or relay, OSPFv3
multiple areas/authentication/external routes/redistribution/virtual links,
ECMP, and full IOS or Windows command parity.
