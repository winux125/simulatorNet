# Wireless simulation

SimulatorNet implements a deterministic educational wireless LAN model. It
does not access real wireless hardware and does not provide real 802.11
encryption.

## Architecture

`WirelessMedium` lives in `sim-core` and is shared unchanged by the browser
worker and server verifier. It owns bounded radio domains, AP and station
registrations, management-event scheduling, association state, and wireless L2
delivery. It has no React, AntV X6, DOM, Node filesystem, or network dependency.

Wireless reachability is explicit structured configuration:

- radio domain;
- 2.4 GHz or 5 GHz band;
- supported/configured channel;
- enabled state;
- SSID and optional preferred BSSID;
- saved-network and auto-connect preference.

Canvas coordinates do not represent range, signal, path loss, or interference.
Moving a device is a presentation change and cannot alter association, packet
delivery, grading, or runtime state.

## Association

A station progresses deterministically through `disabled`, `disconnected`,
`scanning`, `authenticating`, `associating`, `associated`, or `failed`.
Beacon, Probe, Authentication, Association, Disassociation, and
Deauthentication are structured management messages scheduled on virtual time;
they are not raw 802.11 byte encodings and are not passed through IP ACLs.

Passive scans omit hidden SSIDs. Naming an SSID explicitly can discover a
compatible hidden network. Candidate order is preferred BSSID, AP priority,
then stable BSSID. Every scan, candidate list, association attempt, management
event, and pending wireless frame has a finite centralized limit.

After association, the wireless interface becomes an L2 bearer for the existing
ARP/NDP, IPv4/IPv6, DHCP/DHCPv6, TCP/UDP, and application stacks. Auto drains
the bounded sequence through address acquisition and the requested operation.
Step exposes Beacon, Probe, Authentication, Association, DHCP/SLAAC, ARP/NDP,
and application events one at a time.

## Open and WPA2-Personal

Open and WPA2-Personal networks are supported. The WPA2 model validates an
opaque credential fingerprint; it does not encrypt simulated data or implement
the real four-way handshake. UI/import adapters use Web Crypto
PBKDF2-HMAC-SHA-256 to derive SSID-scoped verifier material before entering the
event loop. The AP and saved client profile persist compatible verifier
material, never the plaintext passphrase.

Password input may be revealed only while the user is typing it. After save the
UI says `Security key configured`; the key is absent from terminal history,
trace, Problems, import reports, logs, student results, and normal configuration
views. Unsupported imported vendor hashes require a credential reset.

## Access Point bridge

An Access Point bridges associated wireless stations to its Ethernet uplink
using the existing L2 forwarding behavior. It learns MAC addresses and forwards
broadcast and unicast frames, but it does not route, assign DHCP addresses, run
NAT, or become a firewall. A client receives DHCP/SLAAC only when the bridged
wired network contains a configured service/router. Optional client isolation
blocks direct station-to-station delivery without blocking wired access.

## Wireless Router

The Wireless Router is a composition of existing components:

- Access Point and a shared LAN L2 switch;
- IPv4/IPv6 router;
- DHCPv4 and optional RA/SLAAC/DHCPv6;
- static or DHCP WAN;
- PAT overload;
- established-return stateful firewall.

Its initial home-router preset is visible structured configuration and can be
edited or disabled. Wireless and LAN Ethernet clients share the configured LAN;
the WAN remains a separate routed/security boundary.

## Roaming

Roaming is supported between compatible APs with the same SSID and security in
one radio domain. It is triggered by current-AP shutdown, explicit selection,
preferred-BSSID change, or client-capacity failure. Selection uses preferred
BSSID, AP priority, then stable BSSID—never signal strength or randomness.

Within the same bridged LAN, the station keeps its MAC and IP/transport state
where protocol rules allow; AP forwarding state updates and connectivity
continues. A different L2 network requires normal address-protocol
reinitialization. AP shutdown and security change produce explicit
deauthentication reasons in Packet Trace.

## Persistence, UI, and grading

Schema-v1 labs persist radio/interface configuration, SSID/security verifier,
AP limits/preferences, saved client profiles, and Wireless Router
LAN/WAN/service policy. Scan results, current association, management queues,
leases, AP runtime clients, and roaming events are rebuilt and never persisted.

View ▸ Wireless Associations controls a dashed runtime-only station-to-AP
overlay. It is not a physical link, has no X6 port, cannot be connected through
the cable modal, and never enters `LabDocument.topology.links`.

Grading can check association, SSID/security mode, client count, wireless
IPv4/IPv6 addressing, connectivity, roaming, and Wireless Router NAT. The
verifier rebuilds and runs the simulation independently. Student results never
contain expected PSKs or credential verifier material.

## Deliberate limits

M10.6 has no real RF propagation, signal strength, path loss, interference,
rate adaptation, packet-level 802.11 encoding, real encryption, WEP, WPA3,
WPA-Enterprise, 802.1X/RADIUS/EAP, wireless controller, mesh, cellular,
Bluetooth, browser network API, or access to host wireless hardware.
