# Terminal experience

SimulatorNet provides one terminal workspace for all open device sessions.
Routers, switches, PCs, and servers share the same tab strip while every device
keeps an isolated CLI session and command history.

## Presentation modes

The terminal has three presentations:

- **Docked** — a resizable bottom workspace that remains attached to the main
  application layout.
- **Floating** — a movable, resizable window clamped to the usable viewport.
- **Maximized** — the terminal temporarily takes the workspace for focused CLI
  work.

Changing presentation does not create a new terminal. The same mounted session
preserves:

- authentication and privilege mode;
- the current input line;
- command history;
- scrollback and pager state;
- search state;
- the underlying worker CLI session.

Closing or hiding the terminal presentation also does not close its device tabs.
The selected presentation is a local preference stored under
`simulatornet.terminalPresentation`; it is not part of `LabDocument`.

Hiding or minimizing the bottom panel is likewise a display change only. A
docked terminal simply has no slot to draw into; its session, buffer, history,
authentication and pending paste are untouched, and xterm is not fitted while
it has no measurable size. Only **Close Tab** ends a CLI session. See
`docs/workspace-layout.md`.

## Device windows

The CLI tab in a device window is a launcher for the shared terminal workspace.
It opens or focuses that device's terminal tab. A device window never mounts a
second xterm instance.

This avoids competing prompts, duplicated Ctrl+L output, split history, and
session state that changes depending on which surface sent a command.

## Tabs and session lifetime

Each open device has at most one terminal tab. Tabs can be activated, reordered,
or managed from their context menu:

- Close
- Close Others
- Close Tabs to the Right

Closing a tab terminates only the matching terminal/CLI session. Deleting a
stopped device closes its matching tab and device window, but leaves every
other device session intact. Stale device IDs must be removed before another
worker request is sent, so deletion never produces `Unknown device`.

Tabs survive Docked/Floating/Maximized transitions. Reloading or closing the lab
starts new sessions.

## Keyboard controls

Application-level controls:

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd+J` | Toggle the bottom panel |
| `Ctrl/Cmd+\`` | Show or hide the terminal |
| `Ctrl/Cmd+Shift+\`` | Toggle Docked and Floating |
| `Ctrl/Cmd+Alt+Enter` | Maximize or restore |
| `Escape` | Restore a maximized terminal |
| `Ctrl/Cmd+W` | Close the active tab, only while focus is inside the terminal |
| `Ctrl/Cmd+PageUp` | Activate the previous terminal tab |
| `Ctrl/Cmd+PageDown` | Activate the next terminal tab |

Terminal input also supports:

- `ArrowUp` and `ArrowDown` for the active device's history;
- `Ctrl+L` to clear the visible terminal and redraw one prompt;
- `Enter` on an empty line to emit one fresh prompt;
- `Ctrl/Cmd+V` and `Shift+Insert` to paste;
- normal xterm selection and copy behavior;
- toolbar search without changing the CLI buffer.

Global shortcuts ignore ordinary typing targets. `Ctrl/Cmd+W` outside the
terminal is not captured, so the browser keeps its normal behavior.

## Pasting commands

xterm is the only CLI input; there is no separate HTML command form. Clipboard
text arrives through the browser's own paste event on the terminal container —
`Ctrl/Cmd+V`, `Shift+Insert`, the right-click menu, and whatever middle-click
paste the platform provides natively. Nothing listens for clipboard events on
`document`, and no clipboard permission is requested at startup.

### One command

Clipboard text with no line break is inserted into the current input line at
the caret. It is never executed on its own: the user presses `Enter`. Pasting
at the start, the middle, or the end of a line all work, and cursor keys,
`Home`/`End`, `Backspace`/`Delete` and history keep working afterwards.

### Several commands

Clipboard text containing line breaks is a bulk command paste. The paste is
merged into the current input line at the caret, exactly like a real terminal:
already-typed text becomes part of the first command, and anything after the
caret trails the last fragment.

A compact confirmation popover over the terminal lists the commands before
anything runs:

```text
Paste 6 commands into R1?
```

Confirming executes the lines in order through the normal CLI parser and
session, so modes change naturally, output appears between commands, and each
line becomes its own history entry. Blank lines behave like a plain `Enter`.

`CRLF`, lone `CR` and `LF` all normalize to the same sequence. A trailing
newline means the last command runs; without one, the final line is left in the
input buffer unexecuted.

The confirmation is a local preference under
`simulatornet.confirmMultilinePaste` (default on), toggled from
View ▸ Terminal ▸ Confirm Multi-line Paste. It is never part of `LabDocument`,
a submission, grading, or the database.

### Interactive prompts

A pasted sequence stops before answering a prompt that expects input — a
Username, a Password, an enable secret, an interactive ping target, a
`[confirm]`/`[yes/no]` question, or `--More--` pagination. The terminal prints:

```text
Pasted command sequence paused for interactive input.
```

A queued network operation in Step mode pauses the sequence too, rather than
hanging silently. The remaining lines stay in a bounded pending queue; the user
answers the prompt and then chooses **Continue Paste** or **Cancel Remaining**.
Cancelling drops the rest of the sequence, including its trailing fragment. A
command is never silently turned into a credential.

### Credentials

Pasting into a Username, Password or enable-secret prompt is allowed. The
characters are not echoed, not recorded in command history, not written to the
transcript or to Problems, and not logged. The temporary buffer is cleared on
submit. A multi-line paste is refused at a credential prompt, as is text
containing NUL or control characters.

### Sanitization and limits

Pasted content is plain text. CSI sequences, OSC clipboard/title/hyperlink
commands, DCS/SOS/PM/APC strings, lone escapes, C1 controls and DEL are
stripped; NUL and other binary bytes are refused outright. Printable Unicode,
spaces and line breaks survive; a tab becomes a single space so the line
editor's caret arithmetic stays correct. No terminal path uses `innerHTML` or
`dangerouslySetInnerHTML`.

All bounds live in `TERMINAL_PASTE_LIMITS`:

| Limit | Value |
| --- | --- |
| Characters per paste | 100,000 |
| Lines per paste | 1,000 |
| Queued commands | 500 |
| Raw clipboard text | 1,048,576 characters |
| Credential characters | 1,024 |

Exceeding a limit reports `Paste is too large.` with the specific maximum and
queues nothing.

### Right-click menu

The terminal context menu offers Copy, Paste, Select All, Clear Terminal,
Search and Close Tab. Copy is disabled without a selection. Menu Paste uses the
Clipboard API after that explicit user action; a denied, unavailable or empty
clipboard is reported safely:

```text
Clipboard access was not granted.
Use Ctrl+V to paste into the terminal.
```

**Clear Terminal** clears the visible buffer only. The CLI mode, authentication,
command history, input line and worker session all stay open. **Close Tab** is
the action that ends a CLI session.

With a selection, `Ctrl/Cmd+C` copies it. Without one it does not fabricate a
process interrupt — Ctrl+C interruption is not implemented.

Paste behaves identically in Docked, Floating and Maximized presentations, and
changing presentation preserves the pasted text, the caret, history, a pending
paste, the authentication state and the CLI mode.

## Prompt and command rendering

The prompt has one visible trailing space. Submitted input is echoed once,
followed by output and exactly one next prompt. Clearing the display does not
reopen the CLI session or concatenate prompts.

Typical prompts include:

```text
C:\>
SW1>
SW1#
SW1(config)#
SW1(config-if)#
R1(config-subif)#
```

Contextual help, syntax errors, validation errors, paging, and ordinary command
output remain terminal text. Control sequences and imported content are
sanitized before display.

Long output uses bounded pagination. Search, history, and transcript storage are
bounded so a device cannot grow the browser DOM or worker state without limit.

## Layout and fitting

xterm owns scrolling inside its terminal viewport. The Docked/Floating/Maximized
containers clip overflow and must not add a second text scrollbar.

Resize and presentation changes trigger a bounded fit after the container has a
real size. Observers and animation frames are disposed with the session. A
larger bottom dock therefore gives the terminal more rows instead of leaving an
unused blank region.

## Appearance

Terminal appearance profiles control font, size, weight, line height, cursor,
scrollback, and theme through local preferences. They do not affect CLI
behavior, device configuration, lab persistence, or grading.

The terminal is a simulated local console. SimulatorNet does not provide real
SSH or Telnet access to host machines or external network devices.

## Remote sessions (M10.7)

A remote CLI session is **not** a second terminal implementation. It is pushed
onto the terminal that opened it: the local host session stays intact
underneath, keeps its scrollback and history, and `exit` returns to the host
prompt.

```
C:\>
→ ssh admin@192.168.10.2
→ R1>
→ exit
→ C:\>
```

While a remote session is open the tab shows what it is really driving, for
example `PC1 → SSH R1` or `PC1 → Telnet SW1`, with the source host, protocol,
target and connection state. Docked, Floating and Maximized all preserve the
same session; only **Close Tab** ends it, which also closes the simulated TCP
connection and frees the VTY line.

A remote credential prompt is treated exactly like the console one: the input is
never echoed, never recorded in command history, never written to the transcript
or Problems, and never logged. The terminal derives an opaque, scope-bound
fingerprint in the main thread and sends only that to the worker, so no
plaintext password ever reaches the simulation engine.

Native paste keeps working inside a remote CLI. A pasted sequence **pauses** at a
remote credential prompt rather than answering it with the next command line,
just as it pauses at a console login or a `[confirm]` prompt.

Deleting the device, stopping the lab, or losing the link closes the remote
session and returns the terminal to the host prompt with a stated reason.
