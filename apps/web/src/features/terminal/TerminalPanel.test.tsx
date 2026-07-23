// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { TerminalCommandHistory } from "./terminal-history";

describe("terminal command history", () => {
  it("keeps device session histories isolated", () => {
    const pc = new TerminalCommandHistory();
    const sw = new TerminalCommandHistory();
    pc.record("ping 192.168.20.10");
    sw.record("show vlan brief");
    expect(pc.previous()).toBe("ping 192.168.20.10");
    expect(sw.previous()).toBe("show vlan brief");
    expect(pc.next()).toBe("");
    expect(sw.previous()).toBe("show vlan brief");
  });

  it("keeps interactive ping input but excludes contextual help queries", () => {
    const router = new TerminalCommandHistory();
    router.record("show ?");
    router.record("ping");
    router.record("192.168.10.2");
    expect(router.previous()).toBe("192.168.10.2");
    expect(router.previous()).toBe("ping");
    expect(router.previous()).toBe("ping");
  });
});
