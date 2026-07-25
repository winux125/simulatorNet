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
- normal xterm selection and copy/paste behavior;
- toolbar search without changing the CLI buffer.

Global shortcuts ignore ordinary typing targets. `Ctrl/Cmd+W` outside the
terminal is not captured, so the browser keeps its normal behavior.

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
