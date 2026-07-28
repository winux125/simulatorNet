import {
  AAA_LIMITS,
  RADIUS_ACCOUNTING_PORT,
  RADIUS_AUTHENTICATION_PORT,
  TACACS_PORT,
  type AaaAccountingList,
  type AaaMethod,
  type AaaServerConfig,
  type ConsoleAccessConfiguration,
} from "@sim/contracts";
import type { AaaState, HostTransportStack, RadiusMessage, TacacsMessage, TcpConnection } from "@sim/sim-core";
import { NS_PER_S } from "@sim/sim-core";
import {
  acceptLocalUser,
  LINE_PASSWORD_PRIVILEGE_LEVEL,
  LocalAuthenticationProvider,
  type AuthenticationMethodName,
  type AuthenticationProvider,
  type AuthenticationRequest,
  type AuthenticationResult,
} from "./authentication";
import { findLocalUser, type ManagedDevice } from "./managed-device";

/**
 * The AAA decision layer.
 *
 * A method list is walked in order and the **first conclusive** result wins:
 *
 * - `accept`      -> success; stop.
 * - `reject`      -> failure; stop. There is deliberately **no** fallback after
 *                    an explicit reject, so a reachable RADIUS server that says
 *                    "no" fails the login instead of silently falling back to
 *                    the local database.
 * - `unavailable` -> the server did not answer in time; try the next method.
 *
 * Every method resolves against the *same* shared credential model as the
 * console and the VTY lines: there is no second local-user implementation.
 */
export type AaaMethodOutcome =
  | { readonly status: "accept"; readonly username: string; readonly privilegeLevel: number }
  | { readonly status: "reject" }
  | { readonly status: "unavailable" };

export interface AaaServerHealth {
  readonly name: string;
  readonly protocol: AaaServerConfig["protocol"];
  readonly address: string;
  readonly reachable: boolean | undefined;
  readonly lastResultAtNs: number | undefined;
  readonly failures: number;
}

export interface AaaSessionRecord {
  readonly sessionId: string;
  readonly username: string;
  readonly privilegeLevel: number;
  readonly method: AuthenticationMethodName;
  readonly startedAtNs: number;
}

export interface AaaStatusView {
  readonly deviceId: string;
  readonly enabled: boolean;
  readonly configuration: ReturnType<AaaState["snapshot"]>;
  readonly servers: AaaServerHealth[];
  readonly lastAuthentication:
    | { readonly username: string; readonly method: AuthenticationMethodName; readonly result: "accept" | "reject"; readonly atNs: number }
    | undefined;
  readonly sessions: AaaSessionRecord[];
}

interface PendingRadius {
  readonly identifier: number;
  readonly done: (outcome: AaaMethodOutcome) => void;
  settled: boolean;
}

interface PendingTacacs {
  readonly connection: TcpConnection;
  readonly done: (outcome: AaaMethodOutcome) => void;
  settled: boolean;
}

/**
 * Walks a method list for one managed device. RADIUS and TACACS+ round trips go
 * through the device's own management transport, so an unreachable server is
 * unreachable for a real, simulated reason.
 */
export class AaaAuthenticationProvider implements AuthenticationProvider {
  private readonly local: LocalAuthenticationProvider;
  private readonly health = new Map<string, { reachable: boolean | undefined; lastResultAtNs?: number; failures: number }>();
  private readonly sessions = new Map<string, AaaSessionRecord>();
  private readonly pendingRadius = new Map<number, PendingRadius>();
  private lastAuthentication: AaaStatusView["lastAuthentication"];
  private radiusIdentifier = 0;
  private radiusPort: number | undefined;

  constructor(
    private readonly host: ManagedDevice,
    private readonly aaa: () => AaaState,
    private readonly access: () => ConsoleAccessConfiguration | undefined,
    lineConfig: ConstructorParameters<typeof LocalAuthenticationProvider>[1],
  ) {
    this.local = new LocalAuthenticationProvider(access, lineConfig);
  }

  status(): AaaStatusView {
    const state = this.aaa();
    return {
      deviceId: this.host.deviceId,
      enabled: state.enabled,
      configuration: state.snapshot(),
      servers: state.servers.map((server) => {
        const health = this.health.get(server.name);
        return {
          name: server.name,
          protocol: server.protocol,
          address: server.address,
          reachable: health?.reachable,
          lastResultAtNs: health?.lastResultAtNs,
          failures: health?.failures ?? 0,
        };
      }),
      lastAuthentication: this.lastAuthentication,
      sessions: [...this.sessions.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    };
  }

  forgetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  authenticate(request: AuthenticationRequest, done: (result: AuthenticationResult) => void): void {
    const state = this.aaa();
    const list = state.authenticationList(request.listName);
    if (!list) {
      // Without `aaa new-model` the line's own `login`/`login local` decides.
      this.local.authenticate(request, (result) => {
        this.recordAuthentication(request, result);
        done(result);
      });
      return;
    }
    this.walk(list.methods, 0, request, undefined, (result) => {
      this.recordAuthentication(request, result);
      done(result);
    });
  }

  /**
   * Exec authorization: may this authenticated user open a CLI at all? An
   * unavailable server falls through exactly like authentication does.
   */
  authorizeExec(request: AuthenticationRequest, done: (result: AuthenticationResult) => void): void {
    const list = this.aaa().authorizationExecList(request.listName);
    if (!list) {
      done({ status: "accept", username: request.username, privilegeLevel: 1, method: "none" });
      return;
    }
    this.walk(list.methods, 0, request, "exec", done);
  }

  /** Command authorization is a TACACS+ educational subset. */
  authorizeCommand(
    request: AuthenticationRequest & { readonly privilegeLevel: number; readonly command: string },
    done: (permitted: boolean) => void,
  ): void {
    const list = this.aaa().authorizationCommandList(request.privilegeLevel, request.listName);
    if (!list) {
      done(true);
      return;
    }
    this.walkCommand(list.methods, 0, request, done);
  }

  /** Accounting is fire-and-forget: it never blocks or fails a session. */
  account(
    event: "start" | "stop" | "command",
    session: { readonly sessionId: string; readonly username: string; readonly privilegeLevel: number },
    detail?: string,
  ): void {
    const state = this.aaa();
    const list: AaaAccountingList | undefined = event === "command"
      ? state.accountingCommandList(session.privilegeLevel)
      : state.accountingExecList();
    if (!list || list.mode === "none") return;
    if (event === "start" && list.mode === "stop-only") return;
    for (const method of list.methods) {
      if (method === "group radius") this.sendRadiusAccounting(event, session, detail);
      else if (method === "group tacacs+") this.sendTacacsAccounting(event, session, detail);
    }
  }

  // --- method-list walking --------------------------------------------------

  private walk(
    methods: readonly AaaMethod[],
    index: number,
    request: AuthenticationRequest,
    service: "exec" | undefined,
    done: (result: AuthenticationResult) => void,
  ): void {
    const method = methods[index];
    if (method === undefined) {
      done({ status: "reject", method: "none", reason: "no-method" });
      return;
    }
    this.tryMethod(method, request, service, (outcome) => {
      if (outcome.status === "accept") {
        done({
          status: "accept",
          username: outcome.username,
          privilegeLevel: outcome.privilegeLevel,
          method: methodName(method),
        });
        return;
      }
      if (outcome.status === "reject") {
        // An explicit reject is conclusive: never fall back to a later method.
        done({ status: "reject", method: methodName(method), reason: "invalid-credentials" });
        return;
      }
      this.walk(methods, index + 1, request, service, done);
    });
  }

  private tryMethod(
    method: AaaMethod,
    request: AuthenticationRequest,
    service: "exec" | undefined,
    done: (outcome: AaaMethodOutcome) => void,
  ): void {
    if (method === "none") {
      done({ status: "accept", username: request.username, privilegeLevel: LINE_PASSWORD_PRIVILEGE_LEVEL });
      return;
    }
    if (method === "local") {
      if (service === "exec") {
        const user = findLocalUser(this.access(), request.username);
        done(user
          ? { status: "accept", username: user.username, privilegeLevel: user.privilegeLevel }
          : { status: "reject" });
        return;
      }
      const result = acceptLocalUser(findLocalUser(this.access(), request.username), request.credentialFingerprint);
      done(result.status === "accept"
        ? { status: "accept", username: result.username, privilegeLevel: result.privilegeLevel }
        : { status: "reject" });
      return;
    }
    const servers = this.aaa().serversFor(method);
    if (servers.length === 0) {
      done({ status: "unavailable" });
      return;
    }
    if (method === "group radius") this.askRadiusGroup(servers, 0, request, done);
    else this.askTacacsGroup(servers, 0, request, service ?? undefined, undefined, done);
  }

  private walkCommand(
    methods: readonly AaaMethod[],
    index: number,
    request: AuthenticationRequest & { privilegeLevel: number; command: string },
    done: (permitted: boolean) => void,
  ): void {
    const method = methods[index];
    if (method === undefined) {
      done(false);
      return;
    }
    if (method === "none") {
      done(true);
      return;
    }
    if (method === "local") {
      // Local command authorization: a privilege-15 user may run anything.
      done(request.privilegeLevel >= 15);
      return;
    }
    if (method === "group radius") {
      // RADIUS has no command authorization in this educational subset.
      this.walkCommand(methods, index + 1, request, done);
      return;
    }
    const servers = this.aaa().serversFor("group tacacs+");
    if (servers.length === 0) {
      this.walkCommand(methods, index + 1, request, done);
      return;
    }
    this.askTacacsGroup(servers, 0, request, "command", request.command, (outcome) => {
      if (outcome.status === "accept") {
        done(true);
        return;
      }
      if (outcome.status === "reject") {
        done(false);
        return;
      }
      this.walkCommand(methods, index + 1, request, done);
    });
  }

  // --- RADIUS ---------------------------------------------------------------

  private askRadiusGroup(
    servers: readonly AaaServerConfig[],
    index: number,
    request: AuthenticationRequest,
    done: (outcome: AaaMethodOutcome) => void,
  ): void {
    const server = servers[index];
    if (!server) {
      done({ status: "unavailable" });
      return;
    }
    this.askRadius(server, request, (outcome) => {
      if (outcome.status === "unavailable") {
        this.askRadiusGroup(servers, index + 1, request, done);
        return;
      }
      done(outcome);
    });
  }

  private askRadius(
    server: AaaServerConfig,
    request: AuthenticationRequest,
    done: (outcome: AaaMethodOutcome) => void,
  ): void {
    const transport = this.host.transport();
    const identifier = this.nextRadiusIdentifier();
    const pending: PendingRadius = { identifier, done, settled: false };
    this.pendingRadius.set(identifier, pending);
    const port = this.ensureRadiusSocket(transport);
    const message: RadiusMessage = {
      kind: "radius",
      code: "Access-Request",
      identifier,
      username: request.username,
      credentialFingerprint: request.credentialFingerprint,
      sharedKeyFingerprint: server.sharedKeyFingerprint,
      deviceName: this.host.hostname(),
    };
    transport.udp.send({
      destinationAddress: server.address,
      destinationPort: server.authenticationPort ?? RADIUS_AUTHENTICATION_PORT,
      sourcePort: port,
      payload: message,
    });
    this.trace("radius-request", { server: server.name, address: server.address, username: request.username });
    this.host.engine().scheduleIn(server.timeoutSeconds * NS_PER_S, () => {
      if (pending.settled) return;
      pending.settled = true;
      this.pendingRadius.delete(identifier);
      this.markHealth(server.name, false);
      this.trace("radius-timeout", { server: server.name, address: server.address });
      done({ status: "unavailable" });
    });
  }

  private ensureRadiusSocket(transport: HostTransportStack): number {
    if (this.radiusPort !== undefined) return this.radiusPort;
    this.radiusPort = transport.udp.bind(0, (received) => {
      const payload = received.payload;
      if (payload.kind !== "radius") return;
      const pending = this.pendingRadius.get(payload.identifier);
      if (!pending || pending.settled) return;
      pending.settled = true;
      this.pendingRadius.delete(payload.identifier);
      const accepted = payload.code === "Access-Accept";
      this.markHealth(this.serverNameFor(received.sourceAddress), true);
      this.trace("radius-response", { code: payload.code, username: payload.username });
      pending.done(accepted
        ? {
            status: "accept",
            username: payload.username ?? "",
            privilegeLevel: payload.privilegeLevel ?? LINE_PASSWORD_PRIVILEGE_LEVEL,
          }
        : { status: "reject" });
    }, "radius-client");
    return this.radiusPort;
  }

  private sendRadiusAccounting(
    event: "start" | "stop" | "command",
    session: { sessionId: string; username: string },
    detail: string | undefined,
  ): void {
    const transport = this.host.transport();
    for (const server of this.aaa().serversFor("group radius")) {
      transport.udp.send({
        destinationAddress: server.address,
        destinationPort: server.accountingPort ?? RADIUS_ACCOUNTING_PORT,
        sourcePort: this.ensureRadiusSocket(transport),
        payload: {
          kind: "radius",
          code: "Accounting-Request",
          identifier: this.nextRadiusIdentifier(),
          username: session.username,
          sharedKeyFingerprint: server.sharedKeyFingerprint,
          accountingStatus: event === "stop" ? "stop" : "start",
          sessionId: session.sessionId,
          deviceName: this.host.hostname(),
          detail,
        },
      });
    }
  }

  // --- TACACS+ --------------------------------------------------------------

  private askTacacsGroup(
    servers: readonly AaaServerConfig[],
    index: number,
    request: AuthenticationRequest & { privilegeLevel?: number },
    service: "exec" | "command" | undefined,
    command: string | undefined,
    done: (outcome: AaaMethodOutcome) => void,
  ): void {
    const server = servers[index];
    if (!server) {
      done({ status: "unavailable" });
      return;
    }
    this.askTacacs(server, request, service, command, (outcome) => {
      if (outcome.status === "unavailable") {
        this.askTacacsGroup(servers, index + 1, request, service, command, done);
        return;
      }
      done(outcome);
    });
  }

  private askTacacs(
    server: AaaServerConfig,
    request: AuthenticationRequest & { privilegeLevel?: number },
    service: "exec" | "command" | undefined,
    command: string | undefined,
    done: (outcome: AaaMethodOutcome) => void,
  ): void {
    const authorization = service !== undefined;
    const message: TacacsMessage = {
      kind: "tacacs",
      messageType: authorization ? "authorization-request" : "authentication-request",
      sequence: 1,
      username: request.username,
      credentialFingerprint: authorization ? undefined : request.credentialFingerprint,
      sharedKeyFingerprint: server.sharedKeyFingerprint,
      privilegeLevel: request.privilegeLevel,
      service,
      command,
      deviceName: this.host.hostname(),
    };
    let pending: PendingTacacs | undefined;
    try {
      const connection = this.host.transport().tcp.connect(
        server.address,
        server.authenticationPort ?? TACACS_PORT,
        {
          onEstablished: (current) => current.send(message),
          onMessage: (payload) => {
            if (payload.kind !== "tacacs" || !pending || pending.settled) return;
            pending.settled = true;
            this.markHealth(server.name, true);
            this.trace("tacacs-response", {
              server: server.name,
              messageType: payload.messageType,
              status: payload.status,
            });
            connection.close();
            done(payload.status === "pass"
              ? {
                  status: "accept",
                  username: payload.username ?? request.username,
                  privilegeLevel: payload.privilegeLevel ?? LINE_PASSWORD_PRIVILEGE_LEVEL,
                }
              : { status: "reject" });
          },
          onReset: () => {
            if (!pending || pending.settled) return;
            pending.settled = true;
            this.markHealth(server.name, false);
            done({ status: "unavailable" });
          },
          onClosed: () => {
            if (!pending || pending.settled) return;
            pending.settled = true;
            this.markHealth(server.name, false);
            done({ status: "unavailable" });
          },
        },
        "tacacs-client",
      );
      pending = { connection, done, settled: false };
    } catch {
      this.markHealth(server.name, false);
      done({ status: "unavailable" });
      return;
    }
    this.trace("tacacs-request", { server: server.name, address: server.address, service: service ?? "login" });
    const current = pending;
    this.host.engine().scheduleIn(server.timeoutSeconds * NS_PER_S, () => {
      if (current.settled) return;
      current.settled = true;
      current.connection.close();
      this.markHealth(server.name, false);
      this.trace("tacacs-timeout", { server: server.name, address: server.address });
      done({ status: "unavailable" });
    });
  }

  private sendTacacsAccounting(
    event: "start" | "stop" | "command",
    session: { sessionId: string; username: string; privilegeLevel: number },
    detail: string | undefined,
  ): void {
    for (const server of this.aaa().serversFor("group tacacs+")) {
      try {
        const connection = this.host.transport().tcp.connect(
          server.address,
          server.authenticationPort ?? TACACS_PORT,
          {
            onEstablished: (current) => {
              current.send({
                kind: "tacacs",
                messageType: "accounting-request",
                sequence: 1,
                username: session.username,
                sharedKeyFingerprint: server.sharedKeyFingerprint,
                privilegeLevel: session.privilegeLevel,
                accountingStatus: event,
                sessionId: session.sessionId,
                deviceName: this.host.hostname(),
                command: event === "command" ? detail : undefined,
                detail: event === "command" ? undefined : detail,
              });
            },
            onMessage: () => connection.close(),
          },
          "tacacs-accounting",
        );
      } catch {
        // Accounting must never break a session; an unreachable server is
        // simply recorded as a health failure.
        this.markHealth(server.name, false);
      }
    }
  }

  // --- bookkeeping ----------------------------------------------------------

  private recordAuthentication(request: AuthenticationRequest, result: AuthenticationResult): void {
    this.lastAuthentication = {
      username: request.username,
      method: result.method,
      result: result.status,
      atNs: this.host.engine().now(),
    };
  }

  rememberSession(record: AaaSessionRecord): void {
    if (this.sessions.size >= AAA_LIMITS.maximumMethodLists * 4) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    this.sessions.set(record.sessionId, record);
  }

  private markHealth(name: string | undefined, reachable: boolean): void {
    if (!name) return;
    const current = this.health.get(name) ?? { reachable: undefined, failures: 0 };
    this.health.set(name, {
      reachable,
      lastResultAtNs: this.host.engine().now(),
      failures: reachable ? current.failures : current.failures + 1,
    });
  }

  private serverNameFor(address: string): string | undefined {
    return this.aaa().servers.find((server) => server.address === address)?.name;
  }

  private nextRadiusIdentifier(): number {
    this.radiusIdentifier = (this.radiusIdentifier + 1) % 256;
    return this.radiusIdentifier;
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.host.engine();
    engine.trace({ time: engine.now(), type, device: this.host.deviceId, detail });
  }
}

function methodName(method: AaaMethod): AuthenticationMethodName {
  return method === "local" ? "local" : method === "none" ? "none" : method;
}
