# Neighbour discovery (CDP and LLDP)

SimulatorNet implements a Cisco-like **CDP** subset and a vendor-neutral
**LLDP** subset. Both are educational: they carry the handful of fields a
CCNA-level lab uses and nothing more.

## Scope

| Feature | Status |
| --- | --- |
| CDP device id, port id, platform, capabilities, software string | yes |
| CDP management IPv4 and native VLAN | yes |
| LLDP chassis id, port id, port description, system name/description | yes |
| LLDP system capabilities, management address, TTL | yes |
| Explicit withdrawal (CDP hold time 0 / LLDP shutdown TTL 0) | yes |
| CDP version-specific obscure TLVs | **no** |
| LLDP-MED, PoE negotiation, voice VLAN | **no** |
| Location/emergency TLVs | **no** |
| SNMP integration | **no** |
| Duplex and speed advertisement | **no** — the engine does not model them |

## Device profile

Both protocols start **disabled** on every device. Enabling them by default
would add advertisements to every existing lab and change its deterministic
trace, so a lab turns them on with `cdp run` / `lldp run`.

| Device | CDP | LLDP | Advertised capabilities |
| --- | --- | --- | --- |
| Router | yes | yes | router |
| L2 Switch | yes | yes | switch, bridge |
| L3 Switch | yes | yes | switch, router |
| Firewall | yes | yes | router |
| Cloud / ISP | yes | yes | router |
| Server | **no** | yes | station |
| PC, Hub, Bridge, Traffic Generator | no | no | — |

`cdp run` on a Server is rejected with a clear error: a vendor-neutral station
speaks LLDP, not CDP. A PC never speaks either protocol automatically.

## Link-local by construction

A CDP or LLDP advertisement is an Ethernet control payload consumed by the
directly connected device's control plane. It therefore:

- is **never routed** and never crosses a Router;
- does not depend on end-user VLAN forwarding;
- is **never evaluated by an IP ACL** — the control plane terminates it before
  the policy pipeline;
- is exchanged on a **spanning-tree blocking port**, exactly like a BPDU. A
  blocked port stops user data, not link-local control. This is the documented
  rule and it is covered by a test.

## Timers and ageing

Defaults: CDP advertises every 60 s with a 180 s hold time; LLDP every 30 s with
a 120 s TTL. All values are virtual time and are stored in the lab document in
whole seconds.

**Neighbours age lazily**, exactly like the forwarding database: an entry is
dropped the first time the table is read after its hold time has passed. Ageing
therefore needs no scheduled event, so it can never keep a bounded Auto run
alive, can never age a table out in the middle of that same run, and can never
wake two neighbours into an endless advertise/expire cycle. Advancing virtual
time past the hold time still expires the entry, which is what a lab wants to
demonstrate.

Three things clear an entry earlier than the hold time:

1. **An explicit withdrawal.** `no cdp run`, `no cdp enable`, `no lldp run` and
   `no lldp transmit` send a final advertisement with hold time / TTL zero, so
   the neighbour clears immediately.
2. **A local interface going operationally down.** The local link state is
   authoritative and more useful in a lab than waiting out the hold time.
3. **An explicit `clear cdp table` / `clear lldp table`**, which is a runtime
   action and never a configuration change.

## Neighbour table

Runtime only — it is **never serialized** into a `LabDocument`. Each entry holds
the protocol, local interface, neighbour device id, remote interface, platform,
capabilities, management address, first/last seen and expiry, all in virtual
time.

`show cdp neighbors`, `show cdp neighbors detail`, `show cdp interface`,
`show lldp neighbors`, `show lldp neighbors detail` and `show lldp interface`
render it, and the device window's **Neighbors** tab shows a unified table with
a protocol filter.

Refreshing an existing neighbour updates its timestamps instead of appending, so
a table can never contain duplicate rows for the same
(protocol, local port, neighbour, remote port).

## Resource limits

| Limit | Value |
| --- | --- |
| Neighbours per device | 64 |
| Neighbours per lab | 512 |
| Advertisements per operation | 10,000 |

Exceeding the per-device bound raises a typed `ControlProtocolLimitError`.

See also [`layer2-control-protocols.md`](layer2-control-protocols.md) and
[`ospf-simulation.md`](ospf-simulation.md).
