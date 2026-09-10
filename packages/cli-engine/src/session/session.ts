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
import { commandsForMode } from "../commands/available";
import { executeRangeCommand } from "../commands/range";
import { nextTokens, resolveTokens } from "../parser/resolver";
import { tokenize } from "../lexer/lexer";
import {
  matchPatternDetailed,
  usageFromPattern,
} from "../parser/matcher";
import type {
  CommandSpec,
  AaaServerContext,
  AclContext,
  CryptoContext,
  InterfaceContext,
  QosClassMapContext,
  QosPolicyMapContext,
  RouterProcessContext,
  RouteMapContext,
  SessionApi,
  EthernetSegmentContext,
  EvpnContext,
  NveContext,
  VlanConfigurationContext,
  VrfContext,
  VtyLineContext,
} from "../types";
import type { DeviceConfigurationService } from "./configuration";
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
  negated = false;
  private readonly history: string[] = [];
  commandHistory(): readonly string[] { return [...this.history]; }
  ifaceCtx: InterfaceContext | undefined;
  vlanId: number | undefined;
  aclCtx: AclContext | undefined;
  routerCtx: RouterProcessContext | undefined;
  vrfCtx: VrfContext | undefined;
  routeMapCtx: RouteMapContext | undefined;
  lineCtx: VtyLineContext | undefined;
  aaaServerCtx: AaaServerContext | undefined;
  classMapCtx: QosClassMapContext | undefined;
  policyMapCtx: QosPolicyMapContext | undefined;
  cryptoCtx: CryptoContext | undefined;
  nveCtx: NveContext | undefined;
  vlanConfigCtx: VlanConfigurationContext | undefined;
  evpnCtx: EvpnContext | undefined;
  ethernetSegmentCtx: EthernetSegmentContext | undefined;
  private pendingInput: "ping-target" | undefined;
  private executionMode: NetworkExecutionMode = "auto";
  private pendingOperation: (() => string | undefined) | undefined;
  private pendingConfirmation: { prompt: string; onConfirm: () => string } | undefined;
  private pendingCredential: {
    prompt: string;
    scope: string;
    apply(fingerprint: string): string;
  } | undefined;
  private pendingAnswer: { prompt: string; answer(line: string): string } | undefined;
  private remote: RemoteSessionBridge | undefined;
  private remoteOpener: RemoteSessionOpener | undefined;
  private configuration: DeviceConfigurationService | undefined;

  constructor(
    readonly device: Device,
    readonly engine: SimulationEngine,
  ) {}

  /** The prompt shown before the next command, e.g. "S1(config-if)#". */
  prompt(): string {
    if (this.pendingCredential) return this.pendingCredential.prompt;
    if (this.pendingAnswer) return this.pendingAnswer.prompt;
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

  /**
   * True while the *next* submitted line is a credential — either a remote
   * login answer or a local secret such as a VPN pre-shared key. The terminal
   * suppresses echo, keeps it out of history, the transcript and Problems, and
   * sends only the opaque fingerprint derived against `credentialScope`.
   */
  expectsSecret(): boolean {
    if (this.pendingCredential) return true;
    return this.remoteSession()?.expectsSecret() ?? false;
  }

  credentialScope(): string | undefined {
    return this.pendingCredential?.scope ?? this.remoteSession()?.credentialScope();
  }

  /**
   * Ask for a secret without ever accepting it in the clear. The next line is
   * consumed as a pre-derived fingerprint; a plaintext key never reaches this
   * session, sim-core, a trace, a log or `show running-config`.
   */
  requestCredential(prompt: string, scope: string, apply: (fingerprint: string) => string): string {
    this.pendingCredential = { prompt, scope, apply };
    return "";
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
    if (mode !== "config-vrf") this.vrfCtx = undefined;
    if (mode !== "config-route-map") this.routeMapCtx = undefined;
    if (mode !== "config-line") this.lineCtx = undefined;
    if (mode !== "config-aaa-server") this.aaaServerCtx = undefined;
    if (mode !== "config-cmap") this.classMapCtx = undefined;
    if (mode !== "config-ikev2-proposal" && mode !== "config-ikev2-peer" && mode !== "config-ipsec-profile") {
      this.cryptoCtx = undefined;
    }
    // The policy-map context survives `class <name>`, which nests inside it.
    if (mode !== "config-pmap" && mode !== "config-pmap-c") this.policyMapCtx = undefined;
    if (mode === "config-pmap" && this.policyMapCtx) this.policyMapCtx.className = undefined;
    // The NVE and EVPN contexts survive their own `member vni`/`vni <n> l2`
    // sub-mode, exactly as the policy-map context survives `class`.
    if (mode !== "config-nve" && mode !== "config-nve-vni") this.nveCtx = undefined;
    if (mode === "config-nve" && this.nveCtx) this.nveCtx.memberVni = undefined;
    if (mode !== "config-evpn" && mode !== "config-evpn-vni") this.evpnCtx = undefined;
    if (mode === "config-evpn" && this.evpnCtx) this.evpnCtx.vni = undefined;
    if (mode !== "config-vlan-config") this.vlanConfigCtx = undefined;
    if (mode !== "config-evpn-es") this.ethernetSegmentCtx = undefined;
    this.mode = mode;
  }

  requestConfirmation(prompt: string, onConfirm: () => string): string {
    this.pendingConfirmation = { prompt, onConfirm };
    return "";
  }

  requestAnswer(prompt: string, answer: (line: string) => string): string {
    this.pendingAnswer = { prompt, answer };
    return "";
  }

  /**
   * Attach the running/startup configuration service. Owned by the runtime
   * (worker or verifier), never by a command handler.
   */
  useConfigurationService(service: DeviceConfigurationService | undefined): void {
    this.configuration = service;
  }

  configurationService(): DeviceConfigurationService | undefined {
    return this.configuration;
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
    // A pending local secret owns the next line. Only the derived fingerprint
    // is ever accepted, so an empty answer simply cancels the command.
    const credentialPrompt = this.pendingCredential;
    if (credentialPrompt) {
      this.pendingCredential = undefined;
      if (!credential) return "% No credential was provided; nothing was changed.";
      try {
        return credentialPrompt.apply(credential);
      } catch (error) {
        if (error instanceof CliError) return error.render();
        const protocolError = renderProtocolError(error);
        if (protocolError !== undefined) return protocolError;
        throw error;
      }
    }
    // A free-form question owns the next line before any command matching, so
    // an answer is never mistaken for a command (and a pasted sequence stops).
    const question = this.pendingAnswer;
    if (question) {
      this.pendingAnswer = undefined;
      try {
        return question.answer(line.trim());
      } catch (error) {
        if (error instanceof CliError) return error.render();
        throw error;
      }
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

    this.resolvedCommand = undefined;
    if (line.trimEnd().endsWith("?")) return this.help(line.trimEnd().slice(0, -1));
    if (tokens.length === 1 && tokens[0]!.toLowerCase() === "help") return this.help("");
    const eligible = this.availableCommands();
    const resolved = resolveTokens(eligible, tokens);
    // Credential answers were consumed above. Check canonical keywords so
    // abbreviations cannot bypass filtering; unknown input is never retained.
    if (!resolved.error && !/\b(secret|password|community|pre-shared-key|key)\b/i.test(resolved.tokens.join(" "))) {
      this.history.push(line.trim());
      if (this.history.length > 100) this.history.shift();
    }
    if (resolved.error === "ambiguous") return new AmbiguousCommandError(line.trim()).render();
    if (resolved.error === "invalid") {
      // Keep the useful explicit capability diagnostic for a fully spelled
      // unsupported command, without admitting it into abbreviation/help.
      const unsupported = allCommands.find((spec) => spec.modes.includes(this.mode)
        && deviceMatches(spec.device, this.device)
        && spec.pattern.split(" ").every((part, i) => part.startsWith("{") || part.toLowerCase() === tokens[i]?.toLowerCase())
        && matchPatternDetailed(spec.pattern, tokens)
        && spec.capabilities?.some((capability) => !this.device.hasCapability(capability)));
      const missing = unsupported?.capabilities?.find((capability) => !this.device.hasCapability(capability));
      if (missing) return new UnsupportedCapabilityError(missing).render();
      const offsets = [...line.matchAll(/\S+/g)].map((match) => match.index);
      return new SyntaxError(offsets[resolved.index] ?? line.length).render();
    }
    this.resolvedCommand = resolved.tokens.join(" ");
    if (this.resolvedCommand === "ping" && isRoutingDevice(this.device)) {
      this.pendingInput = "ping-target";
      return "";
    }
    const complete = resolved.candidates.flatMap(({ spec }) => {
      const match = matchPatternDetailed(spec.pattern, resolved.tokens);
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
        this.negated = best.spec.negated ?? false;
        return executeRangeCommand(this, best.spec, best.match.params);
      } catch (err) {
        if (err instanceof CliError) return err.render();
        const protocolError = renderProtocolError(err);
        if (protocolError !== undefined) return protocolError;
        throw err;
      } finally {
        this.negated = false;
      }
    }

    const incomplete = resolved.candidates.map((candidate) => candidate.spec)
      .sort((a, b) => literalTokenCount(a.pattern) - literalTokenCount(b.pattern) || a.pattern.length - b.pattern.length)[0];
    return new IncompleteCommandError(incomplete?.usage ?? usageFromPattern(incomplete?.pattern ?? "")).render();
  }

  /** Canonical command from the last resolution; arguments keep their case. */
  resolvedCommand: string | undefined;

  availableCommands(): CommandSpec[] {
    return commandsForMode(this, this.mode);
  }

  /** Help and completion do not execute, change mode, or enter history. */
  help(input: string): string {
    if (!input || /\s$/.test(input)) return renderHelp(this, tokenize(input));
    const { candidates, error } = this.complete(input);
    return error ?? candidates.map((candidate) => "  " + candidate).join("\n");
  }

  complete(input: string): { input: string; candidates: string[]; error?: string } {
    const tokens = tokenize(input);
    const partial = /\s$/.test(input) ? "" : tokens.pop() ?? "";
    const resolved = resolveTokens(this.availableCommands(), tokens);
    if (resolved.error) return { input, candidates: [], error: resolved.error === "ambiguous"
      ? new AmbiguousCommandError(input.trim()).render() : new SyntaxError().render() };
    const candidates = nextTokens(resolved)
      .filter((part) => !part.startsWith("{") && part !== "<cr>" && part.toLowerCase().startsWith(partial.toLowerCase()));
    const replacement = candidates.length === 1
      ? input.slice(0, input.length - partial.length) + candidates[0]
      : input;
    return { input: replacement, candidates };
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
