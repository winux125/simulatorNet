# CLI compatibility

SimulatorNet exposes device-specific learning profiles. It follows familiar
Cisco IOS command shapes for managed network devices and a Windows-like command
prompt for PCs, but it is not an IOS emulator. Commands that are absent from a
profile's help are unsupported.

SimulatorNet implements a deterministic educational subset of Cisco IOS-like
network CLI and Packet Tracer-style host tools.

## Profiles and prompts

| Device | Profile | Prompt examples | Intended surface |
| --- | --- | --- | --- |
| Router | IOS-like router | `R1>`, `R1#`, `R1(config)#`, `R1(config-if)#` | IPv4 interfaces, subinterfaces, static routes, DHCP server, show/ping |
| L3 Switch | IOS-like multilayer switch | `DSW1>`, `DSW1#`, `DSW1(config)#`, `DSW1(config-if)#` | L2 VLAN/trunk commands, SVIs, routed ports, static routes |
| Firewall | SimulatorNet firewall | `FW1>`, `FW1#`, `FW1(config)#`, `FW1(config-if)#` | Routed interfaces, ACL, NAT/PAT and deterministic diagnostics; not an ASA profile |
| L2 Switch | IOS-like switch | `SW1>`, `SW1#`, `SW1(config)#`, `SW1(config-if)#` | VLANs, access/trunk ports, MAC learning |
| Bridge | Managed bridge subset | `BR1>`, `BR1#`, `BR1(config-if)#` | Interface state/description and MAC table |
| PC / Laptop | Windows-like host | `C:\>` | `ipconfig`, `ping`, `tracert`, `arp -a`, `nslookup`, `netstat`; Laptop wireless setup remains in its Wireless panel |
| Server | Host/service profile | `SRV1>` | Host diagnostics plus explicit SimulatorNet service inspection |
| Smartphone | No required CLI | — | Focused Ping, DNS lookup and Web client UI |
| Access Point / Wireless Router | No IOS CLI | — | Vendor-neutral Wireless/Setup device-window controls |
| Hub | No CLI | — | Physical repeater state is shown in the UI |

PC and Server are intentionally separate profiles even though both reuse the
same deterministic end-host stack.

## Matching and contextual help

- Keywords are case-insensitive.
- A keyword may be abbreviated only to a unique prefix in the current device
  profile and CLI mode: `conf t`, `show run`, `show ip int br`, `int gi0/1`,
  `shut`, and `no shut`.
- Ambiguous prefixes return `% Ambiguous command: "<input>"`.
- Misspellings are not fuzzy-matched.
- `?`, `help`, and prefix help such as `show ?` or `ping ?` list only commands
  available on the current device and in the current mode.
- Router and L3 Switch accept a bare `ping` and prompt for
  `Target IP address:`. PC reports an incomplete command and shows
  `Usage: ping <ip-or-hostname>`.

## IOS-like command matrix

| Command | Router | L3 Switch | L2 Switch | Bridge |
| --- | :---: | :---: | :---: | :---: |
| `enable`, `disable`, `configure terminal`, `exit`, `end` | Yes | Yes | Yes | Yes |
| `hostname <name>` | Yes | Yes | Yes | Yes |
| `interface <name>` / `description` / `shutdown` / `no shutdown` | Yes | Yes | Yes | Yes |
| `ip address <ip> <mask>` | Yes | Yes | No | No |
| `encapsulation dot1Q <vlan> [native]` | Yes, subinterfaces | No | No | No |
| `ip route <network> <mask> <next-hop>` | Yes | Yes | No | No |
| `ip routing` / `no ip routing` | No | Yes | No | No |
| `vlan <id>` / `name <name>` | No | Yes | Yes | No |
| access/trunk `switchport` commands | No | Yes | Yes | No |
| `no switchport` / routed physical port | No | Yes | No | No |
| `show running-config` | Yes | Yes | Yes | Yes |
| `show interfaces` | Yes | Yes | Yes | Yes |
| `show ip interface brief` | Yes | Yes | Yes | No |
| `show ip route` | Yes | Yes | No | No |
| `show vlan brief` / `show interfaces trunk` | No | Yes | Yes | No |
| `show mac address-table` | No | Yes | Yes | Yes |
| `show arp` | Yes | Yes | No | No |
| `ping` | Yes | Yes | No | No |
| standard/extended IPv4 ACL configuration | Yes | Yes | No | No |
| `ip access-group`, `show access-lists`, `show ip interface` | Yes | Yes | No | No |
| NAT/PAT configuration and show commands | Yes | No | No | No |
| `mpls ip`, LDP and MPLS show commands | Yes | No | No | No |
| `vrf definition`, `vrf forwarding`, `ip route vrf` | Yes | No | No | No |
| BGP `address-family vpnv4` / `ipv4 vrf` | Yes | No | No | No |

## MPLS, LDP and L3VPN subset (M10.11)

Router configuration supports `mpls label protocol ldp`,
`mpls ldp router-id <Loopback> force`, interface `mpls ip`, canonical
`vrf definition` with `rd` and import/export `route-target`, interface
`vrf forwarding`, and `ip route vrf`.

The existing BGP process accepts `address-family vpnv4`, neighbor `activate`
and `send-community extended`, plus `address-family ipv4 vrf <name>` with
explicit `redistribute connected|static`. Inspection includes `show mpls
interfaces`, `show mpls ldp neighbor|bindings`, `show mpls forwarding-table`,
`show vrf`, `show ip route vrf` and `show bgp vpnv4 unicast`.

This is an educational subset, not full IOS parity. Help does not advertise
MPLS-TE, RSVP, xconnect/pseudowire, VPNv6, EVPN, Segment Routing, route
reflectors, targeted LDP or PE-CE dynamic routing.

## Consolidated compatibility matrix

| Command | Router | L2 Switch | L3 Switch | Bridge | PC | Server | Compatibility | Notes |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | --- | --- |
| `enable`, `configure terminal`, modes | Yes | Yes | Yes | Yes | No | No | IOS-like | Bridge uses only the managed subset |
| `interface`, `description`, shutdown state | Yes | Yes | Yes | Yes | No | No | IOS-like | Physical interfaces; L3 also supports SVI selection |
| `ip address` | Yes | No | Yes | No | No | No | IOS-like | Router interfaces/subinterfaces and L3 routed interfaces/SVIs |
| `ip route` | Yes | No | Yes | No | No | No | IOS-like | Static IPv4 routes only |
| VLAN and `switchport` configuration | No | Yes | Yes | No | No | No | IOS-like | L3 physical ports may use `no switchport` |
| `show running-config`, `show interfaces` | Yes | Yes | Yes | Yes | No | No | IOS-like | Generated from canonical structured state |
| `show ip interface brief` | Yes | Yes | Yes | No | No | No | IOS-like | L2 addresses are currently unassigned |
| `show ip route`, `show arp` | Yes | No | Yes | No | No | No | IOS-like | Transient route/ARP state is not persisted |
| VLAN/trunk/MAC show commands | No | Yes | Yes | MAC only | No | No | IOS-like | Bridge exposes only its learned MAC table |
| `ping` | Yes | No | Yes | No | Yes | Yes | IOS-like / host-like | Network devices support direct and simplified interactive forms |
| `ipconfig` variants | No | No | No | No | Yes | Yes | Packet Tracer host-like | Deterministic IPv4/DHCP state |
| `tracert`, `arp -a`, `nslookup`, `netstat` | No | No | No | No | Yes | Yes | Packet Tracer host-like | `tracert` is a simplified reachability trace |
| `sim http/tftp/ntp/syslog ...` | No | No | No | No | Yes | Yes | SimulatorNet extension | Desktop tools use the same worker commands |
| `sim show services/dns/http/tftp/syslog` | No | No | No | No | No | Yes | SimulatorNet extension | Read-only service inspection |
| `show startup-config`, `copy run start`, `write`, `erase startup-config`, `reload` | Yes | Yes | Yes | Yes | No | No | IOS-like | See the configuration lifecycle below |

## Configuration lifecycle (M10.9.1)

Structured device configuration is the single source of truth. `show
running-config` renders it deterministically; the startup configuration is a
separate structured snapshot of the same model, never a second text copy.

| Command | Mode | Behaviour |
| --- | --- | --- |
| `show running-config` | user / privileged | Rendered from structured state; secrets appear only as `<configured>` |
| `show startup-config` | privileged | The saved snapshot, or `% startup-config is not present` |
| `copy running-config startup-config` (`copy run start`) | privileged | Copies the structured running snapshot into NVRAM |
| `write memory` / `write` (`wr`) | privileged | The same save, with the short IOS output |
| `erase startup-config` | privileged | `[confirm]`; running configuration is untouched until a reload |
| `reload` | privileged | `[yes/no]` when modified, then `[confirm]`; reloads this device only |

A reload replaces one device instance: its runtime state (ARP/MAC tables,
learned routes, leases, sessions, translations, security associations, queues)
is discarded and it boots from its startup configuration — factory defaults if
the NVRAM was erased. The topology is not rebuilt and every other device keeps
running. See [`device-configuration.md`](device-configuration.md).

## Host commands

| Command | PC | Server | Notes |
| --- | :---: | :---: | --- |
| `ipconfig` | Yes | Yes | Current deterministic IPv4 configuration |
| `ipconfig /all` | Yes | Yes | Includes hostname, DHCP and DNS |
| `ipconfig /renew` / `/release` | Yes | Yes | Operates on the simulated DHCP client |
| `ping <ip-or-hostname>` | Yes | Yes | Five deterministic echo attempts; names use simulated DNS |
| `tracert <ip-or-hostname>` | Yes | Yes | Simplified reachability trace, not hop-by-hop TTL parity |
| `arp -a` | Yes | Yes | Current transient ARP cache |
| `nslookup <hostname> [dns-server]` | Yes | Yes | Deterministic simulated DNS |
| `netstat` | Yes | Yes | Simulated UDP/TCP sockets only |

## SimulatorNet extensions

Application-service helpers are deliberately namespaced so they are not
mistaken for native IOS or Windows commands:

```text
sim http get <url>
sim tftp get <server-ip> <filename>
sim ntp query <server-ip>
sim show clock
sim syslog send <server-ip> <severity> <message>
sim show udp sockets
sim show tcp connections
```

Server adds `sim show services`, `sim show dns`, `sim show http`,
`sim show tftp`, and `sim show syslog`. The PC/Server Desktop tools call these
same deterministic commands through the worker adapter. Laptop wireless
connection, password entry, saved-network management, and AP configuration
remain in the Wireless UI. Smartphone, Access Point, and Wireless Router
deliberately do not pretend to expose Cisco IOS.

Firewall accepts the Router security command shapes through its distinct
SimulatorNet firewall profile. L3 Switch accepts ACLs on routed ports and SVIs,
but rejects NAT with a direct domain error.

## IPv4 ACL and NAT/PAT subset

```text
access-list 10 permit 192.168.10.0 0.0.0.255
access-list 10 deny any
access-list 100 permit tcp 192.168.10.0 0.0.0.255 any eq 80

ip access-list standard USERS
 permit 192.168.10.0 0.0.0.255
 deny any

ip access-list extended WEB
 permit tcp any host 203.0.113.10 eq 80
 deny ip any any

interface Gi0/0
 ip access-group USERS in
 ip nat inside

interface Gi0/1
 ip nat outside

ip nat inside source static 192.168.10.10 203.0.113.10
ip nat pool PUBLIC 203.0.113.100 203.0.113.110 netmask 255.255.255.0
ip nat inside source list 10 pool PUBLIC
ip nat inside source list 10 interface Gi0/1 overload

show access-lists
show ip interface
show ip nat translations
show ip nat statistics
clear ip nat translation *
```

ACL matching is ordered and first-match with an implicit deny. The policy
engine supports IPv4, ICMP, TCP/UDP and bounded `eq`/`range` port matches; the
current CLI creation subset exposes `eq`, while structured configuration may
use either matcher. NAT supports static one-to-one, bounded dynamic pools and
PAT; it does not support hairpin NAT.

## Control protocols (M10.4)

Spanning tree, EtherChannel, neighbour discovery and OSPFv2. See
[`layer2-control-protocols.md`](layer2-control-protocols.md),
[`neighbor-discovery.md`](neighbor-discovery.md) and
[`ospf-simulation.md`](ospf-simulation.md) for the modelled subsets.

```
spanning-tree mode pvst
spanning-tree mode rapid-pvst
no spanning-tree mode
spanning-tree vlan 10 priority 24576
spanning-tree vlan 10 root primary
spanning-tree vlan 10 root secondary

interface Gi0/1
 spanning-tree cost 19
 spanning-tree port-priority 64
 spanning-tree portfast
 spanning-tree bpduguard enable

interface range Gi0/1 - 2
 channel-group 1 mode on | active | passive | desirable | auto

interface Port-channel1
 switchport mode trunk
 switchport trunk allowed vlan 10,20

cdp run
lldp run
interface Gi0/1
 cdp enable
 lldp transmit
 lldp receive

interface Loopback0
 ip address 10.255.0.1 255.255.255.255

router ospf 1
 router-id 1.1.1.1
 network 10.0.0.0 0.0.0.255 area 0
 passive-interface Loopback0

interface Gi0/0
 ip ospf 1 area 0
 ip ospf cost 10
 ip ospf priority 100
 ip ospf network point-to-point
 ip ospf hello-interval 10
 ip ospf dead-interval 40

show spanning-tree
show spanning-tree vlan 10
show spanning-tree interface Gi0/1
show spanning-tree summary
show etherchannel summary
show etherchannel port-channel
show interfaces port-channel
show lacp neighbor
show pagp neighbor
show cdp neighbors [detail]
show cdp interface
show lldp neighbors [detail]
show lldp interface
show ip ospf
show ip ospf neighbor [detail]
show ip ospf interface [brief]
show ip ospf database
show ip route ospf

clear ip ospf process
clear cdp table
clear lldp table
errdisable recovery Gi0/1
```

`clear ip ospf process` asks for confirmation, resets the OSPF runtime, keeps
the configuration and starts the process again. `errdisable recovery` clears the
runtime error-disabled state left by BPDU Guard.

`interface range <first> - <last>` configures several interfaces at once. The
range is expanded and validated **before** anything is changed, so one bad
member never leaves a half-applied range.

Useful abbreviations: `show span`, `show etherchannel sum`, `show cdp nei`,
`show lldp nei`, `show ip ospf nei`, `show ip ospf int br`. An abbreviation that
still matches more than one command remains an error.

`root primary` / `root secondary` set a deterministic low priority (24576 /
28672); they do not promise full Cisco automation.

## Management plane (M10.7)

Router, L2 Switch, L3 Switch and Firewall only. See
[`remote-management.md`](remote-management.md), [`aaa-simulation.md`](aaa-simulation.md)
and [`snmp-management.md`](snmp-management.md).

| Command | Mode | Notes |
| --- | --- | --- |
| `interface vlan <id>` | config | On an L2 Switch this selects the single management interface |
| `ip address <ip> <mask>` | config-if | Addresses the L2 management SVI; routing stays disabled |
| `ip default-gateway <ip>` | config | Host default route for management replies only |
| `ip domain-name <name>` | config | Required before a simulated host key |
| `crypto key generate rsa [modulus <bits>]` | config | Derives an educational fingerprint, never key material |
| `crypto key zeroize rsa` | config | Removes the fingerprint and disables SSH |
| `ip ssh version 2` | config | Version 2 only |
| `line vty <first> <last>` | config | Enters `config-line` |
| `login` / `login local` / `no login` | config-line | Line password, local database, or no login |
| `login authentication <list>` | config-line | Selects an AAA method list |
| `authorization exec <list>` | config-line | Selects an AAA exec authorization list |
| `transport input {telnet \| ssh \| all \| none}` | config-line | |
| `exec-timeout <minutes> [seconds]` | config-line | Applied when virtual time is advanced |
| `aaa new-model` | config | Enables the AAA decision layer |
| `aaa authentication login <list> <methods>` | config | `local`, `none`, `group radius`, `group tacacs+` |
| `aaa authorization exec\|commands <level> <list> <methods>` | config | |
| `aaa accounting exec\|commands <level> <list> <mode> <methods>` | config | `start-stop`, `stop-only`, `none` |
| `radius server <name>` / `tacacs server <name>` | config | Enters `config-aaa-server` |
| `address ipv4\|ipv6 <ip> [auth-port <p> acct-port <p>]` | config-aaa-server | |
| `timeout <seconds>` | config-aaa-server | |
| `snmp-server location\|contact <text>` | config | |
| `snmp-server enable traps` | config | |
| `show users` / `show line` | exec/privileged | Active remote sessions and VTY lines |
| `show ip ssh` / `show ssh` | exec/privileged | Simulated SSH server state |
| `show aaa servers` / `show aaa method-lists` | exec/privileged | Keys are shown as `configured`, never rendered |
| `show snmp` / `show snmp community` / `show snmp host` | exec/privileged | Communities are redacted |
| `clear line vty <n>` | privileged | Drops the session on that line |

Host commands: `telnet <host> [port]`, `ssh <user>@<host>`,
`ssh -l <user> <host> [port]`, and on a Server `snmpget`, `snmpwalk` and
`sim show snmp traps`.

Commands that *set* a secret — `username … secret`, `enable secret`, a line
`password`, a AAA `key`, and `snmp-server community`/`snmp-server host` — are
configured through the credential UI panels and the importer, which derive a
verifier asynchronously. The interactive CLI never handles a plaintext secret.

## Quality of service (M10.8)

An educational MQC subset. It is not full MQC and not Cisco hardware parity.

| Command | Mode | Notes |
| --- | --- | --- |
| `class-map match-any\|match-all <name>` | config | Enters `config-cmap` |
| `match any` | config-cmap | |
| `match dscp <0-63\|default\|cs0-cs7\|af11-af43\|ef>` | config-cmap | |
| `match precedence <0-7>` / `match cos <0-7>` | config-cmap | |
| `match protocol <icmp\|tcp\|udp>` | config-cmap | |
| `match access-group [name] <acl>` | config-cmap | IPv4 or IPv6 ACL as a selector |
| `match source-port <port>` / `match destination-port <port>` | config-cmap | |
| `no class-map <name>` | config | |
| `policy-map <name>` | config | Enters `config-pmap` |
| `class <class-map\|class-default>` | config-pmap | Enters `config-pmap-c` |
| `set dscp <value>` / `set precedence <0-7>` / `set cos <0-7>` | config-pmap-c | |
| `priority percent <1-100>` | config-pmap-c | Strict priority with a built-in policer |
| `bandwidth percent <1-100>` | config-pmap-c | Deficit round robin weight |
| `police <bps> <burst> [conform-action transmit exceed-action drop]` | config-pmap-c | Never delays |
| `police <bps> <burst> conform-action transmit exceed-action set-dscp-transmit <dscp>` | config-pmap-c | Marks down |
| `shape average <bps>` | config-pmap-c | Delays; drops only when the queue fills |
| `queue-limit <1-4096> packets` | config-pmap-c | Per-class tail-drop depth |
| `service-policy input\|output <policy-map>` | config-if | |
| `no service-policy input\|output` | config-if | |
| `show class-map` / `show policy-map` | exec/privileged | |
| `show policy-map interface` | exec/privileged | Per-class matched/marked/dropped counters |
| `show queueing interface <name>` | exec/privileged | Depth, drops, virtual wait |
| `show interfaces counters` | exec/privileged | Per-port queue counters |
| `clear qos counters` | privileged | Clears runtime counters only |

See [`qos-simulation.md`](qos-simulation.md).

## Site-to-site VPN (M10.9)

Router and Firewall only. **SimulatorNet models deterministic educational GRE
and site-to-site IPsec behaviour; its simulated ESP/IKE implementation does not
provide real cryptographic protection.** The `sim-` transform names exist so
that is never mistaken.

| Command | Mode | Notes |
| --- | --- | --- |
| `interface Tunnel<n>` | config | Logical; no cable, never a topology link |
| `ip address <ip> <mask>` / `ipv6 address <addr>/<len>` | config-if | Overlay addressing |
| `tunnel source <interface\|ip>` | config-if | Must resolve to a usable local address |
| `tunnel destination <ip>` | config-if | Resolved through the underlay table |
| `tunnel mode gre ip` | config-if | The only supported mode |
| `tunnel mtu <576-9000>` | config-if | Oversize packets drop; no fragmentation |
| `tunnel ttl <1-255>` | config-if | Outer TTL |
| `tunnel protection ipsec profile <name>` | config-if | One profile per tunnel |
| `no tunnel protection ipsec profile` | config-if | Back to plain GRE |
| `crypto ikev2 proposal <name>` | config | |
| `encryption sim-aes128\|sim-aes256` | config-ikev2-proposal | Simulated transform |
| `integrity sim-sha256` | config-ikev2-proposal | Simulated transform |
| `crypto ikev2 peer <name>` | config | |
| `address <ip>` | config-ikev2-peer | |
| `pre-shared-key` | config-ikev2-peer | No-echo prompt; only a verifier is stored |
| `proposal <name>` / `lifetime <60-86400>` | config-ikev2-peer | |
| `identity local\|remote <name>` | config-ikev2-peer | Optional |
| `crypto ipsec profile <name>` | config | |
| `set ikev2-peer <name>` / `set proposal <name>` | config-ipsec-profile | |
| `lifetime <60-86400>` | config-ipsec-profile | Drives the deterministic rekey |
| `show interfaces tunnel` | exec/privileged | Names why a tunnel is down |
| `show crypto ikev2 sa` | exec/privileged | Session state and role |
| `show crypto ipsec sa` | exec/privileged | SPIs, sequence, counters |
| `show crypto session` | exec/privileged | Per-tunnel summary |
| `clear crypto ikev2 sa` / `clear crypto ipsec sa` | privileged | Runtime only |
| `deny esp \| gre any any` | config-acl | Block a VPN on the underlay |

`show running-config` renders a stored key as `pre-shared-key <configured>`; the
key and its verifier are never printed. See [`vpn-tunnels.md`](vpn-tunnels.md).

## BGP and route policy (M10.10)

Router and an L3 Switch with `ip routing` support one educational IPv4-unicast
BGP process. The commands below configure the same structured process used by
the browser worker and verifier; they are not a claim of full IOS parity.

| Command | Mode | Notes |
| --- | --- | --- |
| `router bgp <1-4294967295>` | config | Enters the single BGP process |
| `bgp router-id <ipv4>` | config-router | Optional stable router ID |
| `neighbor <ipv4> remote-as <asn>` | config-router | Defines or updates a peer |
| `neighbor <ipv4> description <text>` | config-router | |
| `neighbor <ipv4> update-source <interface>` | config-router | Physical, SVI or Loopback source |
| `neighbor <ipv4> ebgp-multihop <1-255>` | config-router | eBGP otherwise uses TTL 1 |
| `neighbor <ipv4> next-hop-self` | config-router | Primarily for iBGP |
| `neighbor <ipv4> prefix-list <name> in\|out` | config-router | Ordered prefix policy |
| `neighbor <ipv4> route-map <name> in\|out` | config-router | Ordered attribute policy |
| `network <network> mask <mask>` | config-router | Requires an exact route in the IPv4 RIB |
| `ip prefix-list <name> seq <n> permit\|deny <prefix> [ge <n>] [le <n>]` | config | No regex matching |
| `route-map <name> permit\|deny <sequence>` | config | Enters `config-route-map` |
| `match ip address prefix-list <name>` | config-route-map | |
| `match neighbor <ipv4>` / `match route-source local\|ebgp\|ibgp` | config-route-map | |
| `match as-path length <n>` | config-route-map | Bounded length test, not an AS-path regex |
| `set local-preference <n>` / `set metric <n>` / `set weight <n>` | config-route-map | |
| `set as-path prepend <count>` / `set origin igp\|incomplete` | config-route-map | Prepends the local AS |
| `show ip bgp` / `show ip bgp <prefix>` | exec/privileged | BGP RIB and path detail |
| `show ip bgp summary` / `show ip bgp neighbors [peer]` | exec/privileged | FSM/TCP state and counters |
| `show ip route bgp` / `show ip bgp rib-failure` | exec/privileged | Installed routes and rejected candidates |
| `show ip prefix-list` / `show route-map` | exec/privileged | Structured policy configuration |
| `clear ip bgp *` / `clear ip bgp <peer>` | privileged | Confirmation required; configuration remains |

See [`routing-bgp.md`](routing-bgp.md) for the exact best-path order, bounded
timer model, persistence boundary and limitations.

## Deliberate omissions

The following familiar IOS operations are not implemented and are omitted from
contextual help: `copy` to or from a network
server or flash (only `copy running-config startup-config` exists),
EIGRP/IS-IS, multi-area OSPF, OSPF
authentication and redistribution, MSTP and MST regions, Loop Guard, Root Guard,
UDLD, UplinkFast/BackboneFast/Flex Links, multi-chassis EtherChannel, LACP fast
rate, PAgP silent modes, LLDP-MED, port security, reflexive/time-based ACLs, NAT
hairpinning, WPA3, 802.1X, wireless controllers, mesh, or real RF. QoS omits
WRED/RED (`random-detect`), per-flow WFQ (`fair-queue`), hierarchical policies,
`mls qos`, NBAR (`match protocol http`), MPLS EXP and any platform queue
model. There is no fuzzy matching, arbitrary command scripting, real DNS/network access or full Cisco
contextual-help parity. See [M10.17.5](m10.17.5-cli-compatibility.md) for token
abbreviations, help/Tab, configuration operators and bounded operational commands.

BGP family and policy coverage has expanded since the original CLI table; see
[routing-bgp.md](routing-bgp.md) and the [M10.17.5 matrix](m10.17.5-cli-compatibility.md)
for the implemented surface and remaining limitations.

The management plane omits, deliberately: real SSH cryptography, key exchange,
packet encryption, public-key user authentication, SCP/SFTP, tunnelling, port
forwarding and SSH agents; full Telnet option negotiation; 802.1X, EAP, CoA,
downloadable ACLs and wireless enterprise authentication; real RADIUS and
TACACS+ packet crypto; and SNMPv1, SNMPv3, USM, VACM, BER/ASN.1 encoding,
dynamic MIB loading, arbitrary OID scripting and SNMP SET. Nothing in
SimulatorNet reaches a real device or a real network.

The site-to-site VPN omits, deliberately: IKEv1, ISAKMP policies, main and
aggressive mode, Diffie-Hellman, perfect forward secrecy configuration, crypto
maps, transform sets, certificates and PKI trustpoints, remote-access VPN,
DMVPN, GETVPN, NHRP, multipoint GRE, IPsec transport mode, NAT traversal,
multiple child SAs per tunnel, and tunnel keys or GRE checksums. A Firewall uses
the same SimulatorNet VPN configuration as a Router; no ASA parity is claimed.
