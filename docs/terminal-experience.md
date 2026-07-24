# Terminal experience

The device terminal is an **educational console**, not a real Telnet or SSH
connection. It renders a Cisco-*like* CLI served by the deterministic simulation
worker and is styled to feel like a real network-appliance console.

## Appearance

`View → Terminal Appearance` offers three local-only profiles (never stored in a
LabDocument):

- **Appliance Console** (default): near-black background, neutral light-grey
  monospace text, blinking block cursor, dense output.
- **Modern Dark**
- **Light Console**

Fonts use a system stack only — no font asset is downloaded or committed:

```
"DejaVu Sans Mono", "Liberation Mono", Consolas, "Courier New", monospace
```

Cursor is a blinking block, scrollback is bounded, and the ANSI palette is chosen
for readability. The appearance is independent of the workspace light/dark theme.

## Output safety

CLI output is sanitized before it reaches the screen: any escape sequence an
imported config might carry — CSI, OSC/DCS strings, title changes, clipboard
(OSC 52) and device-control sequences — is stripped, so only the terminal's own
generated sequences ever run. Password input is never echoed and never enters the
scrollback, history, transcript or logs.

## Interaction

- **Pagination**: output taller than the viewport shows `--More--`. Space
  advances a page, Enter advances one line, and `q`/`Esc` stop. Pagination is a
  terminal-UI concern and never advances the simulation's virtual time.
- **Copy/paste**: Ctrl/Cmd+C copies the current selection (or sends interrupt
  when there is none); paste is supported. A pasted password stays invisible.
- **Clear**: Ctrl+L clears the viewport and scrollback.
- **History**: per-device command history with Up/Down.
- **Resize**: the terminal fits its container via `ResizeObserver` + FitAddon
  without clipping the last line, duplicating the prompt, or losing the current
  input.

## Windows and sessions

The terminal is hosted both **docked** (bottom dock, one tab per device) and
**floating** (the per-device window's CLI tab). Moving between surfaces keeps the
worker-owned session, its scrollback and its login state. Closing a tab closes
that UI session; reopening creates a new session and re-requires login when
authentication is enabled. Deleting a device closes only its matching tabs.

## Contextual help

`?` lists only commands that are actually implemented, in aligned columns — it
does not reproduce the thousands of commands of a real IOS. See
[cli-compatibility.md](cli-compatibility.md) for the supported command surface,
and [console-authentication.md](console-authentication.md) for the login flow.
