// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRM_MULTILINE_PASTE_STORAGE_KEY,
  isInteractivePrompt,
  normalizeNewlines,
  pastePreview,
  persistConfirmMultilinePaste,
  prepareSecretPaste,
  prepareTerminalPaste,
  readConfirmMultilinePaste,
  sanitizePasteText,
  TERMINAL_PASTE_LIMITS,
} from "./terminal-paste";

function ready(raw: string) {
  const plan = prepareTerminalPaste(raw);
  if (plan.status !== "ready") throw new Error(`expected a ready plan, got ${plan.status}`);
  return plan;
}

describe("paste newline handling", () => {
  it.each([
    ["CRLF", "configure terminal\r\ninterface Gi0/1\r\n"],
    ["CR", "configure terminal\rinterface Gi0/1\r"],
    ["LF", "configure terminal\ninterface Gi0/1\n"],
  ])("normalizes %s into the same command sequence", (_name, clipboard) => {
    expect(ready(clipboard).commands).toEqual(["configure terminal", "interface Gi0/1"]);
  });

  it("normalizes lone CR and CRLF to LF without touching other characters", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("keeps a single command without a newline in the input buffer", () => {
    const plan = ready("show ip route");
    expect(plan.commands).toEqual([]);
    expect(plan.remainder).toBe("show ip route");
    expect(plan.bulk).toBe(false);
  });

  it("executes a single command that ends with a newline, without confirmation", () => {
    const plan = ready("show ip route\n");
    expect(plan.commands).toEqual(["show ip route"]);
    expect(plan.remainder).toBe("");
    expect(plan.bulk).toBe(false);
  });

  it("runs completed lines and leaves an unterminated final line unexecuted", () => {
    const plan = ready("configure terminal\ninterface Gi0/1\ndescription Uplink");
    expect(plan.commands).toEqual(["configure terminal", "interface Gi0/1"]);
    expect(plan.remainder).toBe("description Uplink");
    expect(plan.bulk).toBe(true);
  });

  it("treats a blank line as an ordinary Enter and preserves order", () => {
    expect(ready("configure terminal\n\nend\n").commands).toEqual(["configure terminal", "", "end"]);
  });

  it("preserves meaningful inner spacing", () => {
    expect(ready("description  Uplink   to R2\n").commands).toEqual(["description  Uplink   to R2"]);
  });
});

describe("paste sanitization", () => {
  it("strips CSI, OSC clipboard/title/hyperlink and device control sequences", () => {
    const hostile = "\x1b]52;c;cGF5bG9hZA==\x07\x1b]0;pwned\x07\x1b[31mshow ip route\x1b[0m\x1bPq\x1b\\";
    expect(sanitizePasteText(hostile)).toBe("show ip route");
  });

  it("rejects NUL and other binary content instead of repairing it", () => {
    expect(prepareTerminalPaste("show ip\u0000route")).toMatchObject({ status: "rejected" });
    expect(prepareTerminalPaste("\u001cbinary\u001f")).toMatchObject({ status: "rejected" });
  });

  it("converts a tab to a single space so the caret arithmetic stays correct", () => {
    expect(ready("ip route\t10.0.0.0\n").commands).toEqual(["ip route 10.0.0.0"]);
  });

  it("keeps printable Unicode", () => {
    expect(ready("description Ядро — площадка\n").commands).toEqual(["description Ядро — площадка"]);
  });

  it("reports an all-control paste as empty rather than executing nothing", () => {
    expect(prepareTerminalPaste("\x1b[2J\x1b[H")).toEqual({ status: "empty" });
    expect(prepareTerminalPaste("")).toEqual({ status: "empty" });
  });
});

describe("paste limits", () => {
  it("refuses more characters than the central limit", () => {
    const plan = prepareTerminalPaste("a".repeat(TERMINAL_PASTE_LIMITS.maximumCharacters + 1));
    expect(plan).toMatchObject({ status: "rejected" });
    if (plan.status === "rejected") expect(plan.message).toContain("Paste is too large.");
  });

  it("refuses more lines than the central limit", () => {
    const plan = prepareTerminalPaste("show version\n".repeat(TERMINAL_PASTE_LIMITS.maximumLines + 1));
    expect(plan).toMatchObject({ status: "rejected" });
    if (plan.status === "rejected") expect(plan.message).toContain("lines");
  });

  it("refuses raw clipboard text above the byte-scale limit before scanning it", () => {
    expect(prepareTerminalPaste("x".repeat(TERMINAL_PASTE_LIMITS.maximumRawCharacters + 1)))
      .toMatchObject({ status: "rejected" });
  });

  it("refuses to queue more commands than the pending limit", () => {
    const plan = prepareTerminalPaste("a\n".repeat(20), {
      ...TERMINAL_PASTE_LIMITS,
      maximumPendingCommands: 5,
    });
    expect(plan).toMatchObject({ status: "rejected" });
    if (plan.status === "rejected") expect(plan.message).toContain("commands");
  });
});

describe("credential paste", () => {
  it("accepts one plain line verbatim, without sanitizing it", () => {
    expect(prepareSecretPaste("  Str0ng!Pass\\word  ")).toEqual({ status: "ready", text: "  Str0ng!Pass\\word  " });
  });

  it("rejects a multi-line credential paste", () => {
    expect(prepareSecretPaste("first\nsecond")).toMatchObject({ status: "rejected" });
    expect(prepareSecretPaste("first\r\nsecond")).toMatchObject({ status: "rejected" });
  });

  it("rejects NUL and control characters", () => {
    expect(prepareSecretPaste("pass\u0000word")).toMatchObject({ status: "rejected" });
    expect(prepareSecretPaste("pass\x1b[31mword")).toMatchObject({ status: "rejected" });
  });

  it("rejects an oversized credential", () => {
    expect(prepareSecretPaste("p".repeat(TERMINAL_PASTE_LIMITS.maximumSecretCharacters + 1)))
      .toMatchObject({ status: "rejected" });
  });
});

describe("interactive prompt detection", () => {
  it.each(["C:\\>", "R1>", "R1#", "R1(config)#", "SW1(config-if)#"])("treats %s as a shell prompt", (prompt) => {
    expect(isInteractivePrompt(prompt)).toBe(false);
  });

  it.each([
    "Username:",
    "Password:",
    "Target IP address:",
    "Reset ALL OSPF processes? [yes/no]: ",
    "Destination filename [startup-config]?",
    "[confirm]",
  ])("treats %s as a prompt that must pause a pasted sequence", (prompt) => {
    expect(isInteractivePrompt(prompt)).toBe(true);
  });

  it("ignores an empty prompt", () => {
    expect(isInteractivePrompt("   ")).toBe(false);
  });
});

describe("paste preview", () => {
  it("bounds the confirmation preview and reports the hidden remainder", () => {
    const commands = Array.from({ length: 30 }, (_, index) => `command ${index}`);
    const preview = pastePreview(commands, "trailing", 12);
    expect(preview.lines).toHaveLength(12);
    expect(preview.total).toBe(31);
    expect(preview.hidden).toBe(19);
  });

  it("includes the unterminated final line in the preview", () => {
    expect(pastePreview(["end"], "show ip route").lines).toEqual(["end", "show ip route"]);
  });
});

describe("multi-line paste confirmation preference", () => {
  beforeEach(() => window.localStorage.clear());

  it("is enabled by default", () => {
    expect(readConfirmMultilinePaste()).toBe(true);
  });

  it("persists locally only, under its documented key", () => {
    persistConfirmMultilinePaste(false);
    expect(window.localStorage.getItem(CONFIRM_MULTILINE_PASTE_STORAGE_KEY)).toBe("false");
    expect(readConfirmMultilinePaste()).toBe(false);
    persistConfirmMultilinePaste(true);
    expect(readConfirmMultilinePaste()).toBe(true);
  });
});
