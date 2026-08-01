# VPN tunnels: GRE and deterministic site-to-site IPsec

> **SimulatorNet models deterministic educational GRE and site-to-site IPsec
> behaviour. Its simulated ESP/IKE implementation does not provide real
> cryptographic protection.**

That sentence is the whole boundary of this feature, and it is repeated in the
CLI, in the VPN panel and in every demo. What follows describes what *is*
modelled, precisely enough to teach with — and says plainly where the model
stops.

## GRE model

A GRE tunnel joins two routed devices across a network that knows nothing about
the traffic it carries. SimulatorNet never serializes a packet to bytes, so GRE
is a **structured** encapsulation: the inner packet is a typed object nested
inside the outer one.

```ts
interface GrePacket {
  protocol: "ipv4" | "ipv6";
  innerPacket: Ipv4Packet | Ipv6Packet;
  tunnelId: string;
}
```

The outer packet is an ordinary `Ipv4Packet` with protocol 47, so it is routed,
filtered, translated, classified and queued by exactly the same underlay
pipeline as any other packet. An intermediate device sees outer addresses, the
protocol and the size; it cannot reach the inner transport, because reaching it
requires the tunnel that produced it.

Only `gre-ipv4` — GRE over an IPv4 underlay — is modelled. Multipoint GRE and
NHRP are not.

### Overlay vs underlay

Two routing tables are in play at once, and keeping them apart is the point of
the feature:

| | Underlay | Overlay |
| --- | --- | --- |
| Addresses | the real interface addresses the provider routes | the tunnel's own addresses |
| Carries | the outer GRE/ESP packets | the inner LAN-to-LAN traffic |
| Egress | a cabled interface | `Tunnel<n>` |

A tunnel's *destination* is resolved in the underlay. Its *overlay* address
produces a connected route just like any other interface, so a static route or
OSPF adjacency can use the far end's overlay address as a next hop.

### Tunnel interfaces

`interface Tunnel<n>` is a logical interface with no cable. It has an
administrative state, IPv4 and IPv6 overlay addresses, an MTU and a TTL, and it
produces connected overlay routes. It never appears in the connection modal,
never anchors a canvas edge and never becomes a `LabDocument.topology.links`
entry.

Router and Firewall terminate tunnels. **An L3 Switch does not** — it has no
`vpn` field in its configuration schema at all.

### Tunnel operational state

A tunnel is up when **all** of these hold:

1. it is administratively up;
2. its source resolves to a usable local IPv4 address (an addressed, operational
   interface, or an address the device owns);
3. its destination has an underlay route;
4. that route does not egress through a tunnel — a recursive route is rejected;
5. if it requires IPsec protection, an outbound security association is active.

`show interfaces tunnel` names the reason when a tunnel is down:
`administratively-down`, `source-unavailable`, `destination-unreachable`,
`recursive-route` or `protection-unavailable`. Nothing is invented: the state is
derived from the routing table on demand and is never stored.

GRE needs no peer handshake. A tunnel with no listener at the far end still
comes up; the absence is only discovered when traffic fails.

### MTU

Each tunnel carries a deterministic MTU. Before encapsulating, the engine
estimates the inner packet with the same header model the egress queue uses
(`estimateIpPacketSizeBytes`, the IP-layer sibling of
`estimatePacketWireSizeBytes`) and adds the outer IPv4 header, the GRE header
and — on a protected tunnel — the simulated ESP overhead.

If the result exceeds the MTU the packet is **dropped** with a typed reason and
an ICMP `Fragmentation Needed` (or ICMPv6 `Packet Too Big`) is returned.
**Fragmentation is deliberately not modelled.**

### Routing over a tunnel

Supported: static routes through an overlay next hop, IPv4 payload, IPv6
payload, OSPFv2 over the GRE point-to-point overlay, and OSPFv3 where the
existing interface abstraction already allows it. A tunnel has no link layer, so
OSPF hellos and OSPFv3 control traffic are encapsulated rather than resolved
through ARP or NDP.

## IKEv2 educational state machine

Negotiation travels over ordinary simulated UDP port 500, through routing,
ACLs, NAT and firewall policy — so an ACL that denies UDP 500 genuinely stops a
tunnel from establishing, exactly as it would in reality.

```text
DOWN → INITIATING → NEGOTIATING → ESTABLISHED → REKEYING → ESTABLISHED
                          ↓             ↓            ↓
                        FAILED       EXPIRED     rekey-failed → EXPIRED
```

Negotiation checks peer reachability, the peer address, a compatible proposal,
a matching pre-shared-key proof, an optional identity, and the resource limits.
The exchange is `sa-init` → `sa-init-response` → `auth` → `auth-response`, with
`rekey`/`rekey-response` later and an optional `delete`.

If both ends arm at once, the peer with the numerically **higher** address
yields and becomes the responder, so exactly one negotiation survives.

**Not modelled and not claimed:** IKEv1, main/aggressive mode, Diffie-Hellman,
perfect forward secrecy configuration, certificates or any PKI, remote-access
VPN, policy-based crypto maps, DMVPN, GETVPN, IPsec transport mode, multiple
child SAs per tunnel, and NAT traversal.

## Pre-shared key protection

A credential must be comparable **inside** the synchronous deterministic engine,
which must never see a plaintext secret. So — exactly like the educational
WPA2-PSK and management-plane models — Web Crypto derives an opaque, scope-bound
verifier *before* any packet or event processing, and only that fingerprint ever
crosses the simulated wire.

The VPN scope uses a fixed salt so two independently configured peers derive the
**same** verifier from the same key. That is also what lets the CLI accept a key
at a no-echo prompt: the terminal derives the fingerprint in the main thread and
submits only that.

A pre-shared key never appears in:

- a trace or the Packet Trace;
- `show running-config` (it renders as `pre-shared-key <configured>`);
- a log, Problems, or any `show` output;
- a grading result, student or instructor;
- browser state after the configuration is saved.

`PBKDF2-HMAC-SHA-256`, a fixed scope salt and bounded iterations. This is
**authentication material, not encryption**: it decrypts nothing and protects no
packet.

## Simulated ESP

```ts
interface SimulatedEspPacket {
  spi: number;
  sequenceNumber: number;
  protectedProtocol: "gre";
  protectedPayload: GrePacket;
  integrityTag: string;
}
```

The `integrityTag` is a deterministic logical fingerprint so a lab can observe
that protection was applied and that both ends agree on what was protected. It
is **not** a message authentication code and provides no security guarantee.

What the model *does* get right is opacity. An intermediate device sees the
outer source and destination, the ESP protocol, the size and the QoS fields —
and nothing of the inner transport, because the protected payload is only
reachable after a security-association lookup. A class map matching destination
port 80 does not match a protected packet.

SPIs are deterministic: both peers derive the same value for the same
(source, destination, generation) tuple, so one end's outbound SA is the other
end's inbound SA without any key ever being exchanged.

### Replay, lifetime and rekey

Each inbound SA keeps a **bounded** replay window (64 packets). A duplicate
sequence number is rejected, a sequence number below the window is rejected, and
an unknown SPI is rejected — traced as `esp-replay-dropped` and
`esp-invalid-spi`. This is a small deterministic window, **not** RFC 4303
anti-replay parity.

An SA records when it must rekey (90% of its lifetime) and when it expires.
There is deliberately **no periodic timer**: a repeating IPsec event would keep
the deterministic event queue permanently non-empty, so `runUntilIdle()` — and
therefore Auto execution and headless grading — would never return. Lifetimes
are instead evaluated against `VirtualClock` whenever something looks: a
protected packet, a VPN inspection, or an explicit time advance. Advancing
virtual time and then sending a packet produces exactly the same deterministic
rekey a timer would have, with a bounded queue.

On a successful rekey the previous generation stays valid for a bounded overlap,
so traffic in flight is not lost. On a failed rekey the SA expires and
protection becomes unavailable until negotiation succeeds again.

## Pipeline

Outbound:

```text
inner overlay packet
  → GRE encapsulation
  → IPsec protection
  → outer underlay routing
  → ACL / Firewall / QoS
  → transmit
```

Inbound:

```text
outer ACL / Firewall
  → ESP SA lookup
  → replay validation
  → unprotect
  → GRE decapsulation
  → overlay routing or local delivery
```

A tunnel that requires protection **never falls back to sending in the clear**.
Without an active SA the packet is dropped, the reason is traced, and
negotiation is re-armed.

## No NAT traversal

NAT-T is not modelled. If NAT rewrites the outer addresses of IKE or ESP
traffic, the peer no longer recognises them and negotiation or the SA stops
working. That is the documented rule, not a bug — and Problems says so when it
is relevant.

## Auto and Step

Both use deterministic virtual time. **Auto** drains the bounded events one
operation needs, so a negotiation completes and protected traffic flows.
**Step** queues those events for inspection: GRE encapsulation, each IKE
message, SA creation, ESP protection, underlay forwarding, unprotect and GRE
decapsulation are each visible as their own event.

The Packet Trace offers `VPN` for the whole family plus `GRE`, `IKE`, `IPsec`
and `ESP` for one stage each.

## Trace events

| Stage | Events |
| --- | --- |
| GRE | `gre-encapsulation-started`, `gre-packet-sent`, `gre-packet-received`, `gre-decapsulated`, `gre-tunnel-down`, `gre-recursive-route-rejected`, `gre-mtu-exceeded` |
| IKE | `ike-negotiation-started`, `ike-proposal-selected`, `ike-authentication-succeeded`, `ike-authentication-failed`, `ike-peer-unreachable` |
| IPsec | `ipsec-sa-established`, `ipsec-sa-rekeyed`, `ipsec-sa-expired` |
| ESP | `esp-packet-protected`, `esp-packet-received`, `esp-packet-unprotected`, `esp-replay-dropped`, `esp-invalid-spi` |

No event ever carries a pre-shared key or a verifier.

## What is persisted

`LabDocument` stores **configuration only**: tunnel interfaces with their
source, destination, mode, MTU, TTL and overlay addresses; IKEv2 proposals;
IKEv2 peers with their opaque key verifiers; IPsec profiles; and the
tunnel→profile binding.

It never stores IKE state, security associations, SPIs, sequence numbers,
replay-window state, counters, rekey timers or peer reachability. A lab written
before M10.9 has no `vpn` block at all and still opens.

## Limitations

- No real encryption, key exchange, certificate handling or message
  authentication — the `sim-` transform names exist to make that unmistakable.
- No IKEv1, remote-access VPN, DMVPN, GETVPN, crypto maps or transport mode.
- No NAT traversal.
- No fragmentation: an oversized packet is dropped and reported.
- One IPsec profile per tunnel, and one child SA pair per tunnel (a rekey
  briefly overlaps two).
- The anti-replay window is bounded and deliberately simple.
- A Firewall uses the same SimulatorNet VPN configuration as a Router; **no ASA
  or vendor CLI parity is claimed**.
