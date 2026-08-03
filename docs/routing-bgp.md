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

## Prefix lists and route maps

One reusable routing-policy engine evaluates inbound and outbound policy. IPv4
prefix lists use ordered sequence numbers, `permit`/`deny`, and optional `ge`
and `le`. Route-map sequences use first-match semantics and an implicit deny.
They can match a prefix list, neighbor, source type, or bounded AS-path length,
and can set local preference, MED, weight, origin, or a bounded local-AS
prepend count. Arbitrary regular expressions and executable policy code are
not accepted.

Changing a policy re-evaluates the stored raw Adj-RIB-In and Adj-RIB-Out. It
does not reset the TCP session. Match counters and all RIB contents remain
runtime-only.

## Persistence and UI

Schema-v1 `LabDocument` stores only structured process configuration, neighbor
configuration, network statements, prefix lists, route maps and policy
bindings. It never stores TCP sessions, peer FSM state, learned routes, RIBs,
message counters or policy counters. Canonical serialization sorts neighbors,
networks, lists, sequences and policy objects by stable domain keys.

Router and L3 Switch device windows expose BGP under **Config -> Routing ->
BGP** and under **Monitor -> BGP**. Runtime views show overview, summary,
neighbors, the BGP table, Adj-RIB counts, policy counters and bounded reset
actions. Packet Trace provides BGP, BGP Session, BGP Updates and Route Policy
filters. The worker protocol returns plain JSON and never exposes device
instances to the main thread.

Three explicit demos are available and are never auto-loaded:

- eBGP Basic;
- Dual ISP Best Path;
- iBGP and Route Policies.

## Grading and verifier behavior

The verifier rebuilds the submitted lab and runs the same BGP process. Checks
cover neighbor state, local AS, network statements, learned/selected routes,
next hops, prefix-list entries, route-map sequences, policy results, and
advertised/received prefixes. Browser-provided session state, routes, counters,
trace and scores are ignored. Hidden expected values are removed from the
student result.

## Deliberate limitations

M10.10 supports IPv4 unicast only. It omits MP-BGP and IPv6 address families,
route reflectors, confederations, communities, large communities, aggregation,
redistribution, route refresh, graceful restart, authentication/MD5, add-path,
dynamic neighbors, peer groups, ECMP and full vendor command parity. Importers
preserve unsupported lines in the report instead of silently approximating
them.
