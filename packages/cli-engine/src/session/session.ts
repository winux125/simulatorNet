import type { Device, SimulationEngine } from "@sim/sim-core";
import { allCommands } from "../commands";
import { deviceMatches } from "../commands/helpers";
import { CliError, IncompleteCommandError, SyntaxError, UnsupportedCapabilityError } from "../errors/errors";
import { renderHelp } from "../help/help";
import { tokenize } from "../lexer/lexer";
import { analyzePattern, matchPattern, usageFromPattern } from "../parser/matcher";
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

    const lowered = tokens.map((token) => token.toLowerCase());
    if (lowered.length === 1 && (lowered[0] === "?" || lowered[0] === "help")) return renderHelp(this, []);
    if (tokens.at(-1) === "?") return renderHelp(this, tokens.slice(0, -1));

    const eligible = allCommands.filter((spec) =>
      spec.modes.includes(this.mode)
      && deviceMatches(spec.device, this.device));
    for (const spec of eligible) {
      const params = matchPattern(spec.pattern, tokens);
      if (!params) continue;
      const missingCapability = spec.capabilities?.find((capability) => !this.device.hasCapability(capability));
      if (missingCapability) return new UnsupportedCapabilityError(missingCapability).render();
      try {
        return spec.run(this, params) ?? "";
      } catch (err) {
        if (err instanceof CliError) return err.render();
        throw err;
      }
    }

    const progress = eligible.map((spec) => ({ spec, analysis: analyzePattern(spec.pattern, tokens) }));
    const incomplete = progress
      .filter((candidate) => candidate.analysis.status === "incomplete")
      .sort((a, b) => b.analysis.matchedTokens - a.analysis.matchedTokens || a.spec.pattern.length - b.spec.pattern.length)[0];
    if (incomplete) return new IncompleteCommandError(incomplete.spec.usage ?? usageFromPattern(incomplete.spec.pattern)).render();

    const invalid = progress.sort((a, b) => b.analysis.matchedTokens - a.analysis.matchedTokens)[0];
    const invalidIndex = invalid?.analysis.invalidTokenIndex ?? 0;
    const offsets = [...line.matchAll(/\S+/g)].map((match) => match.index);
    return new SyntaxError(offsets[invalidIndex] ?? 0).render();
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
  if (!device.profile.cliProfile) throw new Error(`Device type '${device.deviceType}' has no CLI profile`);
  return new CliSession(device, engine);
}
