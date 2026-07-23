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
| L2 Switch | IOS-like switch | `SW1>`, `SW1#`, `SW1(config)#`, `SW1(config-if)#` | VLANs, access/trunk ports, MAC learning |
| Bridge | Managed bridge subset | `BR1>`, `BR1#`, `BR1(config-if)#` | Interface state/description and MAC table |
| PC | Windows-like host | `C:\>` | `ipconfig`, `ping`, `tracert`, `arp -a`, `nslookup`, `netstat` |
| Server | Host/service profile | `SRV1>` | Host diagnostics plus explicit SimulatorNet service inspection |
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
same deterministic commands through the worker adapter.

## Deliberate omissions

The following familiar IOS operations are not implemented and are omitted from
contextual help: startup configuration, `copy`, `write`, `erase`, `reload`,
`no ip address`, `no ip route`, dynamic routing, STP/RSTP, EtherChannel, CDP,
LLDP, port security, ACLs, NAT and IPv6. There is no Tab completion, fuzzy
matching, network-device `traceroute`, arbitrary command scripting, real
DNS/network access or full Cisco contextual-help parity.
