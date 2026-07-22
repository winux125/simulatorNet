import { describe, expect, it } from "vitest";
import { LineBuffer, classifyTerminalKey } from "./terminal-line-editor";

describe("LineBuffer", () => {
  it("inserts printable text at the caret", () => {
    const buffer = new LineBuffer();
    buffer.insert("ping ");
    buffer.insert("192.168.10.2");
    expect(buffer.value).toBe("ping 192.168.10.2");
    expect(buffer.cursor).toBe(buffer.value.length);
    expect(buffer.tail).toBe(0);
  });

  it("supports mid-line editing: move left, then backspace an interior character", () => {
    const buffer = new LineBuffer();
    for (const ch of "ping 192.168.10.42") buffer.insert(ch);
    // Remove the stray '4' before the final '2' by stepping the caret back over '2'.
    expect(buffer.left()).toBe(true); // caret now sits between '4' and '2'
    expect(buffer.backspace()).toBe(true); // deletes the '4'
    expect(buffer.value).toBe("ping 192.168.10.2");
    expect(buffer.cursor).toBe("ping 192.168.10.".length);
  });

  it("inserts in the middle of the line at the caret position", () => {
    const buffer = new LineBuffer();
    for (const ch of "ping 192.168.10.2") buffer.insert(ch);
    buffer.home();
    expect(buffer.cursor).toBe(0);
    buffer.right(); buffer.right(); buffer.right(); buffer.right(); // after "ping"
    buffer.insert("6");
    expect(buffer.value).toBe("ping6 192.168.10.2");
  });

  it("clamps caret movement at both ends", () => {
    const buffer = new LineBuffer();
    buffer.insert("show");
    expect(buffer.right()).toBe(false);
    buffer.home();
    expect(buffer.left()).toBe(false);
    buffer.end();
    expect(buffer.cursor).toBe(4);
    expect(buffer.tail).toBe(0);
  });

  it("deletes forward under the caret", () => {
    const buffer = new LineBuffer();
    for (const ch of "arp") buffer.insert(ch);
    buffer.home();
    expect(buffer.deleteForward()).toBe(true);
    expect(buffer.value).toBe("rp");
    expect(buffer.cursor).toBe(0);
  });

  it("replaces the whole line and parks the caret at the end (history recall)", () => {
    const buffer = new LineBuffer();
    buffer.insert("half typed");
    buffer.replace("show vlan brief");
    expect(buffer.value).toBe("show vlan brief");
    expect(buffer.cursor).toBe("show vlan brief".length);
  });
});

describe("classifyTerminalKey", () => {
  it("maps control sequences to editing intents", () => {
    expect(classifyTerminalKey("\r")).toEqual({ kind: "enter" });
    expect(classifyTerminalKey("\x7f")).toEqual({ kind: "backspace" });
    expect(classifyTerminalKey("\x1b[D")).toEqual({ kind: "left" });
    expect(classifyTerminalKey("\x1b[C")).toEqual({ kind: "right" });
    expect(classifyTerminalKey("\x1b[A")).toEqual({ kind: "history-prev" });
    expect(classifyTerminalKey("\x1b[B")).toEqual({ kind: "history-next" });
    expect(classifyTerminalKey("\x1b[H")).toEqual({ kind: "home" });
    expect(classifyTerminalKey("\x1b[F")).toEqual({ kind: "end" });
    expect(classifyTerminalKey("\x0c")).toEqual({ kind: "clear" });
    expect(classifyTerminalKey("\x03")).toEqual({ kind: "interrupt" });
  });

  it("treats printable characters (including pasted chunks) as insertions", () => {
    expect(classifyTerminalKey("a")).toEqual({ kind: "insert", text: "a" });
    expect(classifyTerminalKey("ping 10.0.0.1")).toEqual({ kind: "insert", text: "ping 10.0.0.1" });
  });

  it("ignores unhandled control input", () => {
    expect(classifyTerminalKey("\x1b[5~")).toBeUndefined();
    expect(classifyTerminalKey("")).toBeUndefined();
  });
});
