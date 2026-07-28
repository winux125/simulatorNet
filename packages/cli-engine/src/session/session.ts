import type { Device, SimulationEngine } from "@sim/sim-core";
import { allCommands } from "../commands";
import { deviceMatches, isPc, isRoutingDevice } from "../commands/helpers";
import {
  AmbiguousCommandError,
  CliError,
  IncompleteCommandError,
  renderProtocolError,
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
import type {
  AaaServerContext,
  AclContext,
  InterfaceContext,
  RouterProcessContext,
  SessionApi,
  VtyLineContext,
} from "../types";
import { type CliMode, promptSuffix } from "./mode";
import type { RemoteSessionBridge, RemoteSessionOpener, RemoteSessionRequest } from "./remote";

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
  routerCtx: RouterProcessContext | undefined;
  lineCtx: VtyLineContext | undefined;
  aaaServerCtx: AaaServerContext | undefined;
  private pendingInput: "ping-target" | undefined;
  private executionMode: NetworkExecutionMode = "auto";
  private pendingOperation: (() => string | undefined) | undefined;
  private pendingConfirmation: { prompt: string; onConfirm: () => string } | undefined;
  private remote: RemoteSessionBridge | undefined;
  private remoteOpener: RemoteSessionOpener | undefined;

  constructor(
    readonly device: Device,
    readonly engine: SimulationEngine,
  ) {}

  /** The prompt shown before the next command, e.g. "S1(config-if)#". */
  prompt(): string {
    if (this.pendingConfirmation) return this.pendingConfirmation.prompt;
    if (this.pendingInput === "ping-target") return "Target IP address:";
    const remote = this.remote;
    if (remote && !remote.isClosed()) return remote.prompt();
    if (isPc(this.device)) return "C:\\>";
    return `${this.device.name}${promptSuffix(this.mode)}`;
  }

  // --- remote sessions -----------------------------------------------------

  /**
   * Give this session the ability to open Telnet/SSH sessions. Owned by the
   * runtime (worker or verifier), never by a command handler.
   */
  useRemoteSessionOpener(opener: RemoteSessionOpener | undefined): void {
    this.remoteOpener = opener;
  }

  /** Read-only management runtime for `show users`, `show line`, `clear line`. */
  managementRuntime(): RemoteSessionOpener | undefined {
    return this.remoteOpener;
  }

  /**
   * Push a remote session onto this terminal. The local host session is kept
   * intact underneath, so `exit` returns to the host prompt instead of ending
   * the terminal.
   */
  openRemoteSession(request: RemoteSessionRequest): string {
    if (!this.remoteOpener) {
      throw new ValidationError("Remote management is unavailable in this runtime.");
    }
    if (this.remote && !this.remote.isClosed()) {
      throw new ValidationError("A remote session is already open on this terminal.");
    }
    const bridge = this.remoteOpener.open(this.device.id, request);
    this.remote = bridge;
    return this.runNetworkOperation(
      () => bridge.connect(),
      () => (bridge.awaitingResponse() ? undefined : this.renderRemote(bridge)),
    );
  }

  /** The remote session attached to this terminal, if any. */
  remoteSession(): RemoteSessionBridge | undefined {
    return this.remote && !this.remote.isClosed() ? this.remote : undefined;
  }

  /** True while the *next* submitted line is a credential (remote login). */
  expectsSecret(): boolean {
    return this.remoteSession()?.expectsSecret() ?? false;
  }

  credentialScope(): string | undefined {
    return this.remoteSession()?.credentialScope();
  }

  /** Close an attached remote session, e.g. when the terminal tab is closed. */
  closeRemoteSession(): void {
    this.remote?.close();
    this.remote = undefined;
  }

  private renderRemote(bridge: RemoteSessionBridge): string {
    const output = bridge.drain();
    if (!bridge.isClosed()) return output;
    this.remote = undefined;
    return output;
  }

  enter(mode: CliMode): void {
    if (mode !== "config-if") this.ifaceCtx = undefined;
    if (mode !== "config-vlan") this.vlanId = undefined;
    if (mode !== "config-acl") this.aclCtx = undefined;
    if (mode !== "config-router") this.routerCtx = undefined;
    if (mode !== "config-line") this.lineCtx = undefined;
    if (mode !== "config-aaa-server") this.aaaServerCtx = undefined;
    this.mode = mode;
  }

  requestConfirmation(prompt: string, onConfirm: () => string): string {
    this.pendingConfirmation = { prompt, onConfirm };
    return "";
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

  /**
   * Execute one command line; returns its textual output ("" if none).
   *
   * `credential` is an opaque, pre-derived fingerprint answering a remote
   * credential prompt. A plaintext secret never reaches this method.
   */
  execute(line: string, credential?: string): string {
    // A remote session owns the terminal while it is open: every line travels
    // over the simulated network to the managed device, and only that device's
    // CLI interprets it.
    const remote = this.remoteSession();
    if (remote) {
      return this.runNetworkOperation(
        () => remote.submit(line, credential),
        () => (remote.awaitingResponse() ? undefined : this.renderRemote(remote)),
      );
    }
    const confirmation = this.pendingConfirmation;
    if (confirmation) {
      this.pendingConfirmation = undefined;
      const answer = line.trim().toLowerCase();
      // An empty line accepts the default, exactly like IOS.
      if (answer === "" || answer === "y" || answer === "yes") {
        try {
          return confirmation.onConfirm();
        } catch (error) {
          if (error instanceof CliError) return error.render();
          throw error;
        }
      }
      return "% Cancelled.";
    }
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
      // A fully typed keyword wins over longer keywords that merely share its
      // prefix (`ip` must not become ambiguous after adding `ipv6`).
      if (literalExpansions.has(token)) continue;
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
        const protocolError = renderProtocolError(err);
        if (protocolError !== undefined) return protocolError;
        throw err;
      }
    }

    const incompleteCandidates = progress
      .filter((candidate) => candidate.analysis.status === "incomplete")
      // Most tokens matched wins; then the most *general* form, so a bare
      // `interface` suggests `interface <interface-name>` rather than one of
      // the specific `interface vlan|range|loopback` sub-forms.
      .sort((a, b) =>
        b.analysis.matchedTokens - a.analysis.matchedTokens
        || literalTokenCount(a.spec.pattern) - literalTokenCount(b.spec.pattern)
        || a.spec.pattern.length - b.spec.pattern.length);
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

/** How specific a pattern is: the number of fixed keywords it requires. */
function literalTokenCount(pattern: string): number {
  return pattern.split(" ").filter((token) => !token.startsWith("{")).length;
}

export function createCliSession(device: Device, engine: SimulationEngine): CliSession {
  if (!device.profile.cliProfile) throw new Error(`Device type '${device.deviceType}' has no CLI profile`);
  return new CliSession(device, engine);
}
