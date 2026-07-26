import { NS_PER_S } from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import {
  type BpduPacket,
  type BpduPortRole,
  type BridgeIdentifier,
  bridgeIdEquals,
  compareBridgeId,
  comparePortId,
  formatBridgeId,
  formatPortId,
  type PortIdentifier,
  type SpanningTreeProtocolVersion,
} from "../packets/bpdu";
import type { Mac } from "../util/mac";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";
import { ProtocolActivity } from "./protocol-activity";

/**
 * Deterministic IEEE 802.1D-like (PVST) and 802.1w-like (Rapid PVST) spanning
 * tree.
 *
 * This is an educational subset, not vendor or RFC parity: there is one
 * instance per active VLAN, links are always point-to-point, and MSTP, Loop
 * Guard, Root Guard, UDLD, UplinkFast, BackboneFast and Flex Links are out of
 * scope. Every timer is expressed in virtual nanoseconds and every tie-break is
 * derived from configured priorities and stable identifiers, never from
 * insertion order, so the browser worker and the server verifier elect exactly
 * the same root and reach exactly the same port roles and states.
 */

export type SpanningTreeMode = "disabled" | "stp" | "rstp";

export type SpanningTreePortRole = "root" | "designated" | "alternate" | "backup" | "disabled";

/** 802.1D exposes five states; 802.1w collapses the first three to discarding. */
export type SpanningTreePortState =
  | "disabled"
  | "blocking"
  | "listening"
  | "learning"
  | "forwarding"
  | "discarding";

export const DEFAULT_STP_HELLO_TIME_NS = 2 * NS_PER_S;
export const DEFAULT_STP_MAX_AGE_NS = 20 * NS_PER_S;
export const DEFAULT_STP_FORWARD_DELAY_NS = 15 * NS_PER_S;

/**
 * SimulatorNet models a single Ethernet link speed, so every port starts from
 * one documented default cost (the Cisco Gigabit Ethernet value). A later
 * milestone that models link speed profiles can derive this instead; until then
 * showing a speed the engine does not simulate would be dishonest.
 */
export const DEFAULT_STP_PATH_COST = 4;

export const DEFAULT_STP_BRIDGE_PRIORITY = 32_768;
export const STP_BRIDGE_PRIORITY_STEP = 4_096;
export const DEFAULT_STP_PORT_PRIORITY = 128;
export const STP_PORT_PRIORITY_STEP = 16;

/** Ticks the protocol keeps running after its last state change. */
const STP_QUIESCENCE_ROUNDS = 4;
const STP_MAXIMUM_TICKS = 4_096;

export interface SpanningTreeTimers {
  readonly helloTimeNs: number;
  readonly maxAgeNs: number;
  readonly forwardDelayNs: number;
}

export interface SpanningTreePortConfiguration {
  /** Explicit `spanning-tree cost`; undefined uses the default Ethernet cost. */
  readonly cost?: number;
  readonly priority: number;
  readonly portFast: boolean;
  readonly bpduGuard: boolean;
}

/** A logical STP port: a physical interface, or an EtherChannel bundle. */
export interface SpanningTreeLogicalPort {
  readonly id: string;
  /** Stable port number used in the port identifier; never insertion order. */
  readonly number: number;
  readonly adminUp: boolean;
  readonly operationalUp: boolean;
  readonly vlans: readonly number[];
  readonly pointToPoint: boolean;
}

/** The device surface the spanning tree needs; `L2Switch` implements it. */
export interface SpanningTreeBridge {
  readonly id: string;
  readonly name: string;
  readonly engine: SimulationEngine;
  spanningTreeBridgeMac(): Mac;
  spanningTreeLogicalPorts(): readonly SpanningTreeLogicalPort[];
  spanningTreeSendBpdu(portId: string, bpdu: BpduPacket): void;
  spanningTreeFlushForwarding(vlanId: number): void;
}

export interface SpanningTreePortSummary {
  readonly port: string;
  readonly role: SpanningTreePortRole;
  readonly state: SpanningTreePortState;
  readonly cost: number;
  readonly priority: number;
  readonly portId: string;
  readonly portFast: boolean;
  readonly edge: boolean;
  readonly bpduGuard: boolean;
  readonly errorDisabled: boolean;
  readonly designatedRootId?: string;
  readonly designatedBridgeId?: string;
  readonly designatedPortId?: string;
  readonly designatedCost?: number;
  readonly lastBpduAtNs?: number;
}

export interface SpanningTreeInstanceSummary {
  readonly vlanId: number;
  readonly mode: SpanningTreeMode;
  readonly bridgeId: string;
  readonly bridgePriority: number;
  readonly rootId: string;
  readonly rootPathCost: number;
  readonly rootPort?: string;
  readonly isRoot: boolean;
  readonly helloTimeNs: number;
  readonly maxAgeNs: number;
  readonly forwardDelayNs: number;
  readonly topologyChanges: number;
  readonly lastTopologyChangeNs?: number;
  readonly ports: readonly SpanningTreePortSummary[];
}

export interface SpanningTreeSummary {
  readonly mode: SpanningTreeMode;
  readonly bridgeMac: Mac;
  readonly timers: SpanningTreeTimers;
  readonly instances: readonly SpanningTreeInstanceSummary[];
  readonly errorDisabledPorts: readonly string[];
}

interface ReceivedBpduInfo {
  rootId: BridgeIdentifier;
  rootPathCost: number;
  bridgeId: BridgeIdentifier;
  portId: PortIdentifier;
  receivedAtNs: number;
  messageAgeNs: number;
  maxAgeNs: number;
  topologyChange: boolean;
  proposal: boolean;
  agreement: boolean;
  role: BpduPortRole;
  /** 802.1w: the peer told us its port is already forwarding towards the root. */
  peerForwarding: boolean;
}

interface InstancePort {
  readonly id: string;
  role: SpanningTreePortRole;
  state: SpanningTreePortState;
  received: ReceivedBpduInfo | undefined;
  /** A port that has ever seen a BPDU can never be an edge port again. */
  bpduSeen: boolean;
  /** Invalidates in-flight forward-delay transitions after a role change. */
  generation: number;
  proposalPending: boolean;
}

interface PriorityVector {
  readonly rootId: BridgeIdentifier;
  readonly cost: number;
  readonly bridgeId: BridgeIdentifier;
  readonly portId: PortIdentifier;
}

function comparePriorityVector(a: PriorityVector, b: PriorityVector): number {
  const root = compareBridgeId(a.rootId, b.rootId);
  if (root !== 0) return root;
  if (a.cost !== b.cost) return a.cost - b.cost;
  const bridge = compareBridgeId(a.bridgeId, b.bridgeId);
  if (bridge !== 0) return bridge;
  return comparePortId(a.portId, b.portId);
}

export function stateAllowsLearning(state: SpanningTreePortState): boolean {
  return state === "learning" || state === "forwarding";
}

export function stateAllowsForwarding(state: SpanningTreePortState): boolean {
  return state === "forwarding";
}

class SpanningTreeInstance {
  rootId: BridgeIdentifier;
  rootPathCost = 0;
  rootPort: string | undefined;
  topologyChanges = 0;
  lastTopologyChangeNs: number | undefined;
  topologyChangeFlagUntilNs = 0;
  readonly ports = new Map<string, InstancePort>();

  constructor(readonly vlanId: number, bridgeId: BridgeIdentifier) {
    this.rootId = bridgeId;
  }
}

export class SpanningTree {
  private mode: SpanningTreeMode = "disabled";
  private timers: SpanningTreeTimers = {
    helloTimeNs: DEFAULT_STP_HELLO_TIME_NS,
    maxAgeNs: DEFAULT_STP_MAX_AGE_NS,
    forwardDelayNs: DEFAULT_STP_FORWARD_DELAY_NS,
  };
  private readonly vlanPriorities = new Map<number, number>();
  private defaultPriority = DEFAULT_STP_BRIDGE_PRIORITY;
  private readonly portConfig = new Map<string, SpanningTreePortConfiguration>();
  private readonly errorDisabledPorts = new Set<string>();
  private readonly instances = new Map<number, SpanningTreeInstance>();
  private readonly activity: ProtocolActivity;

  constructor(private readonly bridge: SpanningTreeBridge) {
    this.activity = new ProtocolActivity(
      () => this.engineOrUndefined(),
      {
        name: "spanning-tree",
        intervalNs: this.timers.helloTimeNs,
        quiescenceRounds: STP_QUIESCENCE_ROUNDS,
        maximumTicks: STP_MAXIMUM_TICKS,
      },
      () => this.tick(),
    );
  }

  // --- configuration -----------------------------------------------------

  get enabled(): boolean {
    return this.mode !== "disabled";
  }

  get currentMode(): SpanningTreeMode {
    return this.mode;
  }

  get version(): SpanningTreeProtocolVersion {
    return this.mode === "rstp" ? "rstp" : "stp";
  }

  setMode(mode: SpanningTreeMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.instances.clear();
    if (mode === "disabled") {
      this.activity.quiesce();
      return;
    }
    this.arm();
  }

  /** `spanning-tree vlan <id> priority <n>`; must be a multiple of 4096. */
  setBridgePriority(vlanId: number, priority: number): void {
    validatePriority(priority, STP_BRIDGE_PRIORITY_STEP, 61_440, "Bridge priority");
    this.vlanPriorities.set(vlanId, priority);
    this.arm();
  }

  /** `spanning-tree priority <n>` applied to every instance. */
  setDefaultBridgePriority(priority: number): void {
    validatePriority(priority, STP_BRIDGE_PRIORITY_STEP, 61_440, "Bridge priority");
    this.defaultPriority = priority;
    this.arm();
  }

  bridgePriorityOf(vlanId: number): number {
    return this.vlanPriorities.get(vlanId) ?? this.defaultPriority;
  }

  configuredVlanPriorities(): Array<{ vlanId: number; priority: number }> {
    return [...this.vlanPriorities.entries()]
      .map(([vlanId, priority]) => ({ vlanId, priority }))
      .sort((a, b) => a.vlanId - b.vlanId);
  }

  setTimers(timers: Partial<SpanningTreeTimers>): void {
    const next = { ...this.timers, ...timers };
    if (next.helloTimeNs <= 0 || next.maxAgeNs <= 0 || next.forwardDelayNs <= 0) {
      throw new Error("Spanning tree timers must be positive");
    }
    this.timers = next;
    this.arm();
  }

  currentTimers(): SpanningTreeTimers {
    return { ...this.timers };
  }

  portConfigurationOf(portId: string): SpanningTreePortConfiguration {
    return this.portConfig.get(portId) ?? { priority: DEFAULT_STP_PORT_PRIORITY, portFast: false, bpduGuard: false };
  }

  /** Port entries that differ from the defaults, for canonical serialization. */
  configuredPorts(): Array<{ port: string; configuration: SpanningTreePortConfiguration }> {
    return [...this.portConfig.entries()]
      .filter(([, configuration]) => configuration.cost !== undefined
        || configuration.priority !== DEFAULT_STP_PORT_PRIORITY
        || configuration.portFast
        || configuration.bpduGuard)
      .map(([port, configuration]) => ({ port, configuration: { ...configuration } }))
      .sort((a, b) => a.port.localeCompare(b.port));
  }

  setPortCost(portId: string, cost: number | undefined): void {
    if (cost !== undefined && (!Number.isInteger(cost) || cost < 1 || cost > 200_000_000)) {
      throw new Error("Spanning tree port cost must be between 1 and 200000000");
    }
    this.updatePortConfig(portId, (current) => ({ ...current, cost }));
  }

  setPortPriority(portId: string, priority: number): void {
    validatePriority(priority, STP_PORT_PRIORITY_STEP, 240, "Port priority");
    this.updatePortConfig(portId, (current) => ({ ...current, priority }));
  }

  setPortFast(portId: string, enabled: boolean): void {
    this.updatePortConfig(portId, (current) => ({ ...current, portFast: enabled }));
  }

  setBpduGuard(portId: string, enabled: boolean): void {
    this.updatePortConfig(portId, (current) => ({ ...current, bpduGuard: enabled }));
  }

  private updatePortConfig(
    portId: string,
    update: (current: SpanningTreePortConfiguration) => SpanningTreePortConfiguration,
  ): void {
    this.portConfig.set(portId, update(this.portConfigurationOf(portId)));
    this.arm();
  }

  portCostOf(portId: string): number {
    return this.portConfigurationOf(portId).cost ?? DEFAULT_STP_PATH_COST;
  }

  // --- runtime -----------------------------------------------------------

  isErrorDisabled(portId: string): boolean {
    return this.errorDisabledPorts.has(portId);
  }

  errorDisabledList(): string[] {
    return [...this.errorDisabledPorts].sort();
  }

  /** Explicit recovery action; error-disabled state is runtime, never saved. */
  resetErrorDisabled(portId: string): boolean {
    const cleared = this.errorDisabledPorts.delete(portId);
    if (cleared) {
      this.trace("stp-port-recovered", { interface: portId });
      this.arm();
    }
    return cleared;
  }

  resetRuntime(): void {
    this.instances.clear();
    this.errorDisabledPorts.clear();
    this.activity.resetBudget();
    if (this.enabled) this.arm();
  }

  onPortStateChanged(portId: string): void {
    if (!this.enabled) return;
    for (const instance of this.instances.values()) {
      const port = instance.ports.get(portId);
      if (!port) continue;
      port.received = undefined;
      port.generation++;
      port.proposalPending = false;
    }
    this.arm();
  }

  /** The data-plane gate: what this logical port may do inside `vlanId`. */
  portState(portId: string, vlanId: number): SpanningTreePortState {
    if (!this.enabled) return "forwarding";
    if (this.errorDisabledPorts.has(portId)) return "disabled";
    const instance = this.instances.get(vlanId);
    const port = instance?.ports.get(portId);
    if (!port) return "forwarding";
    return port.state;
  }

  portRole(portId: string, vlanId: number): SpanningTreePortRole {
    if (!this.enabled) return "designated";
    const port = this.instances.get(vlanId)?.ports.get(portId);
    return port?.role ?? "disabled";
  }

  allowsLearning(portId: string, vlanId: number): boolean {
    return stateAllowsLearning(this.portState(portId, vlanId));
  }

  allowsForwarding(portId: string, vlanId: number): boolean {
    return stateAllowsForwarding(this.portState(portId, vlanId));
  }

  // --- BPDU reception ----------------------------------------------------

  onBpdu(bpdu: BpduPacket, portId: string): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    this.charge("bpduEvents");
    this.trace("bpdu-received", {
      interface: portId,
      vlan: bpdu.vlanId,
      root: formatBridgeId(bpdu.rootId),
      cost: bpdu.rootPathCost,
      sender: formatBridgeId(bpdu.bridgeId),
      senderPort: formatPortId(bpdu.portId),
      version: bpdu.version,
    });

    const configuration = this.portConfigurationOf(portId);
    if (configuration.bpduGuard) {
      if (!this.errorDisabledPorts.has(portId)) {
        this.errorDisabledPorts.add(portId);
        this.trace("bpdu-guard-triggered", {
          interface: portId,
          vlan: bpdu.vlanId,
          sender: formatBridgeId(bpdu.bridgeId),
          reason: "bpdu-received-on-guarded-port",
        });
        this.arm();
      }
      return;
    }
    if (!this.enabled) return;
    if (this.errorDisabledPorts.has(portId)) return;

    const instance = this.instances.get(bpdu.vlanId);
    const port = instance?.ports.get(portId);
    if (!instance || !port) return;

    // Receiving any BPDU cancels edge (PortFast) behaviour on this port.
    if (!port.bpduSeen) {
      port.bpduSeen = true;
      if (configuration.portFast) {
        this.trace("stp-portfast-cancelled", { interface: portId, vlan: bpdu.vlanId, reason: "bpdu-received" });
      }
    }

    port.received = {
      rootId: bpdu.rootId,
      rootPathCost: bpdu.rootPathCost,
      bridgeId: bpdu.bridgeId,
      portId: bpdu.portId,
      receivedAtNs: engine.now(),
      messageAgeNs: bpdu.messageAgeNs,
      maxAgeNs: bpdu.maxAgeNs,
      topologyChange: bpdu.topologyChange,
      proposal: bpdu.proposal === true,
      agreement: bpdu.agreement === true,
      role: bpdu.role ?? "unknown",
      peerForwarding: bpdu.forwarding === true,
    };

    if (bpdu.topologyChange) this.applyTopologyChange(instance, portId, "peer-topology-change");

    const changed = this.recompute(instance);

    if (this.mode === "rstp") {
      this.handleRapidHandshake(instance, port, bpdu);
    }
    if (changed) {
      this.transmit(instance);
      this.arm();
    }
  }

  // --- periodic work -----------------------------------------------------

  arm(): void {
    if (!this.enabled) return;
    this.synchronizeInstances();
    let changed = false;
    for (const instance of this.instances.values()) {
      if (this.recompute(instance)) changed = true;
    }
    if (changed) for (const instance of this.instances.values()) this.transmit(instance);
    this.activity.arm();
  }

  get active(): boolean {
    return this.activity.active;
  }

  private tick(): void {
    if (!this.enabled) return;
    this.synchronizeInstances();
    for (const instance of this.instances.values()) {
      this.expireReceivedInformation(instance);
      this.recompute(instance);
      this.transmit(instance);
    }
  }

  // --- instance maintenance ---------------------------------------------

  private synchronizeInstances(): void {
    const ports = this.bridge.spanningTreeLogicalPorts();
    const vlans = new Set<number>();
    for (const port of ports) {
      if (!port.adminUp) continue;
      for (const vlan of port.vlans) vlans.add(vlan);
    }
    enforceStructuralLimit("maximumSpanningTreeInstancesPerDevice", vlans.size);

    for (const vlanId of [...this.instances.keys()]) {
      if (!vlans.has(vlanId)) this.instances.delete(vlanId);
    }
    for (const vlanId of [...vlans].sort((a, b) => a - b)) {
      let instance = this.instances.get(vlanId);
      if (!instance) {
        instance = new SpanningTreeInstance(vlanId, this.bridgeId(vlanId));
        this.instances.set(vlanId, instance);
      }
      const participating = ports.filter((port) => port.adminUp && port.vlans.includes(vlanId));
      enforceStructuralLimit("maximumSpanningTreePortsPerInstance", participating.length);
      const ids = new Set(participating.map((port) => port.id));
      for (const id of [...instance.ports.keys()]) {
        if (!ids.has(id)) instance.ports.delete(id);
      }
      for (const port of participating) {
        if (instance.ports.has(port.id)) continue;
        instance.ports.set(port.id, {
          id: port.id,
          role: "disabled",
          state: "disabled",
          received: undefined,
          bpduSeen: false,
          generation: 0,
          proposalPending: false,
        });
      }
    }
  }

  private expireReceivedInformation(instance: SpanningTreeInstance): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    const now = engine.now();
    for (const port of instance.ports.values()) {
      if (!port.received) continue;
      const age = now - port.received.receivedAtNs + port.received.messageAgeNs;
      if (age >= Math.min(port.received.maxAgeNs, this.timers.maxAgeNs)) {
        port.received = undefined;
        port.generation++;
        this.trace("stp-message-age-expired", { interface: port.id, vlan: instance.vlanId });
      }
    }
  }

  // --- election ----------------------------------------------------------

  private recompute(instance: SpanningTreeInstance): boolean {
    const own = this.bridgeId(instance.vlanId);
    const logical = new Map(this.bridge.spanningTreeLogicalPorts().map((port) => [port.id, port]));

    const eligible: InstancePort[] = [];
    for (const port of instance.ports.values()) {
      const descriptor = logical.get(port.id);
      const usable = descriptor !== undefined
        && descriptor.operationalUp
        && !this.errorDisabledPorts.has(port.id);
      if (usable) eligible.push(port);
      else if (port.received !== undefined) port.received = undefined;
    }

    let rootId = own;
    for (const port of eligible) {
      if (port.received && compareBridgeId(port.received.rootId, rootId) < 0) rootId = port.received.rootId;
    }

    let rootPort: InstancePort | undefined;
    let rootPathCost = 0;
    if (!bridgeIdEquals(rootId, own)) {
      let best: { port: InstancePort; vector: PriorityVector } | undefined;
      for (const port of eligible) {
        const received = port.received;
        if (!received || !bridgeIdEquals(received.rootId, rootId)) continue;
        const vector: PriorityVector = {
          rootId,
          cost: received.rootPathCost + this.portCostOf(port.id),
          bridgeId: received.bridgeId,
          portId: received.portId,
        };
        if (!best
          || comparePriorityVector(vector, best.vector) < 0
          || (comparePriorityVector(vector, best.vector) === 0
            && comparePortId(this.portIdentifier(port.id), this.portIdentifier(best.port.id)) < 0)) {
          best = { port, vector };
        }
      }
      if (best) {
        rootPort = best.port;
        rootPathCost = best.vector.cost;
      } else {
        rootId = own;
      }
    }

    const previousRoot = instance.rootId;
    const previousRootPort = instance.rootPort;
    instance.rootId = rootId;
    instance.rootPathCost = rootPathCost;
    instance.rootPort = rootPort?.id;

    if (!bridgeIdEquals(previousRoot, rootId)) {
      this.trace("stp-root-elected", {
        vlan: instance.vlanId,
        root: formatBridgeId(rootId),
        previousRoot: formatBridgeId(previousRoot),
        bridge: formatBridgeId(own),
        rootPort: rootPort?.id ?? null,
        cost: rootPathCost,
        isLocal: bridgeIdEquals(rootId, own),
      });
    }

    let changed = previousRootPort !== instance.rootPort || !bridgeIdEquals(previousRoot, rootId);
    const designated: PriorityVector = { rootId, cost: rootPathCost, bridgeId: own, portId: { priority: 0, number: 0 } };

    for (const port of instance.ports.values()) {
      const descriptor = logical.get(port.id);
      const usable = descriptor !== undefined
        && descriptor.operationalUp
        && !this.errorDisabledPorts.has(port.id);
      let role: SpanningTreePortRole;
      if (!usable) {
        role = "disabled";
      } else if (port === rootPort) {
        role = "root";
      } else if (!port.received) {
        role = "designated";
      } else {
        const ours: PriorityVector = { ...designated, portId: this.portIdentifier(port.id) };
        const theirs: PriorityVector = {
          rootId: port.received.rootId,
          cost: port.received.rootPathCost,
          bridgeId: port.received.bridgeId,
          portId: port.received.portId,
        };
        if (comparePriorityVector(theirs, ours) < 0) {
          role = bridgeIdEquals(port.received.bridgeId, own) ? "backup" : "alternate";
        } else {
          role = "designated";
        }
      }
      if (this.applyRole(instance, port, role)) changed = true;
    }
    return changed;
  }

  private applyRole(instance: SpanningTreeInstance, port: InstancePort, role: SpanningTreePortRole): boolean {
    if (port.role === role) return false;
    const previousRole = port.role;
    port.role = role;
    port.generation++;
    port.proposalPending = false;
    this.charge("portTransitions", port.id);
    this.trace("stp-port-role-changed", {
      interface: port.id,
      vlan: instance.vlanId,
      previousRole,
      role,
      root: formatBridgeId(instance.rootId),
      cost: instance.rootPathCost,
      reason: "recomputed",
    });

    if (role === "disabled") {
      this.setState(instance, port, "disabled", "port-down");
      return true;
    }
    if (role === "alternate" || role === "backup") {
      this.setState(instance, port, this.mode === "rstp" ? "discarding" : "blocking", `role-${role}`);
      return true;
    }
    this.startTransitionToForwarding(instance, port);
    return true;
  }

  /** PortFast is only operational until the port has ever seen a BPDU. */
  private isEdge(port: InstancePort): boolean {
    return this.portConfigurationOf(port.id).portFast && !port.bpduSeen;
  }

  private startTransitionToForwarding(instance: SpanningTreeInstance, port: InstancePort): void {
    if (port.state === "forwarding") return;
    if (this.isEdge(port)) {
      this.setState(instance, port, "forwarding", "portfast-edge");
      return;
    }
    if (this.mode === "rstp") {
      // 802.1w rapid switchover: an alternate port that becomes the root port
      // may forward at once when its peer already forwards towards the root,
      // because unblocking it cannot close a loop.
      if (port.role === "root" && port.received?.peerForwarding && port.received.role === "designated") {
        this.setState(instance, port, "forwarding", "rstp-rapid-root-port");
        return;
      }
      // Otherwise a designated port proposes and only forwards once its peer
      // agrees; without an agreement it still falls back to the timed path.
      this.setState(instance, port, "discarding", "rapid-transition-start");
      if (port.role === "designated") port.proposalPending = true;
      this.scheduleTransition(instance, port, "learning", this.timers.forwardDelayNs);
      return;
    }
    this.setState(instance, port, "listening", "listening-timer");
    this.scheduleTransition(instance, port, "learning", this.timers.forwardDelayNs);
  }

  private scheduleTransition(
    instance: SpanningTreeInstance,
    port: InstancePort,
    next: SpanningTreePortState,
    delayNs: number,
  ): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    const generation = port.generation;
    engine.scheduleIn(delayNs, () => {
      if (port.generation !== generation) return;
      if (port.role !== "root" && port.role !== "designated") return;
      if (port.state === "forwarding") return;
      this.setState(instance, port, next, "forward-delay");
      if (next === "learning") {
        this.scheduleTransition(instance, port, "forwarding", this.timers.forwardDelayNs);
      } else {
        this.transmit(instance);
      }
    });
  }

  private setState(
    instance: SpanningTreeInstance,
    port: InstancePort,
    state: SpanningTreePortState,
    reason: string,
  ): void {
    if (port.state === state) return;
    const previousState = port.state;
    port.state = state;
    this.charge("portTransitions", port.id);
    this.trace("stp-port-state-changed", {
      interface: port.id,
      vlan: instance.vlanId,
      previousState,
      state,
      role: port.role,
      root: formatBridgeId(instance.rootId),
      reason,
    });
    const leftForwarding = previousState === "forwarding" && state !== "forwarding";
    const enteredForwarding = state === "forwarding" && previousState !== "forwarding";
    const othersForwarding = [...instance.ports.values()]
      .some((other) => other !== port && other.state === "forwarding");
    if (leftForwarding || (enteredForwarding && !this.isEdge(port) && othersForwarding)) {
      this.applyTopologyChange(instance, port.id, leftForwarding ? "port-left-forwarding" : "port-entered-forwarding");
    }
  }

  private applyTopologyChange(instance: SpanningTreeInstance, portId: string, reason: string): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    this.charge("topologyChanges");
    instance.topologyChanges++;
    instance.lastTopologyChangeNs = engine.now();
    instance.topologyChangeFlagUntilNs = engine.now() + this.timers.maxAgeNs + this.timers.forwardDelayNs;
    // Scoped ageing: only this VLAN's learned entries can now be stale.
    this.bridge.spanningTreeFlushForwarding(instance.vlanId);
    this.trace("stp-topology-change", {
      vlan: instance.vlanId,
      interface: portId,
      reason,
      changes: instance.topologyChanges,
      root: formatBridgeId(instance.rootId),
    });
  }

  // --- rapid handshake ---------------------------------------------------

  private handleRapidHandshake(instance: SpanningTreeInstance, port: InstancePort, bpdu: BpduPacket): void {
    if (bpdu.proposal && port.role === "root") {
      this.trace("rstp-proposal", {
        interface: port.id,
        vlan: instance.vlanId,
        sender: formatBridgeId(bpdu.bridgeId),
        root: formatBridgeId(instance.rootId),
      });
      // Sync: every non-edge designated port stops forwarding before the new
      // root port is unblocked, so the handshake can never create a loop.
      for (const other of instance.ports.values()) {
        if (other === port) continue;
        if (other.role !== "designated" || this.isEdge(other)) continue;
        this.setState(instance, other, "discarding", "rstp-sync");
        other.proposalPending = true;
      }
      this.setState(instance, port, "forwarding", "rstp-agreement-sent");
      this.sendBpdu(instance, port, { agreement: true });
      this.transmit(instance);
      return;
    }
    if (bpdu.agreement && port.role === "designated" && port.proposalPending) {
      port.proposalPending = false;
      this.trace("rstp-agreement", {
        interface: port.id,
        vlan: instance.vlanId,
        sender: formatBridgeId(bpdu.bridgeId),
      });
      this.setState(instance, port, "forwarding", "rstp-agreement-received");
    }
  }

  // --- transmission ------------------------------------------------------

  private transmit(instance: SpanningTreeInstance): void {
    const logical = new Map(this.bridge.spanningTreeLogicalPorts().map((port) => [port.id, port]));
    for (const port of instance.ports.values()) {
      if (port.role !== "designated") continue;
      const descriptor = logical.get(port.id);
      if (!descriptor?.operationalUp) continue;
      if (this.errorDisabledPorts.has(port.id)) continue;
      this.sendBpdu(instance, port, {});
    }
  }

  private sendBpdu(
    instance: SpanningTreeInstance,
    port: InstancePort,
    overrides: { agreement?: boolean },
  ): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    this.charge("bpduEvents");
    const own = this.bridgeId(instance.vlanId);
    const rapid = this.mode === "rstp";
    const bpdu: BpduPacket = {
      kind: "bpdu",
      version: this.version,
      type: "configuration",
      vlanId: instance.vlanId,
      rootId: instance.rootId,
      rootPathCost: instance.rootPathCost,
      bridgeId: own,
      portId: this.portIdentifier(port.id),
      messageAgeNs: bridgeIdEquals(instance.rootId, own) ? 0 : this.timers.helloTimeNs,
      maxAgeNs: this.timers.maxAgeNs,
      helloTimeNs: this.timers.helloTimeNs,
      forwardDelayNs: this.timers.forwardDelayNs,
      topologyChange: engine.now() < instance.topologyChangeFlagUntilNs,
      topologyChangeAck: false,
      ...(rapid
        ? {
            proposal: overrides.agreement ? false : port.proposalPending,
            agreement: overrides.agreement === true,
            role: bpduRole(port.role),
            learning: port.state === "learning",
            forwarding: port.state === "forwarding",
            edge: this.isEdge(port),
          }
        : {}),
    };
    this.trace("bpdu-sent", {
      interface: port.id,
      vlan: instance.vlanId,
      root: formatBridgeId(instance.rootId),
      cost: instance.rootPathCost,
      role: port.role,
      state: port.state,
      version: bpdu.version,
      proposal: bpdu.proposal === true,
      agreement: bpdu.agreement === true,
    });
    this.bridge.spanningTreeSendBpdu(port.id, bpdu);
  }

  // --- inspection --------------------------------------------------------

  /** Read-only inspection: refreshes instance membership, never re-arms timers. */
  summary(): SpanningTreeSummary {
    if (this.enabled) this.synchronizeInstances();
    const logical = new Map(this.bridge.spanningTreeLogicalPorts().map((port) => [port.id, port]));
    const instances = [...this.instances.values()]
      .sort((a, b) => a.vlanId - b.vlanId)
      .map((instance): SpanningTreeInstanceSummary => {
        const own = this.bridgeId(instance.vlanId);
        return {
          vlanId: instance.vlanId,
          mode: this.mode,
          bridgeId: formatBridgeId(own),
          bridgePriority: this.bridgePriorityOf(instance.vlanId),
          rootId: formatBridgeId(instance.rootId),
          rootPathCost: instance.rootPathCost,
          rootPort: instance.rootPort,
          isRoot: bridgeIdEquals(instance.rootId, own),
          helloTimeNs: this.timers.helloTimeNs,
          maxAgeNs: this.timers.maxAgeNs,
          forwardDelayNs: this.timers.forwardDelayNs,
          topologyChanges: instance.topologyChanges,
          lastTopologyChangeNs: instance.lastTopologyChangeNs,
          ports: [...instance.ports.values()]
            .sort((a, b) => (logical.get(a.id)?.number ?? 0) - (logical.get(b.id)?.number ?? 0)
              || a.id.localeCompare(b.id))
            .map((port): SpanningTreePortSummary => {
              const configuration = this.portConfigurationOf(port.id);
              return {
                port: port.id,
                role: port.role,
                state: port.state,
                cost: this.portCostOf(port.id),
                priority: configuration.priority,
                portId: formatPortId(this.portIdentifier(port.id)),
                portFast: configuration.portFast,
                edge: this.isEdge(port),
                bpduGuard: configuration.bpduGuard,
                errorDisabled: this.errorDisabledPorts.has(port.id),
                designatedRootId: port.received ? formatBridgeId(port.received.rootId) : undefined,
                designatedBridgeId: port.received ? formatBridgeId(port.received.bridgeId) : undefined,
                designatedPortId: port.received ? formatPortId(port.received.portId) : undefined,
                designatedCost: port.received?.rootPathCost,
                lastBpduAtNs: port.received?.receivedAtNs,
              };
            }),
        };
      });
    return {
      mode: this.mode,
      bridgeMac: this.bridge.spanningTreeBridgeMac(),
      timers: { ...this.timers },
      instances,
      errorDisabledPorts: this.errorDisabledList(),
    };
  }

  // --- identifiers -------------------------------------------------------

  bridgeId(vlanId: number): BridgeIdentifier {
    return { priority: this.bridgePriorityOf(vlanId), vlanId, mac: this.bridge.spanningTreeBridgeMac() };
  }

  portIdentifier(portId: string): PortIdentifier {
    const descriptor = this.bridge.spanningTreeLogicalPorts().find((port) => port.id === portId);
    return { priority: this.portConfigurationOf(portId).priority, number: descriptor?.number ?? 0 };
  }

  // --- helpers -----------------------------------------------------------

  private engineOrUndefined(): SimulationEngine | undefined {
    return (this.bridge as { engine?: SimulationEngine }).engine;
  }

  /**
   * Charge one unit of the shared per-operation budget. Port transitions are
   * scoped per logical port so one flapping link cannot starve the others.
   */
  private charge(key: "bpduEvents" | "portTransitions" | "topologyChanges", scope?: string): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    engine.controlProtocolBudget.consume(key, scope === undefined ? undefined : `${this.bridge.id}/${scope}`);
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    engine.trace({ time: engine.now(), type, device: this.bridge.id, detail });
  }
}

function bpduRole(role: SpanningTreePortRole): BpduPortRole {
  return role === "disabled" ? "unknown" : role;
}

function validatePriority(value: number, step: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum || value % step !== 0) {
    throw new ControlProtocolConfigurationError(
      `${label} must be a multiple of ${step} between 0 and ${maximum}`,
      label,
    );
  }
}
