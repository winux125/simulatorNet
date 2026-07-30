import { describe, expect, it } from "vitest";
import type { TerminalInputPrompt } from "@sim/console-auth";
import {
  cliInputPrompt,
  renderPromptTransition,
  terminalText,
} from "./terminal-input-prompt";

const usernamePrompt: TerminalInputPrompt = {
  text: "Username: ",
  echo: "plain",
  history: false,
  completion: "line",
};
const passwordPrompt: TerminalInputPrompt = {
  text: "Password: ",
  echo: "hidden",
  history: false,
  completion: "line",
};

describe("terminal input prompt rendering", () => {
  it("writes Username inline without manufacturing a leading input line", () => {
    expect(renderPromptTransition("", usernamePrompt)).toBe("Username: ");
    expect(`${renderPromptTransition("", usernamePrompt)}admin`).toBe("Username: admin");
  });

  it("keeps Password inline while its input policy remains hidden", () => {
    expect(renderPromptTransition("", passwordPrompt)).toBe("Password: ");
    expect(passwordPrompt.echo).toBe("hidden");
    expect(passwordPrompt.history).toBe(false);
  });

  it("renders one intentional blank line between a failure and retry prompt", () => {
    expect(renderPromptTransition("% Login invalid\n\n", usernamePrompt))
      .toBe("% Login invalid\r\n\r\nUsername: ");
  });

  it("places login banners directly before Username without a leading blank", () => {
    expect(renderPromptTransition("Authorized access only.\n", usernamePrompt))
      .toBe("Authorized access only.\r\nUsername: ");
  });

  it("adapts CLI and authentication prompts to explicit echo/history policies", () => {
    for (const [text, secret, echo, history] of [
      ["Username:", false, "plain", false],
      ["Password:", true, "hidden", false],
      ["Continue connecting (yes/no)?", false, "plain", false],
      ["R1#", false, "plain", true],
    ] as const) {
      expect(cliInputPrompt(text, secret)).toEqual({
        text: `${text} `,
        echo,
        history,
        completion: "line",
      });
    }
  });

  it("normalizes terminal output without adding line breaks to prompt text", () => {
    expect(terminalText("one\ntwo\r\nthree")).toBe("one\r\ntwo\r\nthree");
    expect(renderPromptTransition("% Access denied", undefined)).toBe("% Access denied\r\n");
  });
});
