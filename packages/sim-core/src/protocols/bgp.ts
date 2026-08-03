import type { SimulationEngine } from "../engine/simulation-engine";
import {
  BGP_TCP_PORT,
  BGP_VERSION,
  isBgpMessage,
  type BgpMessage,
  type BgpNotificationMessage,
} from "../packets/bgp";
import type { TcpApplicationPayload } from "../packets/tcp";
import { TcpState, type TcpConnection, type TcpConnectionHandlers } from "../transport/tcp";
import type { HostTransportStack } from "../transport/host-transport";
import type { Ipv4 } from "../util/ipv4";
import { intToIp, ipToInt, maskToInt } from "../util/ipv4";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";
import { RoutingPolicyEngine, type RoutePolicyBinding } from "../routing/route-policy";

export const DEFAULT_BGP_KEEPALIVE_SECONDS = 60;
export const DEFAULT_BGP_HOLD_SECONDS = 180;

export type BgpSessionState =
  | "idle"
  | "connect"
  | "active"
  | "open-sent"
  | "open-confirm"
  | "established";

export interface BgpNeighborConfiguration {
  readonly address: Ipv4;
  readonly remoteAs: number;
  readonly description?: string;
  readonly updateSource?: string;
  readonly ebgpMultihop?: number;
  readonly enabled?: boolean;
  readonly nextHopSelf?: boolean;
  readonly prefixListIn?: string;
  readonly prefixListOut?: string;
  readonly routeMapIn?: string;
  readonly routeMapOut?: string;
}

export interface BgpNetworkStatement {
  readonly network: Ipv4;
  readonly prefixLength: number;
}

export interface BgpConfiguration {
  readonly localAs: number;
  readonly routerId?: Ipv4;
  readonly keepaliveSeconds?: number;
  readonly holdTimeSeconds?: number;
  readonly neighbors?: readonly BgpNeighborConfiguration[];
  readonly networks?: readonly BgpNetworkStatement[];
}

export type BgpRouteSource = "local" | "ebgp" | "ibgp";

export interface BgpRoute {
  readonly network: Ipv4;
  readonly prefixLength: number;
  readonly origin: "igp" | "egp" | "incomplete";
  readonly asPath: readonly number[];
  readonly nextHop: Ipv4;
  readonly localPreference: number;
  readonly med: number;
  readonly weight: number;
  readonly source: BgpRouteSource;
  readonly neighborAddress?: Ipv4;
  readonly neighborAs?: number;
  readonly neighborRouterId?: Ipv4;
  readonly learnedAtNs: number;
  readonly routeId: string;
  readonly igpMetric: number;
}

export interface BgpRibEntry extends BgpRoute {
  readonly best: boolean;
  readonly valid: boolean;
  readonly rejectionReason?: string;
}

export interface BgpNeighborSummary {
  readonly address: Ipv4;
  readonly remoteAs: number;
  readonly state: BgpSessionState;
  readonly description?: string;
  readonly localAddress?: Ipv4;
  readonly negotiatedHoldTimeSeconds?: number;
  readonly lastError?: string;
  readonly messagesSent: number;
  readonly messagesReceived: number;
}

export interface BgpHost {
  readonly id: string;
  readonly engine: SimulationEngine;
  readonly management: HostTransportStack;
  bgpSourceAddress(remoteAddress: Ipv4, updateSource?: string): Ipv4 | undefined;
  bgpOwnsAddress(address: Ipv4): boolean;
  bgpRouteReachable(address: Ipv4): boolean;
  bgpExactRouteExists(network: Ipv4, prefixLength: number): boolean;
  bgpIgpMetric(address: Ipv4): number | undefined;
  bgpRoutesChanged(): void;
}

interface NeighborRuntime {
  configuration: BgpNeighborConfiguration;
  state: BgpSessionState;
  connection?: TcpConnection;
  localAddress?: Ipv4;
  negotiatedHoldTimeSeconds?: number;
  lastReceivedAtNs?: number;
  lastError?: string;
  messagesSent: number;
  messagesReceived: number;
  generation: number;
  remoteRouterId?: Ipv4;
}

const ORIGIN_ORDER: Readonly<Record<BgpRoute["origin"], number>> = Object.freeze({ igp: 0, egp: 1, incomplete: 2 });

/** Cisco-like deterministic educational best-path ordering. */
export function compareBgpPaths(left: BgpRoute, right: BgpRoute): number {
  if (left.weight !== right.weight) return right.weight - left.weight;
  if (left.localPreference !== right.localPreference) return right.localPreference - left.localPreference;
  if ((left.source === "local") !== (right.source === "local")) return left.source === "local" ? -1 : 1;
  if (left.asPath.length !== right.asPath.length) return left.asPath.length - right.asPath.length;
  if (ORIGIN_ORDER[left.origin] !== ORIGIN_ORDER[right.origin]) return ORIGIN_ORDER[left.origin] - ORIGIN_ORDER[right.origin];
  if (left.neighborAs !== undefined && left.neighborAs === right.neighborAs && left.med !== right.med) {
    return left.med - right.med;
  }
  if ((left.source === "ebgp") !== (right.source === "ebgp")) return left.source === "ebgp" ? -1 : 1;
  if (left.igpMetric !== right.igpMetric) return left.igpMetric - right.igpMetric;
  if (left.learnedAtNs !== right.learnedAtNs) return left.learnedAtNs - right.learnedAtNs;
  const routerId = ipToInt(left.neighborRouterId ?? "0.0.0.0") - ipToInt(right.neighborRouterId ?? "0.0.0.0");
  if (routerId !== 0) return routerId;
  const neighbor = ipToInt(left.neighborAddress ?? "0.0.0.0") - ipToInt(right.neighborAddress ?? "0.0.0.0");
  return neighbor || left.routeId.localeCompare(right.routeId);
}

export function selectBestBgpPath(routes: readonly BgpRoute[]): BgpRoute | undefined {
  return [...routes].sort(compareBgpPaths)[0];
}

function validateAsn(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 4_294_967_295) {
    throw new ControlProtocolConfigurationError(`${field} must be between 1 and 4294967295`, field);
  }
}

function validateTimer(value: number, field: string, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new ControlProtocolConfigurationError(`${field} must be between 0 and ${maximum} seconds`, field);
  }
}

/**
 * Deterministic educational BGPv4 session layer. It deliberately carries
 * structured messages over the shared simulated TCP stack: reachability,
 * ACL/firewall policy, TCP retransmission and IP TTL therefore remain real
 * parts of the simulation instead of direct process-to-process calls.
 */
export class BgpProcess {
  readonly routingPolicy = new RoutingPolicyEngine(() => this.reevaluatePolicies());
  private configuration: BgpConfiguration | undefined;
  private readonly neighbors = new Map<Ipv4, NeighborRuntime>();
  private readonly rawAdjRibIn = new Map<Ipv4, Map<string, BgpRoute>>();
  private readonly adjRibIn = new Map<Ipv4, Map<string, BgpRoute>>();
  private readonly locRib = new Map<string, BgpRoute>();
  private readonly adjRibOut = new Map<Ipv4, Map<string, BgpRoute>>();
  private readonly ribFailures = new Map<string, string>();
  private listening = false;

  constructor(private readonly host: BgpHost) {}

  get enabled(): boolean {
    return this.configuration !== undefined;
  }

  get localAs(): number | undefined {
    return this.configuration?.localAs;
  }

  configure(configuration: BgpConfiguration): void {
    validateAsn(configuration.localAs, "localAs");
    const keepaliveSeconds = configuration.keepaliveSeconds ?? DEFAULT_BGP_KEEPALIVE_SECONDS;
    const holdTimeSeconds = configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
    validateTimer(keepaliveSeconds, "keepaliveSeconds", 65_535);
    validateTimer(holdTimeSeconds, "holdTimeSeconds", 65_535);
    if (holdTimeSeconds !== 0 && keepaliveSeconds * 3 > holdTimeSeconds) {
      throw new ControlProtocolConfigurationError(
        "BGP hold time must be zero or at least three times the keepalive time",
        "holdTimeSeconds",
      );
    }
    if (configuration.routerId !== undefined) ipToInt(configuration.routerId);
    const configured = [...(configuration.neighbors ?? [])];
    enforceStructuralLimit("maximumBgpPeersPerDevice", configured.length);
    const seen = new Set<string>();
    for (const neighbor of configured) {
      ipToInt(neighbor.address);
      validateAsn(neighbor.remoteAs, "remoteAs");
      if (seen.has(neighbor.address)) {
        throw new ControlProtocolConfigurationError(`Duplicate BGP neighbor ${neighbor.address}`, "neighbors");
      }
      seen.add(neighbor.address);
      if (neighbor.ebgpMultihop !== undefined
        && (!Number.isInteger(neighbor.ebgpMultihop) || neighbor.ebgpMultihop < 1 || neighbor.ebgpMultihop > 255)) {
        throw new ControlProtocolConfigurationError("eBGP multihop TTL must be between 1 and 255", "ebgpMultihop");
      }
    }
    const networks = [...(configuration.networks ?? [])];
    for (const network of networks) {
      if (!Number.isInteger(network.prefixLength) || network.prefixLength < 0 || network.prefixLength > 32) {
        throw new ControlProtocolConfigurationError("BGP network prefix length must be between 0 and 32", "networks");
      }
      const mask = maskToInt(network.prefixLength);
      if (((ipToInt(network.network) & mask) >>> 0) !== ipToInt(network.network)) {
        throw new ControlProtocolConfigurationError("BGP network statement must use a canonical network address", "networks");
      }
    }
    this.resetRuntime(false);
    this.configuration = { ...configuration, keepaliveSeconds, holdTimeSeconds, neighbors: configured, networks };
    this.neighbors.clear();
    for (const neighbor of configured.sort((a, b) => ipToInt(a.address) - ipToInt(b.address))) {
      this.neighbors.set(neighbor.address, {
        configuration: { ...neighbor },
        state: "idle",
        messagesSent: 0,
        messagesReceived: 0,
        generation: 0,
      });
    }
    this.refreshRoutes();
    this.start();
  }

  disable(): void {
    this.resetRuntime(true);
    this.configuration = undefined;
    this.neighbors.clear();
    this.adjRibIn.clear();
    this.rawAdjRibIn.clear();
    this.locRib.clear();
    this.adjRibOut.clear();
    this.ribFailures.clear();
  }

  start(): void {
    if (!this.configuration) return;
    this.ensureListener();
    for (const runtime of this.neighbors.values()) this.tryConnect(runtime);
  }

  restart(address?: Ipv4): void {
    const selected = address === undefined ? [...this.neighbors.values()] : [this.requireNeighbor(address)];
    for (const runtime of selected) {
      runtime.connection?.abort();
      runtime.connection = undefined;
      runtime.lastError = undefined;
      runtime.generation++;
      this.transition(runtime, "idle", "administrative reset");
      this.tryConnect(runtime);
    }
  }

  onInterfaceStateChanged(): void {
    for (const runtime of this.neighbors.values()) {
      if (runtime.state === "established" && !this.host.bgpRouteReachable(runtime.configuration.address)) {
        this.fail(runtime, "transport route unavailable");
      } else if (runtime.state !== "established") {
        this.tryConnect(runtime);
      }
    }
  }

  summaries(): BgpNeighborSummary[] {
    return [...this.neighbors.values()]
      .map((runtime) => ({
        address: runtime.configuration.address,
        remoteAs: runtime.configuration.remoteAs,
        state: runtime.state,
        description: runtime.configuration.description,
        localAddress: runtime.localAddress,
        negotiatedHoldTimeSeconds: runtime.negotiatedHoldTimeSeconds,
        lastError: runtime.lastError,
        messagesSent: runtime.messagesSent,
        messagesReceived: runtime.messagesReceived,
      }))
      .sort((a, b) => ipToInt(a.address) - ipToInt(b.address));
  }

  routes(): BgpRibEntry[] {
    const all = new Map<string, BgpRoute>();
    for (const routes of this.adjRibIn.values()) {
      for (const route of routes.values()) all.set(`${route.routeId}\u0000${route.neighborAddress ?? ""}`, route);
    }
    for (const route of this.localCandidates()) all.set(route.routeId, route);
    return [...all.values()].map((route) => ({
      ...route,
      best: this.locRib.get(this.prefixKey(route.network, route.prefixLength))?.routeId === route.routeId,
      valid: this.ribFailures.get(route.routeId) === undefined,
      rejectionReason: this.ribFailures.get(route.routeId),
    })).sort((a, b) => a.network.localeCompare(b.network) || a.prefixLength - b.prefixLength || compareBgpPaths(a, b));
  }

  selectedRoutes(): BgpRoute[] {
    return [...this.locRib.values()].sort((a, b) =>
      ipToInt(a.network) - ipToInt(b.network) || b.prefixLength - a.prefixLength || a.routeId.localeCompare(b.routeId));
  }

  adjRibInEntries(address?: Ipv4): BgpRoute[] {
    const entries = address === undefined ? [...this.adjRibIn.values()] : [this.adjRibIn.get(address) ?? new Map()];
    return entries.flatMap((rib) => [...rib.values()]).sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  adjRibOutEntries(address?: Ipv4): BgpRoute[] {
    const entries = address === undefined ? [...this.adjRibOut.values()] : [this.adjRibOut.get(address) ?? new Map()];
    return entries.flatMap((rib) => [...rib.values()]).sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  ribFailureSummaries(): Array<{ routeId: string; reason: string }> {
    return [...this.ribFailures.entries()].map(([routeId, reason]) => ({ routeId, reason }))
      .sort((a, b) => a.routeId.localeCompare(b.routeId));
  }

  refreshRoutes(): void {
    if (!this.configuration) return;
    this.recomputeLocRib();
    this.advertiseRoutes();
  }

  configurationSnapshot(): BgpConfiguration | undefined {
    if (!this.configuration) return undefined;
    return {
      ...this.configuration,
      neighbors: [...(this.configuration.neighbors ?? [])].map((neighbor) => ({ ...neighbor })),
      networks: [...(this.configuration.networks ?? [])].map((network) => ({ ...network })),
    };
  }

  setNetworks(networks: readonly BgpNetworkStatement[]): void {
    if (!this.configuration) {
      throw new ControlProtocolConfigurationError("BGP process is not configured", "networks");
    }
    for (const network of networks) {
      if (!Number.isInteger(network.prefixLength) || network.prefixLength < 0 || network.prefixLength > 32) {
        throw new ControlProtocolConfigurationError("BGP network prefix length must be between 0 and 32", "networks");
      }
      const mask = maskToInt(network.prefixLength);
      if (((ipToInt(network.network) & mask) >>> 0) !== ipToInt(network.network)) {
        throw new ControlProtocolConfigurationError("BGP network statement must use a canonical network address", "networks");
      }
    }
    this.configuration = { ...this.configuration, networks: networks.map((network) => ({ ...network })) };
    this.refreshRoutes();
  }

  outboundTtl(remoteAddress: Ipv4): number | undefined {
    const runtime = this.neighbors.get(remoteAddress);
    if (!runtime || !this.configuration) return undefined;
    return runtime.configuration.remoteAs === this.configuration.localAs
      ? 64
      : (runtime.configuration.ebgpMultihop ?? 1);
  }

  private ensureListener(): void {
    if (this.listening) return;
    try {
      this.host.management.tcp.listen(BGP_TCP_PORT, (connection) => this.accept(connection), "bgp");
      this.listening = true;
    } catch (error) {
      this.trace("bgp-session-rejected", { reason: error instanceof Error ? error.message : "TCP port unavailable" });
    }
  }

  private tryConnect(runtime: NeighborRuntime): void {
    if (!this.configuration || runtime.configuration.enabled === false || runtime.connection) return;
    const localAddress = this.host.bgpSourceAddress(runtime.configuration.address, runtime.configuration.updateSource);
    if (localAddress === undefined) {
      runtime.lastError = runtime.configuration.updateSource
        ? `update-source ${runtime.configuration.updateSource} has no usable IPv4 address`
        : "no usable local IPv4 address";
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    runtime.localAddress = localAddress;
    if (!this.host.bgpRouteReachable(runtime.configuration.address)) {
      runtime.lastError = "neighbor is not reachable through the IPv4 routing table";
      this.transition(runtime, "active", runtime.lastError);
      return;
    }
    // Exactly one side actively opens a symmetric session. The lower endpoint
    // wins, avoiding duplicate TCP sessions without randomness.
    if (ipToInt(localAddress) > ipToInt(runtime.configuration.address)) {
      this.transition(runtime, "active", "waiting for deterministic passive open");
      return;
    }
    this.transition(runtime, "connect");
    const handlers = this.handlers(runtime);
    try {
      runtime.connection = this.host.management.tcp.connect(
        runtime.configuration.address,
        BGP_TCP_PORT,
        handlers,
        "bgp",
        localAddress,
      );
    } catch (error) {
      runtime.connection = undefined;
      runtime.lastError = error instanceof Error ? error.message : "TCP open failed";
      this.transition(runtime, "active", runtime.lastError);
    }
  }

  private accept(connection: TcpConnection): void {
    const remote = connection.remoteAddress as Ipv4;
    const runtime = this.neighbors.get(remote);
    if (!runtime || runtime.configuration.enabled === false || !this.host.bgpOwnsAddress(connection.localAddress as Ipv4)) {
      connection.setHandlers({ onEstablished: (established) => established.close() });
      this.trace("bgp-session-rejected", { neighbor: remote, reason: "unconfigured neighbor" });
      return;
    }
    runtime.connection?.abort();
    runtime.connection = connection;
    runtime.localAddress = connection.localAddress as Ipv4;
    connection.setHandlers(this.handlers(runtime));
    this.onTcpEstablished(runtime, connection);
  }

  private handlers(runtime: NeighborRuntime): TcpConnectionHandlers {
    return {
      onEstablished: (connection) => this.onTcpEstablished(runtime, connection),
      onMessage: (payload, connection) => this.onTcpMessage(runtime, payload, connection),
      onClosed: () => this.onTcpClosed(runtime, "TCP connection closed"),
      onReset: () => this.onTcpClosed(runtime, "TCP connection reset"),
    };
  }

  private onTcpEstablished(runtime: NeighborRuntime, connection: TcpConnection): void {
    if (runtime.connection !== connection || connection.state !== TcpState.Established || !this.configuration) return;
    this.transition(runtime, "open-sent");
    this.send(runtime, {
      kind: "bgp-open",
      version: BGP_VERSION,
      localAs: this.configuration.localAs,
      holdTimeSeconds: this.configuration.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS,
      bgpIdentifier: this.configuration.routerId ?? runtime.localAddress ?? "0.0.0.0",
    });
  }

  private onTcpMessage(runtime: NeighborRuntime, payload: unknown, connection: TcpConnection): void {
    if (runtime.connection !== connection
      || typeof payload !== "object" || payload === null
      || (payload as { kind?: unknown }).kind !== "tcp-application"
      || (payload as TcpApplicationPayload).protocol !== "bgp"
      || !isBgpMessage((payload as TcpApplicationPayload).data)) {
      this.notifyAndFail(runtime, "message-header", "invalid-message", "Malformed BGP message");
      return;
    }
    const message = (payload as TcpApplicationPayload).data as BgpMessage;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.messagesReceived++;
    runtime.lastReceivedAtNs = this.host.engine.now();
    this.trace("bgp-message-received", { neighbor: runtime.configuration.address, messageType: message.kind });
    if (message.kind === "bgp-open") {
      if (runtime.state !== "open-sent") {
        this.notifyAndFail(runtime, "open-message", "unexpected-open", "Unexpected OPEN message");
        return;
      }
      if (message.version !== BGP_VERSION || message.localAs !== runtime.configuration.remoteAs) {
        this.notifyAndFail(runtime, "open-message", "bad-peer-as", "Remote AS does not match neighbor configuration");
        return;
      }
      const localHold = this.configuration?.holdTimeSeconds ?? DEFAULT_BGP_HOLD_SECONDS;
      runtime.negotiatedHoldTimeSeconds = Math.min(localHold, message.holdTimeSeconds);
      runtime.remoteRouterId = message.bgpIdentifier;
      this.transition(runtime, "open-confirm");
      this.send(runtime, { kind: "bgp-keepalive" });
      return;
    }
    if (message.kind === "bgp-keepalive") {
      if (runtime.state === "open-confirm") {
        this.transition(runtime, "established");
        this.trace("bgp-session-established", { neighbor: runtime.configuration.address });
        this.refreshRoutes();
      }
      return;
    }
    if (message.kind === "bgp-notification") {
      this.fail(runtime, `${message.code}/${message.subcode}: ${message.message}`);
      return;
    }
    if (runtime.state !== "established") {
      this.notifyAndFail(runtime, "update-message", "unexpected-update", "UPDATE received before Established");
      return;
    }
    this.applyUpdate(runtime, message);
    this.trace("bgp-update-received", {
      neighbor: runtime.configuration.address,
      announced: message.nlri.length,
      withdrawn: message.withdrawn.length,
    });
  }

  private send(runtime: NeighborRuntime, message: BgpMessage): void {
    if (!runtime.connection || runtime.connection.state !== TcpState.Established) return;
    this.host.engine.controlProtocolBudget.consume("bgpMessages", this.host.id);
    runtime.connection.send({ kind: "tcp-application", protocol: "bgp", data: message });
    runtime.messagesSent++;
    this.trace(message.kind === "bgp-update" ? "bgp-update-sent" : "bgp-message-sent", {
      neighbor: runtime.configuration.address,
      messageType: message.kind,
      ...(message.kind === "bgp-update" ? { announced: message.nlri.length, withdrawn: message.withdrawn.length } : {}),
    });
  }

  private notifyAndFail(
    runtime: NeighborRuntime,
    code: BgpNotificationMessage["code"],
    subcode: string,
    message: string,
  ): void {
    this.send(runtime, { kind: "bgp-notification", code, subcode, message });
    this.trace("bgp-notification", { neighbor: runtime.configuration.address, code, subcode, message });
    this.fail(runtime, message);
  }

  private onTcpClosed(runtime: NeighborRuntime, reason: string): void {
    if (!runtime.connection) return;
    runtime.connection = undefined;
    this.rawAdjRibIn.delete(runtime.configuration.address);
    this.adjRibIn.delete(runtime.configuration.address);
    this.adjRibOut.delete(runtime.configuration.address);
    this.recomputeLocRib();
    this.fail(runtime, reason, false);
  }

  private fail(runtime: NeighborRuntime, reason: string, abort = true): void {
    const connection = runtime.connection;
    runtime.connection = undefined;
    runtime.lastError = reason;
    runtime.generation++;
    if (abort) connection?.abort();
    this.transition(runtime, "idle", reason);
    this.trace("bgp-session-failed", { neighbor: runtime.configuration.address, reason });
  }

  private transition(runtime: NeighborRuntime, state: BgpSessionState, reason?: string): void {
    if (runtime.state === state) return;
    const previous = runtime.state;
    this.host.engine.controlProtocolBudget.consume("bgpStateTransitions", this.host.id);
    runtime.state = state;
    this.trace("bgp-state-changed", { neighbor: runtime.configuration.address, previous, state, reason });
  }

  private requireNeighbor(address: Ipv4): NeighborRuntime {
    const neighbor = this.neighbors.get(address);
    if (!neighbor) throw new ControlProtocolConfigurationError(`BGP neighbor ${address} is not configured`, "neighbor");
    return neighbor;
  }

  private resetRuntime(removeListener: boolean): void {
    for (const runtime of this.neighbors.values()) runtime.connection?.abort();
    if (removeListener && this.listening) {
      this.host.management.tcp.unlisten(BGP_TCP_PORT);
      this.listening = false;
    }
  }

  private applyUpdate(runtime: NeighborRuntime, message: Extract<BgpMessage, { kind: "bgp-update" }>): void {
    if (!this.configuration) return;
    const rawRib = this.rawAdjRibIn.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
    for (const withdrawn of message.withdrawn) rawRib.delete(this.prefixKey(withdrawn.network, withdrawn.prefixLength));
    enforceStructuralLimit("maximumBgpPrefixesPerPeer", rawRib.size + message.nlri.length);
    for (const nlri of message.nlri) {
      if (nlri.prefixLength < 0 || nlri.prefixLength > 32 || nlri.path.asPath.length > 256) {
        this.trace("bgp-route-rejected", { neighbor: runtime.configuration.address, routeId: nlri.routeId, reason: "malformed NLRI" });
        continue;
      }
      if (nlri.path.asPath.includes(this.configuration.localAs)) {
        this.trace("bgp-loop-rejected", { neighbor: runtime.configuration.address, routeId: nlri.routeId });
        continue;
      }
      const igpMetric = this.host.bgpIgpMetric(nlri.path.nextHop);
      const route: BgpRoute = {
        network: intToIp((ipToInt(nlri.network) & maskToInt(nlri.prefixLength)) >>> 0),
        prefixLength: nlri.prefixLength,
        origin: nlri.path.origin,
        asPath: [...nlri.path.asPath],
        nextHop: nlri.path.nextHop,
        localPreference: nlri.path.localPreference ?? 100,
        med: nlri.path.med ?? 0,
        weight: 0,
        source: runtime.configuration.remoteAs === this.configuration.localAs ? "ibgp" : "ebgp",
        neighborAddress: runtime.configuration.address,
        neighborAs: runtime.configuration.remoteAs,
        neighborRouterId: runtime.remoteRouterId,
        learnedAtNs: this.host.engine.now(),
        routeId: nlri.routeId,
        igpMetric: igpMetric ?? Number.MAX_SAFE_INTEGER,
      };
      rawRib.set(this.prefixKey(route.network, route.prefixLength), route);
    }
    this.rawAdjRibIn.set(runtime.configuration.address, rawRib);
    this.evaluateInboundRib(runtime);
    this.recomputeLocRib();
    this.advertiseRoutes();
  }

  private localCandidates(): BgpRoute[] {
    if (!this.configuration) return [];
    const routerId = this.configuration.routerId ?? "0.0.0.0";
    return [...(this.configuration.networks ?? [])]
      .filter((network) => this.host.bgpExactRouteExists(network.network, network.prefixLength))
      .map((network) => ({
        network: network.network,
        prefixLength: network.prefixLength,
        origin: "igp" as const,
        asPath: [],
        nextHop: "0.0.0.0",
        localPreference: 100,
        med: 0,
        weight: 32_768,
        source: "local" as const,
        neighborRouterId: routerId,
        learnedAtNs: 0,
        routeId: `local:${network.network}/${network.prefixLength}`,
        igpMetric: 0,
      }));
  }

  private recomputeLocRib(): void {
    const candidates = [...this.localCandidates(), ...this.adjRibInEntries()];
    const groups = new Map<string, BgpRoute[]>();
    this.ribFailures.clear();
    for (const route of candidates) {
      if (route.source !== "local" && this.host.bgpIgpMetric(route.nextHop) === undefined) {
        this.ribFailures.set(route.routeId, `next hop ${route.nextHop} is unreachable`);
        continue;
      }
      const key = this.prefixKey(route.network, route.prefixLength);
      const group = groups.get(key) ?? [];
      group.push({ ...route, igpMetric: route.source === "local" ? 0 : (this.host.bgpIgpMetric(route.nextHop) ?? route.igpMetric) });
      groups.set(key, group);
    }
    const next = new Map<string, BgpRoute>();
    for (const [key, routes] of groups) {
      const best = selectBestBgpPath(routes);
      if (best) next.set(key, best);
    }
    const before = JSON.stringify([...this.locRib.entries()]);
    const after = JSON.stringify([...next.entries()]);
    if (before === after) return;
    this.locRib.clear();
    for (const [key, route] of next) this.locRib.set(key, route);
    this.host.bgpRoutesChanged();
    this.trace("bgp-best-path-changed", { routes: this.locRib.size });
  }

  private advertiseRoutes(): void {
    if (!this.configuration) return;
    for (const runtime of this.neighbors.values()) {
      if (runtime.state !== "established" || !runtime.localAddress) continue;
      const previous = this.adjRibOut.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
      const desired = new Map<string, BgpRoute>();
      const announcements: import("../packets/bgp").BgpNlri[] = [];
      for (const route of this.locRib.values()) {
        if (route.neighborAddress === runtime.configuration.address) continue;
        const peerIsIbgp = runtime.configuration.remoteAs === this.configuration.localAs;
        if (peerIsIbgp && route.source === "ibgp") continue;
        const advertised: BgpRoute = {
          ...route,
          asPath: peerIsIbgp ? [...route.asPath] : [this.configuration.localAs, ...route.asPath],
          nextHop: (!peerIsIbgp || runtime.configuration.nextHopSelf || route.source === "local")
            ? runtime.localAddress
            : route.nextHop,
          routeId: `${this.configuration.routerId ?? this.host.id}:${route.network}/${route.prefixLength}`,
        };
        const decision = this.routingPolicy.evaluate(advertised, this.outboundBinding(runtime.configuration), this.configuration.localAs);
        this.trace(decision.action === "permit" ? "bgp-policy-permit" : "bgp-policy-deny", {
          direction: "out",
          neighbor: runtime.configuration.address,
          routeId: advertised.routeId,
          reason: decision.reason,
        });
        if (decision.action === "deny") continue;
        const permitted = decision.route;
        desired.set(this.prefixKey(route.network, route.prefixLength), permitted);
        if (JSON.stringify(previous.get(this.prefixKey(route.network, route.prefixLength))) !== JSON.stringify(permitted)) {
          announcements.push({
            network: permitted.network,
            prefixLength: permitted.prefixLength,
            routeId: permitted.routeId,
            path: {
              origin: permitted.origin,
              asPath: permitted.asPath,
              nextHop: permitted.nextHop,
              localPreference: peerIsIbgp ? permitted.localPreference : undefined,
              med: permitted.med,
            },
          });
        }
      }
      const withdrawn = [...previous.entries()]
        .filter(([key]) => !desired.has(key))
        .map(([, route]) => ({ network: route.network, prefixLength: route.prefixLength }));
      if (announcements.length || withdrawn.length) {
        this.send(runtime, { kind: "bgp-update", withdrawn, nlri: announcements });
      }
      this.adjRibOut.set(runtime.configuration.address, desired);
    }
  }

  private prefixKey(network: Ipv4, prefixLength: number): string {
    return `${network}/${prefixLength}`;
  }

  private reevaluatePolicies(): void {
    if (!this.configuration) return;
    for (const runtime of this.neighbors.values()) this.evaluateInboundRib(runtime);
    this.recomputeLocRib();
    // Force comparison against the pre-change outbound policy result.
    this.advertiseRoutes();
  }

  private evaluateInboundRib(runtime: NeighborRuntime): void {
    if (!this.configuration) return;
    const raw = this.rawAdjRibIn.get(runtime.configuration.address) ?? new Map<string, BgpRoute>();
    const evaluated = new Map<string, BgpRoute>();
    for (const [key, route] of raw) {
      const decision = this.routingPolicy.evaluate(route, this.inboundBinding(runtime.configuration), this.configuration.localAs);
      this.trace(decision.action === "permit" ? "bgp-policy-permit" : "bgp-policy-deny", {
        direction: "in",
        neighbor: runtime.configuration.address,
        routeId: route.routeId,
        reason: decision.reason,
        matchedPrefixListSequence: decision.matchedPrefixListSequence,
        matchedRouteMapSequence: decision.matchedRouteMapSequence,
      });
      if (decision.action === "permit") evaluated.set(key, decision.route);
    }
    this.adjRibIn.set(runtime.configuration.address, evaluated);
  }

  private inboundBinding(configuration: BgpNeighborConfiguration): RoutePolicyBinding {
    return { prefixListId: configuration.prefixListIn, routeMapId: configuration.routeMapIn };
  }

  private outboundBinding(configuration: BgpNeighborConfiguration): RoutePolicyBinding {
    return { prefixListId: configuration.prefixListOut, routeMapId: configuration.routeMapOut };
  }

  private trace(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.host.engine.trace({ time: this.host.engine.now(), type, device: this.host.id, detail });
  }
}
