# Deterministic BGP and multi-AS routing

SimulatorNet implements a deterministic educational IPv4 unicast BGP model.
It is designed for small multi-AS labs and for identical execution in the
browser worker and the server verifier. It does not claim full Cisco IOS or
RFC implementation parity.

## Trust and execution model

BGP runs only on a Router or on an L3 Switch with `ip routing` enabled. A
Firewall, Cloud / ISP, L2 Switch and end host are not BGP speakers. The process
uses the existing simulated IPv4 and TCP stacks: peer traffic opens TCP port
179, follows the routing table, consumes link queues, and can be denied by an
ACL or firewall policy. No host socket or browser network API is used.

Each peer follows a bounded FSM:

```text
Idle -> Connect -> Active -> OpenSent -> OpenConfirm -> Established
```

OPEN, KEEPALIVE, UPDATE and NOTIFICATION are structured simulation messages.
They are visible in Packet Trace without pretending to encode wire-format BGP
packets. A deterministic endpoint ordering avoids duplicate simultaneous TCP
sessions. Retry, KEEPALIVE and Hold behavior runs in a finite activity window;
after convergence the event queue becomes empty. A link/configuration/session
change re-arms the window, and an explicit virtual-time jump can expire a peer.

Central limits bound peers, sessions, messages, state transitions, prefixes per
peer, AS-path length and activity ticks. BGP never schedules an unbounded
periodic event stream, so Auto mode and headless grading terminate.

## RIB model

The process maintains separate runtime tables:

- Adj-RIB-In stores accepted routes per peer, while a bounded raw inbound RIB
  permits policy re-evaluation without resetting TCP;
- Loc-RIB stores one deterministic best path for each IPv4 prefix;
- Adj-RIB-Out stores the last permitted advertisement per peer so withdrawals
  are generated correctly;
- the device IPv4 RIB installs the selected path with administrative distance
  20 for eBGP and 200 for iBGP.

A `network` statement originates a prefix only when an exact connected or
static route already exists. eBGP prepends the local AS and uses a one-hop TTL
unless `ebgp-multihop` is configured. iBGP preserves the AS path and supports
`next-hop-self`; iBGP-learned routes are not advertised to another iBGP peer.
AS loops and unreachable next hops are rejected with traceable reasons.

Best-path selection is stable and follows this documented order:

1. highest weight;
2. highest local preference;
3. locally originated;
4. shortest AS path;
5. lowest origin (`igp`, `egp`, `incomplete`);
6. lowest MED when paths come from the same neighboring AS;
7. eBGP over iBGP;
8. lowest IGP metric to the next hop;
9. oldest learned path;
10. lowest neighbor router ID;
11. lowest neighbor address, then stable route ID.

ECMP and multipath installation are intentionally absent.

## Route reflection

A route reflector removes the iBGP full-mesh requirement for IPv4 unicast and
for VPNv4. It is the same BGP process, not a second protocol: a neighbor is
marked `route-reflector-client`, and the process gains a cluster identity that
defaults to the BGP router ID unless `bgp cluster-id` overrides it. A client
may only be an iBGP neighbor.

The documented rules are:

- a path learned from a client may be advertised to other clients, to
  non-client iBGP peers and to eBGP peers;
- a path learned from a non-client iBGP peer may only be advertised to clients;
- a locally originated path may be advertised to anyone;
- a path is never sent back to the peer it came from;
- a plain router with no clients keeps the pre-M10.12 iBGP split horizon.

On the first reflection the process stamps `ORIGINATOR_ID` with the router ID
of the originating iBGP speaker and prepends the local cluster ID to
`CLUSTER_LIST`. A received path is rejected when its `ORIGINATOR_ID` equals the
local router ID, when `CLUSTER_LIST` already contains the local cluster ID, or
when the list exceeds its finite bound; each rejection has its own trace event.
A reflector never rewrites `NEXT_HOP` — `next-hop-self` stays an explicit,
separate neighbor policy. Both attributes are iBGP-only and are dropped on an
eBGP advertisement.

## Communities

Standard communities are `ASN:value` plus the well-known names `internet`,
`no-export` and `no-advertise`. They are stored canonically — deduplicated and
sorted by their 32-bit value — so an identical input always produces an
identical RIB. `local-AS`/`no-export-subconfed` is absent because
confederations are not modelled.

`no-advertise` stops a route reaching any peer; `no-export` stops it at the
eBGP boundary while iBGP and reflection still carry it; `internet` advertises
normally. Communities only cross a session when the neighbor has
`send-community` (`send-community both` also enables the extended attribute).
Standard communities and VPNv4 route targets are separate attributes: a
`set community` action can never delete a route target, and `send-community
extended` remains the VPNv4 control.

Communities travel through Adj-RIB-In, Loc-RIB and Adj-RIB-Out. They never
affect best-path selection on their own; only policy and the advertisement
rules read them.

## Prefix lists, community lists, AS-path lists and route maps

One reusable routing-policy engine evaluates inbound and outbound policy. IPv4
prefix lists use ordered sequence numbers, `permit`/`deny`, and optional `ge`
and `le`. Community lists and AS-path lists follow the same shape: ordered
sequences, first match wins, implicit deny.

An AS-path list stores a **structured matcher**, never a regular expression.
The CLI and the importer accept the educational subset `^$`, `_<asn>_`,
`^<asn>_`, `_<asn>$` and `^<asn> <asn>$` and convert it once into `empty`,
`contains`, `starts-with`, `ends-with` or `exact`; a `length eq|le|ge <n>`
matcher is available structurally. An unsupported pattern is reported with the
list of supported forms and is never stored or executed.

Route-map sequences use first-match semantics and an implicit deny. They match
a prefix list, neighbor, source type (`match route-source`/`match route-type`),
bounded AS-path length, a community list or an AS-path list. Several lists of
one category are OR-ed; `match community all <list>...` switches that clause to
AND. Different categories are AND-ed.

Set actions cover local preference, MED, weight, origin, `set community
<value>... [additive]`, `set community none` and `set as-path prepend <asn>
[<asn>...]`. Without `additive` the standard community set is replaced; with it
the values are merged, deduplicated and re-sorted. A prepend list is bounded,
rejects AS 0 and is applied before the receiving peer's AS-loop check.

Changing a policy re-evaluates the stored raw Adj-RIB-In and Adj-RIB-Out. It
does not reset the TCP session. `clear ip bgp <neighbor> soft [in|out]` and
`clear ip bgp * soft` request the same deterministic reevaluation explicitly.
Match counters and all RIB contents remain runtime-only.

## Aggregation and default origination

`aggregate-address <network> <mask> [summary-only] [as-set]` originates one
summary, and only while at least one contributing more-specific BGP or locally
originated path exists inside it. The summary uses `ORIGIN = INCOMPLETE`, a
local next hop and an empty AS path; with `as-set` the AS path carries the
deterministic sorted set of contributing ASNs. Its communities are the bounded
canonical union of the contributing paths' communities.

`summary-only` keeps the more-specific routes in the Loc-RIB and in the local
forwarding table and suppresses them only in advertisements, and only towards
peers that actually receive the summary. The aggregate is withdrawn when its
last contributing route disappears, when the statement is removed, or when
policy denies it.

`neighbor <address> default-originate [route-map <name>]` advertises
`0.0.0.0/0` to exactly that neighbor. Following Cisco-like educational
behaviour it does not require a local default route; with a route map the
bounded policy model decides. The originated default is never installed in the
local RIB — it exists only in that peer's Adj-RIB-Out.

## Persistence and UI

Schema-v1 `LabDocument` stores only structured process configuration, neighbor
configuration, network statements, aggregates, the cluster ID, the
route-reflector-client and send-community flags, default-originate, prefix
lists, community lists, AS-path lists, route maps and policy bindings. It never
stores TCP sessions, peer FSM state, learned routes, RIBs, `ORIGINATOR_ID` or
`CLUSTER_LIST` state, reflected-route flags, communities learned through BGP,
aggregate contribution, suppressed routes, message counters or policy counters.
Canonical serialization sorts neighbors, networks, aggregates, lists, sequences
and policy objects by stable domain keys. A document written before M10.12 has
none of the new fields and opens unchanged.

Router and L3 Switch device windows expose BGP under **Config -> Routing ->
BGP** and under **Monitor -> BGP**, each as one section with secondary
navigation inside it — Overview, Neighbors, Address Families, Route Reflection,
Networks & Aggregates and Policies for configuration; Summary, BGP Table,
Neighbors, Advertised/Received, Communities, Aggregates, Route Reflection and
Policy Counters for the monitor. Prefix lists, community lists, AS-path lists
and route maps share the one BGP Policies section rather than becoming four
tabs. The selected subsection is local UI state.

Packet Trace provides BGP, BGP Session, BGP Updates, Route Policy, Route
Reflection, Community and Aggregation filters. Problems reports a client on an
eBGP peer, a cluster or originator loop, communities held without
`send-community`, an unsupported AS-path pattern, a missing policy list, an
invalid aggregate, an aggregate with no contributing route and a denied
default-originate route map. The worker protocol returns plain JSON and never
exposes device instances to the main thread.

Six explicit demos are available and are never auto-loaded:

- eBGP Basic;
- Dual ISP Best Path;
- iBGP and Route Policies;
- iBGP Route Reflector;
- BGP Communities;
- Aggregation and Advanced Policy.

## Grading and verifier behavior

The verifier rebuilds the submitted lab and runs the same BGP process. Checks
cover neighbor state, local AS, network statements, learned/selected routes,
next hops, prefix-list entries, route-map sequences, policy results,
advertised/received prefixes, route-reflector clients, the cluster ID, a
reflected path and its attributes, originator/cluster loop prevention, a
route's communities, community-list and AS-path-list entries, route-map match
counts, aggregates, suppressed more-specific routes and per-neighbor default
origination. Browser-provided session state, routes, counters, trace and scores
are ignored. Hidden expected values — including expected communities and policy
identities — are removed from the student result.

## Deliberate limitations

BGP here is IPv4 unicast plus the VPNv4 address family MPLS L3VPN needs. It
omits IPv6 address families, confederations, large and extended communities
beyond route targets, expanded (regex) community lists, unrestricted AS-path
regular expressions, `local-AS`/`no-export-subconfed`, `advertise-map`
conditional advertisement, `suppress-map`/`unsuppress-map`, redistribution into
BGP, route refresh, graceful restart, authentication/MD5, add-path, dynamic
neighbors, peer groups, ECMP and full vendor command parity. An `as-set`
aggregate models the contributing ASNs as an ordered sorted list rather than a
true unordered AS_SET, so its AS-path length is the number of contributors.
Importers preserve unsupported lines in the report instead of silently
approximating them.
