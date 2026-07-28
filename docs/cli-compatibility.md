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
| startup config, `copy`, `write`, `reload` | No | No | No | No | No | No | Unsupported | Omitted from contextual help |

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

## Deliberate omissions

The following familiar IOS operations are not implemented and are omitted from
contextual help: startup configuration, `copy`, `write`, `erase`, `reload`,
`no ip address`, `no ip route`, EIGRP/BGP/IS-IS, multi-area OSPF, OSPF
authentication and redistribution, MSTP and MST regions, Loop Guard, Root Guard,
UDLD, UplinkFast/BackboneFast/Flex Links, multi-chassis EtherChannel, LACP fast
rate, PAgP silent modes, LLDP-MED, port security, reflexive/time-based ACLs, NAT
hairpinning, WPA3, 802.1X, wireless controllers, mesh, or real RF. There
is no Tab completion, fuzzy matching, network-device
`traceroute`, arbitrary command scripting, real DNS/network access or full Cisco
contextual-help parity.

The management plane omits, deliberately: real SSH cryptography, key exchange,
packet encryption, public-key user authentication, SCP/SFTP, tunnelling, port
forwarding and SSH agents; full Telnet option negotiation; 802.1X, EAP, CoA,
downloadable ACLs and wireless enterprise authentication; real RADIUS and
TACACS+ packet crypto; and SNMPv1, SNMPv3, USM, VACM, BER/ASN.1 encoding,
dynamic MIB loading, arbitrary OID scripting and SNMP SET. Nothing in
SimulatorNet reaches a real device or a real network.
