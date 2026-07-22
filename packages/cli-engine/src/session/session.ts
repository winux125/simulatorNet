import type { Device, SimulationEngine } from "@sim/sim-core";
import { allCommands } from "../commands";
import { deviceMatches } from "../commands/helpers";
import { CliError, SyntaxError } from "../errors/errors";
import { tokenize } from "../lexer/lexer";
import { matchPattern } from "../parser/matcher";
import type { InterfaceContext, SessionApi } from "../types";
import { type CliMode, promptSuffix } from "./mode";

/**
 * A console session attached to a single device. It owns the CLI mode/context
 * and dispatches a typed line to the matching command handler. It contains no
 * network logic: handlers only call public `sim-core` methods.
 */
export class CliSession implements SessionApi {
  mode: CliMode = "exec";
  ifaceCtx: InterfaceContext | undefined;
  vlanId: number | undefined;

  constructor(
    readonly device: Device,
    readonly engine: SimulationEngine,
  ) {}

  /** The prompt shown before the next command, e.g. "S1(config-if)#". */
  prompt(): string {
    return `${this.device.name}${promptSuffix(this.mode)}`;
  }

  enter(mode: CliMode): void {
    if (mode !== "config-if") this.ifaceCtx = undefined;
    if (mode !== "config-vlan") this.vlanId = undefined;
    this.mode = mode;
  }

  /** Execute one command line; returns its textual output ("" if none). */
  execute(line: string): string {
    const tokens = tokenize(line);
    if (tokens.length === 0) return "";

    for (const spec of allCommands) {
      if (!spec.modes.includes(this.mode)) continue;
      if (!deviceMatches(spec.device, this.device)) continue;
      const params = matchPattern(spec.pattern, tokens);
      if (!params) continue;
      try {
        return spec.run(this, params) ?? "";
      } catch (err) {
        if (err instanceof CliError) return err.render();
        throw err;
      }
    }
    return new SyntaxError().render();
  }

  /**
   * Run a list of command lines and return a full terminal transcript
   * (prompt + command, followed by any output). Handy for golden tests.
   */
  transcript(lines: string[]): string {
    const out: string[] = [];
    for (const line of lines) {
      out.push(`${this.prompt()}${line}`);
      const result = this.execute(line);
      if (result.length > 0) out.push(result);
    }
    return out.join("\n");
  }
}

export function createCliSession(device: Device, engine: SimulationEngine): CliSession {
  return new CliSession(device, engine);
}
