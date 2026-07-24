import type { Device, SimulationEngine } from "@sim/sim-core";
import { allCommands } from "../commands";
import { deviceMatches, isPc, isRoutingDevice } from "../commands/helpers";
import {
  AmbiguousCommandError,
  CliError,
  IncompleteCommandError,
  SyntaxError,
  UnsupportedCapabilityError,
  ValidationError,
} from "../errors/errors";
import { renderHelp } from "../help/help";
import { tokenize } from "../lexer/lexer";
import {
  analyzePattern,
  matchPatternDetailed,
  usageFromPattern,
} from "../parser/matcher";
import type { AclContext, InterfaceContext, SessionApi } from "../types";
import { type CliMode, promptSuffix } from "./mode";

export type NetworkExecutionMode = "auto" | "step";

export const STEP_OPERATION_QUEUED = [
  "Operation queued in Step mode.",
  "Open Packet Trace and use Step or Run All.",
].join("\n");

/**
 * A console session attached to a single device. It owns the CLI mode/context
 * and dispatches a typed line to the matching command handler. It contains no
 * network logic: handlers only call public `sim-core` methods.
 */
export class CliSession implements SessionApi {
  mode: CliMode = "exec";
  ifaceCtx: InterfaceContext | undefined;
  vlanId: number | undefined;
  aclCtx: AclContext | undefined;
  private pendingInput: "ping-target" | undefined;
  private executionMode: NetworkExecutionMode = "auto";
  private pendingOperation: (() => string | undefined) | undefined;

  constructor(
    readonly device: Device,
    readonly engine: SimulationEngine,
  ) {}

  /** The prompt shown before the next command, e.g. "S1(config-if)#". */
  prompt(): string {
    if (this.pendingInput === "ping-target") return "Target IP address:";
    if (isPc(this.device)) return "C:\\>";
    return `${this.device.name}${promptSuffix(this.mode)}`;
  }

  enter(mode: CliMode): void {
    if (mode !== "config-if") this.ifaceCtx = undefined;
    if (mode !== "config-vlan") this.vlanId = undefined;
    if (mode !== "config-acl") this.aclCtx = undefined;
    this.mode = mode;
  }

  setExecutionMode(mode: NetworkExecutionMode): void {
    this.executionMode = mode;
  }

  hasPendingOperation(): boolean {
    return this.pendingOperation !== undefined;
  }

  runNetworkOperation(start: () => void, complete: () => string | undefined): string {
    if (this.pendingOperation) {
      throw new IncompleteCommandError("wait for the queued operation to complete");
    }
    start();
    if (this.executionMode === "auto") {
      for (let phase = 0; phase < 16; phase++) {
        this.engine.runUntilIdle();
        const output = complete();
        if (output !== undefined) return output;
        if (this.engine.pendingEventCount() === 0) {
          throw new ValidationError("Network operation did not produce a final result.");
        }
      }
      throw new ValidationError("Network operation exceeded its phase limit.");
    }
    this.pendingOperation = complete;
    const immediate = this.completePendingOperation();
    if (immediate !== undefined) return immediate;
    return STEP_OPERATION_QUEUED;
  }

  /** Render a deferred operation after Step or Run All drains the queue. */
  completePendingOperation(): string | undefined {
    if (!this.pendingOperation || this.engine.pendingEventCount() > 0) return undefined;
    try {
      const output = this.pendingOperation();
      if (output === undefined) {
        if (this.engine.pendingEventCount() === 0) {
          this.pendingOperation = undefined;
          throw new ValidationError("Network operation did not produce a final result.");
        }
        return undefined;
      }
      this.pendingOperation = undefined;
      return output;
    } catch (error) {
      this.pendingOperation = undefined;
      if (error instanceof CliError) return error.render();
      throw error;
    }
  }

  /** Execute one command line; returns its textual output ("" if none). */
  execute(line: string): string {
    if (this.pendingInput === "ping-target") {
      if (line.trim().length === 0) return "";
      this.pendingInput = undefined;
      return this.execute(`ping ${line.trim()}`);
    }

    const tokens = tokenize(line);
    if (tokens.length === 0) return "";

    const lowered = tokens.map((token) => token.toLowerCase());
    if (lowered.length === 1 && (lowered[0] === "?" || lowered[0] === "help")) return renderHelp(this, []);
    if (tokens.at(-1) === "?") return renderHelp(this, tokens.slice(0, -1));
    if (
      lowered.length === 1
      && "ping".startsWith(lowered[0]!)
      && isRoutingDevice(this.device)
      && (this.mode === "exec" || this.mode === "privileged")
    ) {
      this.pendingInput = "ping-target";
      return "";
    }

    const eligible = allCommands.filter((spec) =>
      spec.modes.includes(this.mode)
      && deviceMatches(spec.device, this.device));
    const progress = eligible.map((spec) => ({ spec, analysis: analyzePattern(spec.pattern, tokens) }));
    const viable = progress.filter((candidate) => candidate.analysis.status !== "invalid");
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!.toLowerCase();
      const literalExpansions = new Set(
        viable
          .map((candidate) => candidate.spec.pattern.split(" ")[index])
          .filter((part): part is string => part !== undefined && !part.startsWith("{"))
          .filter((part) => part.toLowerCase().startsWith(token))
          .map((part) => part.toLowerCase()),
      );
      if (literalExpansions.size > 1) return new AmbiguousCommandError(line.trim()).render();
    }

    const complete = eligible.flatMap((spec) => {
      const match = matchPatternDetailed(spec.pattern, tokens);
      return match ? [{ spec, match }] : [];
    });
    if (complete.length > 0) {
      complete.sort((left, right) =>
        right.match.exactLiteralCount - left.match.exactLiteralCount
        || right.match.literalCount - left.match.literalCount
        || right.spec.pattern.length - left.spec.pattern.length);
      const best = complete[0]!;
      const tied = complete.filter((candidate) =>
        candidate.match.exactLiteralCount === best.match.exactLiteralCount
        && candidate.match.literalCount === best.match.literalCount);
      if (new Set(tied.map((candidate) => candidate.spec.pattern)).size > 1) {
        return new AmbiguousCommandError(line.trim()).render();
      }
      const missingCapability = best.spec.capabilities?.find((capability) => !this.device.hasCapability(capability));
      if (missingCapability) return new UnsupportedCapabilityError(missingCapability).render();
      try {
        return best.spec.run(this, best.match.params) ?? "";
      } catch (err) {
        if (err instanceof CliError) return err.render();
        throw err;
      }
    }

    const incompleteCandidates = progress
      .filter((candidate) => candidate.analysis.status === "incomplete")
      .sort((a, b) => b.analysis.matchedTokens - a.analysis.matchedTokens || a.spec.pattern.length - b.spec.pattern.length);
    const incomplete = incompleteCandidates[0];
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
