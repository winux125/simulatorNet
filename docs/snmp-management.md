# SNMP management

SimulatorNet implements an **SNMPv2c educational subset** over the shared UDP
stack: an agent on network devices, a centralized NMS on the Server, and traps.

## Scope

Simulated: SNMPv2c GET, GETNEXT, RESPONSE, ERROR and TRAP; WALK as a bounded
sequence of GETNEXT requests; a fixed built-in MIB; read-only communities.

**Not** implemented, deliberately: SNMPv1, SNMPv3, USM, VACM, real BER/ASN.1
byte encoding, dynamic MIB loading, arbitrary OID scripting, SET and read-write
communities, and any access to a real device or a real network.

Agents run on Router, L2 Switch, L3 Switch and Firewall (and, where a lab needs
it, Access Point and Wireless Router through their shared switch/router bases).
A Hub, PC, Smartphone and External Appliance have no agent.

## Transport

UDP 161 for queries and UDP 162 for traps, carried as structured messages
exactly like the DNS, TFTP, NTP and RADIUS models. Nothing is byte-encoded.

## Communities

A community string is a shared secret and is treated like every other
management credential: stored, compared and reported only as an opaque,
scope-bound fingerprint (`snmp:<device-id>`).

The configuration UI accepts a community, an access level (read-only) and an
optional source-manager restriction. After saving it shows:

```
Community configured
```

and never displays the value again. `show snmp community` and
`show running-config` both redact it, and it never appears in a trap, a trace,
a poll result or a grading diagnostic.

## The built-in SimulatorNet MIB

The MIB is **fixed and built in**. It reports only state the engine actually
models — there is no CPU, memory or temperature object, because a deterministic
protocol simulator has no honest value for one.

Standard objects keep their well-known OIDs:

| Object | OID |
| --- | --- |
| `sysDescr` | `1.3.6.1.2.1.1.1.0` |
| `sysObjectID` | `1.3.6.1.2.1.1.2.0` (a SimulatorNet profile OID) |
| `sysUpTime` | `1.3.6.1.2.1.1.3.0` (virtual runtime, in TimeTicks) |
| `sysContact` | `1.3.6.1.2.1.1.4.0` |
| `sysName` | `1.3.6.1.2.1.1.5.0` |
| `sysLocation` | `1.3.6.1.2.1.1.6.0` |
| `ifNumber` | `1.3.6.1.2.1.2.1.0` |
| `ifDescr` / `ifType` | `1.3.6.1.2.1.2.2.1.2` / `.3` |
| `ifAdminStatus` / `ifOperStatus` | `1.3.6.1.2.1.2.2.1.7` / `.8` |
| `ifInUcastPkts` / `ifOutUcastPkts` | `1.3.6.1.2.1.2.2.1.11` / `.17` |
| `ifInDiscards` / `ifOutDiscards` | `1.3.6.1.2.1.2.2.1.13` / `.19` |
| IPv4 interface addresses | `1.3.6.1.2.1.4.20.1.1` |

SimulatorNet-specific objects live under its own enterprise subtree
`1.3.6.1.4.1.53535.1`: IPv6 interface addresses, route count, neighbour count,
an STP root/port-state summary, OSPFv2 and OSPFv3 neighbour counts, an
EtherChannel count, the wireless associated-client count, the firewall session
count and the NAT translation count.

That subtree is **educational**. It is internal to this simulator, is not
registered with IANA, and must never be pointed at real equipment.

`sysUpTime` comes from virtual time, so it is reproducible: two runs of the same
lab with the same seed report the same value.

## NMS and MIB Browser

The Server gains a **Network Management** service: an SNMP manager plus a trap
receiver. It holds managed devices, their target address, a community credential
profile, and a bounded trap inbox.

The MIB Browser shows the target, the community profile, a static built-in OID
tree, and the value, type and timestamp of each result, with GET, GETNEXT and
WALK. No MIB code is ever executed and the tree is never loaded dynamically.

Host tools drive the same service:

```text
snmpget <target> <oid>
snmpwalk <target> <oid>
sim show snmp traps
```

They are explicitly **host/NMS commands**, not Cisco IOS commands.

A WALK is a real sequence of GETNEXT requests over the simulated UDP stack, so a
learner sees the same packet exchange a real manager produces. It stops at the
first OID outside its root subtree and is bounded by `maximumWalkLength`.

## Traps

```text
snmp-server host 192.168.50.10 version 2c <community>
snmp-server enable traps
```

Supported: `coldStart`, `warmStart`, `linkUp`, `linkDown`,
`authenticationFailure`, STP root change, OSPF neighbour down, and wireless
client associated/disassociated.

Every trap is bounded, carries a virtual timestamp, the source device and a
safe OID/type/value set. A trap never carries a password, an enable secret, a
community, an AAA shared key or a terminal command secret.

Traps are bounded **per operation**, so a flapping link cannot flood a lab.

## Device CLI

```text
snmp-server community <input> ro     (UI / import: stored as a fingerprint)
snmp-server location <text>
snmp-server contact <text>
snmp-server host <ip> version 2c <input>
snmp-server enable traps

show snmp
show snmp community
show snmp host
```

The Firewall, Access Point and Wireless Router are configured through the
structured UI; SimulatorNet does not present them as Cisco IOS.

## Packet Trace

Packet Trace gains Telnet, SSH, AAA, RADIUS, TACACS+ and SNMP filters. Trace
rows show metadata — protocol, device, OID counts, result — never secrets.

## Runtime versus configuration

Persisted: the agent enabled flag, community fingerprints and access, location,
contact, the traps-enabled flag, trap destinations and NMS target profiles.

Never persisted: poll results, the trap inbox and every counter.

## Limits

`SNMP_LIMITS` bounds communities per agent, trap destinations, managers, OIDs
per request, WALK length, traps per operation, stored traps, polling targets and
OID length. Nothing is unbounded.
