import type { TerminalInputPrompt } from "@sim/console-auth";

const NON_HISTORY_PROMPTS = new Set([
  "Username:",
  "Password:",
  "Continue connecting (yes/no)?",
]);

/** Convert LF/CRLF output into the CRLF sequence xterm expects. */
export function terminalText(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

/**
 * Adapt a worker CLI prompt to the same exact input model used by local
 * console authentication.
 */
export function cliInputPrompt(text: string, secret = false): TerminalInputPrompt {
  return {
    text: text.length > 0 ? `${text.trimEnd()} ` : "",
    echo: secret ? "hidden" : "plain",
    history: !secret && !NON_HISTORY_PROMPTS.has(text.trimEnd()),
    completion: "line",
  };
}

/**
 * Render output followed by an inline input prompt.
 *
 * Output receives a final CRLF only when it does not already own one. Prompt
 * text never receives a line break here; line submission is the sole owner of
 * the following CRLF.
 */
export function renderPromptTransition(
  output: string,
  prompt: TerminalInputPrompt | undefined,
): string {
  const normalized = terminalText(output);
  const outputWithLineEnding = normalized.length === 0 || normalized.endsWith("\r\n")
    ? normalized
    : `${normalized}\r\n`;
  return `${outputWithLineEnding}${prompt?.text ?? ""}`;
}
