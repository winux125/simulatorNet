# Console authentication

SimulatorNet devices can require a simulated console login. This is an
**educational login for a simulated device** and is deliberately separate from
everything below:

- It is **not** the SimulatorNet account login (Keycloak / platform session).
- It is **not** an organization role or API authorization.
- It is **not** a real Telnet/SSH security boundary.

Console authentication state never affects packet determinism or grading — the
browser and the headless verifier ignore it when computing connectivity.

## Which devices support it

Router, L2 switch, L3 switch, firewall, bridge (disabled by default) and server
can require a console login. Hub, PC, cloud, traffic generator and
external-appliance placeholders cannot: the schema does not carry
`consoleAccess` for them, so a hub can never enable auth and an external
appliance only shows an "auth likely required" hint until it is mapped.

## Configuring it

Device Window → Config → Console Access:

- **Authentication**: None / Password / Local User.
- **Local users**: username, password and privilege level (0–15).
- **Enable secret**, **login/MOTD banners**, **maximum attempts**.

A new password is hashed into a **verifier** before it touches the document; an
existing password or hash is never displayed — only "Password configured" and a
Reset action. `show running-config` prints a redacted representation and never
reveals a stored hash.

## Password storage

New passwords are never stored in the clear. Each verifier is
PBKDF2-HMAC-SHA-256 (Web Crypto, works in the browser worker and in Node) with a
random salt, bounded iterations, and algorithm/version fields, compared in
constant time:

```json
{ "algorithm": "pbkdf2-sha256", "iterations": 120000, "saltBase64": "…", "hashBase64": "…" }
```

The crypto lives in `@sim/console-auth`, not in the deterministic packet engine.

## Login flow

The session lifecycle is `disconnected → awaiting-return → awaiting-username →
awaiting-password → authenticated-user-exec → privileged-exec`. Commands are
never passed to the CLI parser until authentication succeeds.

Authentication uses the terminal's ordinary line editor with an explicit input
policy. `Username: ` uses plain echo without command history; `Password: ` and
the enable-secret prompt use hidden echo without history. Prompt text is written
inline without a newline. Submitting the line owns exactly one CRLF, so local
console, Telnet, and SSH all render the same way:

```text
Username: admin
Password:
% Login invalid

Username:
```

A password never changes the visible cursor position while it is typed:
characters, replacement stars, pasted text, and the secure buffer are not
rendered. Resizing, clearing, docking, floating, or maximizing the shared
terminal preserves the active prompt and buffer without printing the prompt
again.

- **Press RETURN**: `Press RETURN to get started!` → prompt.
- **Password**: `Password:` (input not echoed).
- **Local user**: `Username:` then `Password:` (not echoed). Success → `Router>`
  (or `Router#` for a privilege-15 user). Failure → `% Login invalid`; after the
  maximum attempts → `% Authentication failed`, and the session restarts.
- **Enable**: `Router> enable` → `Password:`; success → `Router#`; failure →
  `% Access denied`.

Passwords are never echoed, added to history, logged, or written to analytics.
Reopening a terminal starts a fresh login; the stored verifier is preserved
across stop/start and through export/import.

## Imported credentials

When an imported config contains an explicit **plaintext** credential, a verifier
is created, the raw password is removed from the preserved artifact, and the
report records "Explicit console credential imported and converted to a verifier"
without showing the password. When it contains a vendor **hash** SimulatorNet
cannot verify, no active credential is created: the device is flagged
`credentialResetRequired` and you must set a new simulated password. Known default
vendor passwords are never substituted automatically.
