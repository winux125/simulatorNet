import { MANAGEMENT_LIMITS } from "@sim/contracts";
import { NS_PER_MS, NS_PER_S } from "@sim/sim-core";

export { MANAGEMENT_LIMITS };

/** How long a client waits for the remote device to accept its connection. */
export const REMOTE_CONNECT_TIMEOUT_NS = 4 * NS_PER_S;

/** How long a client waits for the output of one submitted command. */
export const REMOTE_COMMAND_TIMEOUT_NS = 4 * NS_PER_S;

/** Granularity of the idle-timeout sweep on a managed device. */
export const REMOTE_IDLE_TICK_NS = 500 * NS_PER_MS;

/**
 * Trim remote text to a finite, printable form. Newline and tab survive; every
 * other C0/C1 control character is dropped so a managed device can never emit
 * an escape sequence into an originating terminal.
 */
export function boundedRemoteText(value: string, maximum: number): string {
  let printable = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x0a || code === 0x09) printable += character;
    else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) printable += character;
  }
  return printable.length > maximum ? `${printable.slice(0, maximum)}\n% Output truncated.` : printable;
}
