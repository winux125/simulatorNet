# AAA, RADIUS and TACACS+ simulation

SimulatorNet has **one** authentication model. Console login, VTY lines, Telnet,
SSH and the AAA `local` method all resolve through the same decision layer and
the same per-device user database. There is deliberately no second local-user
implementation anywhere in the product.

## Method lists

```text
aaa new-model

aaa authentication login default group radius local
aaa authentication login VTY_LOGIN group tacacs+ local

aaa authorization exec default group tacacs+ local
aaa authorization commands 15 default group tacacs+ local

aaa accounting exec default start-stop group radius
aaa accounting commands 15 default start-stop group tacacs+
```

Supported methods are `local`, `group radius`, `group tacacs+` and `none`.

A list is walked in order and the **first conclusive result wins**:

| Result | Meaning | Next |
| --- | --- | --- |
| accept | The method authenticated the user | stop, success |
| reject | The method actively refused | stop, failure |
| unavailable / timeout | The method could not answer | try the next method |

This is the rule that matters most in a classroom: **a reachable RADIUS server
that rejects a login fails that login.** Local fallback happens only when the
server did not answer at all. A lab that sees unexpected fallback is looking at
an unreachable server, not a disagreeing one.

Without `aaa new-model`, the VTY line's own `login` / `login local` decides, and
the device authenticates against its local database exactly as before.

`?` never offers AAA syntax SimulatorNet does not simulate.

## Scope

Simulated: login authentication, exec authorization, command authorization (a
TACACS+ educational subset), and accounting start/stop/command.

**Not** simulated: 802.1X, wireless enterprise authentication, downloadable
ACLs, CoA, EAP, and full vendor AAA parity.

## RADIUS

An educational protocol model over the shared UDP stack: authentication on 1812
and accounting on 1813, with `Access-Request`, `Access-Accept`, `Access-Reject`,
`Accounting-Start` and `Accounting-Stop`, plus a bounded timeout and retry.

There is no Request Authenticator, no MD5 construction and no attribute
encoding. Messages are structured data, exactly like the DNS, TFTP and NTP
models.

## TACACS+

An educational protocol model over TCP 49: authentication, exec authorization,
per-command authorization and accounting. There is no body obfuscation.

Command authorization rules are **bounded and declarative**:

- match on username, privilege level, and command text;
- matching is exact, prefix, or prefix plus one explicit trailing `*`;
- rules are evaluated in sequence order, first match wins, then a configured
  default.

A `LabDocument` never supplies a regular expression, and nothing is compiled or
executed. A denied command returns:

```
% Authorization failed.
```

and is **not executed** — it never changes configuration.

## Shared secrets

A shared key is stored, compared and reported only as an opaque, scope-bound
fingerprint (`key:<server-name>`), never as plaintext. It never appears in a
trace, a result, a log or `show` output: `show aaa servers` reports a key as
`configured` or `not set` and nothing more.

The same is true of user passwords, on the device and on the AAA server: both
sides hold a fingerprint derived by Web Crypto before any packet processing, so
the deterministic engine compares opaque tokens.

## Device configuration

```text
radius server RAD1
 address ipv4 192.168.50.10 auth-port 1812 acct-port 1813
 key <secret>

tacacs server TAC1
 address ipv4 192.168.50.10
 key <secret>
```

IPv6 server addresses use the same shared endpoint model.

## Server services

The Server gains two services:

- **RADIUS** — users, allowed clients, password verifiers, privilege/role,
  enabled flag, shared-key verifier and an optional reply privilege;
- **TACACS+** — the same plus exec-authorization default, command rules and a
  command default.

Requests from an address that is not a configured client are rejected.

## Accounting

The server keeps a bounded runtime log: session start, session stop, command
events, the device, the user, a virtual timestamp and the result.

Accounting **redacts secret-setting command arguments** before storing them, so
a `username … secret …`, `enable secret …`, `password …`, `key …` or
`snmp-server community …` line keeps its shape and loses its argument.

Accounting entries are runtime state. They are never serialized into a
`LabDocument`, never submitted and never graded.

## Inspection

On a device: method lists, configured servers, server reachability, the last
authentication status and active AAA sessions.

On a server: users, clients, authentication counters and accounting entries —
never a password, a hash or a fingerprint.

## Import

The IOS-like subset is imported: `aaa new-model`, `aaa authentication`,
`aaa authorization`, `aaa accounting`, `radius server`, `tacacs server`, and
`login authentication` on a VTY line.

Plaintext keys and line passwords become verifiers and are removed from the
preserved artifact. A vendor password hash cannot be verified, so it produces a
reset requirement rather than a usable credential. Unsupported advanced syntax
is reported in the import report instead of being silently dropped.

## Limits

`AAA_LIMITS` bounds method lists, methods per list, servers per device, users
and clients per server, command rules, accounting entries, retries, server
timeout and command-pattern length. Nothing is unbounded.
