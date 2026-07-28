# Remote management: simulated Telnet and SSH

SimulatorNet lets a PC, Laptop or Server manage a Router, L2 Switch, L3 Switch
or Firewall over the **simulated network**. A remote command is not a shortcut
into the target device: it travels through routing, ACLs, NAT, firewall policy,
interface state and TCP, is authenticated, and is then executed by the same
`cli-engine` parser the local console uses.

## What is and is not simulated

**Simulated SSH is an educational model, not cryptography.** There is no key
exchange, no packet encryption, no public-key user authentication, no SCP or
SFTP, no tunnelling, no port forwarding and no agent. `crypto key generate rsa`
derives a deterministic *fingerprint* from stable device identity and the
configured domain name; it is an identity string, never key material.

**Simulated Telnet has no option negotiation.** It models a TCP connect, a login
prompt, command input and output, logout, idle timeout, multiple VTY lines, and
the plaintext-security warning:

```
Warning: Telnet transmits credentials without encryption.
```

That warning is the teaching point. Even so, no password ever reaches a
SimulatorNet log, trace or grading result — see *Credentials* below.

Manageable devices are **Router, L2 Switch, L3 Switch and Firewall**. A Hub, PC,
Smartphone, Access Point, Cloud, Traffic Generator and External Appliance
deliberately have no management plane. The Wireless Router stays UI-managed.

## Architecture

```
PC/Laptop/Server host terminal
  → TCP connection            (sim-core transport: routing, ACL, NAT, TCP)
  → RemoteCliService          (@sim/remote-management)
  → authentication            (shared decision layer, see docs/aaa-simulation.md)
  → dedicated CliSession      (@sim/cli-engine)
  → device configuration API  (@sim/sim-core)
  → output back over the simulated TCP path
  → the originating terminal
```

`packages/remote-management` is a pure cross-runtime package. It depends on
`sim-core`, `cli-engine`, `console-auth` and `contracts`, and nothing depends on
it except `lab-format`, which builds one `ManagementPlane` per lab. The browser
worker and the headless verifier therefore build the same plane from the same
`LabDocument` and reach the same deterministic result.

`cli-engine` never imports `remote-management`. It declares two small structural
interfaces (`RemoteSessionBridge`, `RemoteSessionOpener`) that the runtime
injects, so the dependency direction stays one-way.

## Credentials

A credential must be comparable **inside** the deterministic engine, which is
synchronous and must never see a plaintext secret. So — exactly like the
educational WPA2-PSK model — Web Crypto derives an opaque, scope-bound verifier
*before* any packet or event processing:

1. the device stores a `credentialFingerprint` for each local user;
2. when a device asks for a secret it publishes a **credential scope**;
3. the terminal derives the fingerprint for that scope in the main thread;
4. only the fingerprint crosses the simulated wire.

Scopes bind a secret to one slot (`user:admin`, `line:vty`, `enable`,
`key:<server>`, `snmp:<device>`), so the same password never becomes valid
somewhere it was not configured.

Consequences, all enforced:

- a plaintext password never enters sim-core, a trace, Problems or a log;
- a credential is never echoed, never recorded in command history and never
  written to the transcript;
- a grading spec never carries a password: the verifier rebuilds the submitted
  lab and replays the stored fingerprint.

There is exactly **one** local-user database per device
(`ConsoleAccessConfiguration.users`). The simulated console, the VTY lines,
Telnet, SSH and the AAA `local` method all resolve against it.

## Management addresses

Router, L3 Switch and Firewall use their existing L3 interfaces and loopbacks.

An **L2 Switch** gets a management SVI:

```text
interface vlan 10
 ip address 192.168.10.2 255.255.255.0
 no shutdown

ip default-gateway 192.168.10.1
```

The management SVI:

- does **not** enable IP routing and never forwards a transit packet;
- terminates local management traffic only — ping, Telnet, SSH, SNMP, Syslog
  and AAA;
- is operationally up only while an active switchport still carries the VLAN;
- uses `ip default-gateway` as a host default route for its own replies.

An L2 Switch remains a layer-2 forwarding device. An L3 Switch uses real routed
SVIs instead and has no management-only SVI.

## VTY lines

```text
line vty 0 4
 login local
 transport input ssh telnet
 exec-timeout 10 0
```

Runtime line state is `free`, `authenticating`, `active`, `idle` or `closing`.
It is runtime only and never serialized. When every eligible line is busy:

```
% All remote terminal lines are in use.
```

`exec-timeout` is evaluated when virtual time is explicitly advanced. Auto
drains every queued event regardless of its timestamp, so a self-scheduled idle
timer would push virtual time forward on its own and close healthy sessions.

## Host commands

```text
telnet <ip-or-hostname> [port]
ssh <username>@<ip-or-hostname>
ssh -l <username> <ip-or-hostname> [port]
```

IPv4 and IPv6 destinations both work through the shared transport. A bare
hostname is matched against managed device names, so `telnet SW1` works in a
classroom lab without a DNS server.

A remote session is pushed **onto** the host terminal; the local host session
stays intact underneath:

```
C:\>
→ ssh admin@192.168.10.2
→ R1>
→ exit
→ C:\>
```

Closing the TCP session, exhausting the VTY line, losing the link, deleting the
device or stopping the lab all return the terminal to the host prompt with a
stated reason.

## Auto and Step

In **Auto**, the TCP handshake, login and each command complete as one bounded
operation before the result is rendered. In **Step**, the TCP and management
events stay observable in Packet Trace, the terminal states that the operation
is queued, and the session continues after Step or Run All. The terminal is
never left without an explanation.

## Device CLI

```text
username admin privilege 15 secret <password>     (UI / import: stored as a verifier)
ip domain-name lab.local
crypto key generate rsa modulus 2048
ip ssh version 2

line vty 0 4
 login local
 transport input ssh telnet
 exec-timeout 10 0

show users
show line
show ip ssh
show ssh
clear line vty <number>
```

Secret-setting commands are configured through the credential UI panels and the
importer, which can derive a verifier asynchronously; the interactive CLI never
handles a plaintext secret. The Firewall uses SimulatorNet's own management
profile — this is not Cisco ASA parity.

## Limits

Every limit is finite and centralized in `MANAGEMENT_LIMITS`: VTY line index,
remote sessions per device and per lab, failed login attempts, exec-timeout
range, known hosts per client, queued terminal lines, and command and output
size.

## Runtime versus configuration

Persisted in `LabDocument`: the management SVI and default gateway, the Telnet
master switch, the simulated SSH host-key configuration, VTY line configuration,
local users and their verifiers.

Never persisted: active remote sessions, VTY allocations, known-hosts state,
login attempts, and every counter. Old schema-v1 labs stay valid — a lab that
never touched remote management serializes byte-identically to before.
