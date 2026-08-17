import { NS_PER_MS, NS_PER_S } from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import {
  lsaChecksum,
  lsaHeaderOf,
  lsaKey,
  OSPF_ALL_ROUTERS,
  OSPF_BACKBONE_AREA,
  type OspfDatabaseDescriptionPacket,
  type OspfHelloPacket,
  type OspfLinkStateAckPacket,
  type OspfLinkStateRequestPacket,
  type OspfLinkStateUpdatePacket,
  type OspfLsa,
  type OspfLsaChecksumInput,
  type OspfLsaHeader,
  type OspfNeighborState,
  type OspfNetworkType,
  type OspfPacket,
  type OspfRouterLsaLink,
} from "../packets/ospf";
import { intToIp, type Ipv4, ipToInt, maskToInt } from "../util/ipv4";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";
import { ProtocolActivity } from "./protocol-activity";
import { compareOspfRouterIds, sortOspfElectionCandidates } from "./ospf-common";

/**
 * Deterministic OSPFv2 for IPv4, area 0 only.
 *
 * Every timer is virtual, every tie-break comes from a configured value or a
 * stable identifier, and the SPF walk never relies on `Map` insertion order, so
 * the browser worker and the server verifier reach the same adjacencies, the
 * same LSDB and the same routing table. Like the other control protocols it
 * runs inside a bounded activity window: it ticks while it has work and goes
 * quiescent afterwards, so an Auto run always terminates.
 */

export const DEFAULT_OSPF_HELLO_INTERVAL_NS = 10 * NS_PER_S;
export const DEFAULT_OSPF_DEAD_INTERVAL_NS = 40 * NS_PER_S;
export const DEFAULT_OSPF_COST = 10;
export const DEFAULT_OSPF_PRIORITY = 1;
export const OSPF_ADMINISTRATIVE_DISTANCE = 110;

/**
 * How long a router waits, in virtual time, between asking for SPF and running
 * it — the deterministic equivalent of a real router's SPF throttle.
 *
 * One stimulus produces a *wave*: an interface comes up, an adjacency reaches
 * Full, the description exchange completes, and every advertisement the fabric
 * holds arrives one link-state update at a time. Running the walk on each of
 * them rebuilds the same tree over and over and makes a cold start cost grow
 * with the square of the fabric. The wave itself is short — cables are half a
 * millisecond apart and a whole 128-router flood settles in a few dozen — so one
 * deterministic delay an order of magnitude above it collapses the wave into a
 * single computation while staying far below the ten second hello interval.
 */
export const OSPF_SPF_COALESCE_DELAY_NS = 100 * NS_PER_MS;

/**
 * How long a router waits for a Link State Acknowledgment before offering the
 * same advertisement again — RFC 2328's RxmtInterval, five seconds, in virtual
 * time.
 *
 * A link is finite. A cold start hands the whole database to every adjacency at
 * once, and on the default 256-packet egress queue a large area tail-drops part
 * of that burst; nothing here ages or refreshes an LSA, so a lost update would
 * otherwise be lost for good. Five seconds is far longer than the milliseconds
 * a flood wave takes to clock out, so the retry meets an empty queue rather than
 * the congestion that caused the loss, and far shorter than the forty second
 * dead interval, so a recovered adjacency never has to be rebuilt.
 */
export const OSPF_RETRANSMISSION_INTERVAL_NS = 5 * NS_PER_S;

const OSPF_QUIESCENCE_ROUNDS = 4;
const OSPF_MAXIMUM_TICKS = 4_096;
/**
 * Retransmissions of one LSA instance to one neighbour, *after* the first offer.
 *
 * Three retries span fifteen virtual seconds, which stays inside the dead
 * interval and is what the supported 128-router area needs: the measured cold
 * start loses its updates in one burst and recovers every one of them on the
 * first retry, so the remaining two are headroom rather than the expected path.
 * The bound is what stops a neighbour that has stopped acknowledging from
 * keeping the retransmission timer — and therefore the simulation — alive.
 */
const MAXIMUM_LSA_RETRANSMISSIONS = 3;

export interface OspfNetworkStatement {
  readonly network: Ipv4;
  readonly wildcard: Ipv4;
  readonly area: number;
}

export interface OspfInterfaceConfiguration {
  readonly area?: number;
  readonly cost?: number;
  readonly priority?: number;
  readonly networkType?: OspfNetworkType;
  readonly helloIntervalNs?: number;
  readonly deadIntervalNs?: number;
  /** Set by `ip ospf <process> area 0`; overrides the network statements. */
  readonly enabled?: boolean;
}

export interface OspfConfiguration {
  readonly processId: number;
  readonly routerId?: Ipv4;
  readonly networks: readonly OspfNetworkStatement[];
  readonly passiveInterfaces: readonly string[];
  readonly interfaces: ReadonlyArray<{ id: string; configuration: OspfInterfaceConfiguration }>;
}

export interface OspfNeighborSummary {
  readonly neighborRouterId: Ipv4;
  readonly priority: number;
  readonly state: OspfNeighborState;
  readonly address: Ipv4;
  readonly interfaceId: string;
  readonly role: "dr" | "bdr" | "drother" | "point-to-point";
  readonly deadTimeNs: number;
  readonly lastHelloAtNs: number;
}

export interface OspfInterfaceSummary {
  readonly interfaceId: string;
  readonly area: number;
  readonly cost: number;
  readonly state: "down" | "waiting" | "dr" | "bdr" | "drother" | "point-to-point" | "loopback";
  readonly networkType: OspfNetworkType | "loopback";
  readonly helloIntervalNs: number;
  readonly deadIntervalNs: number;
  readonly priority: number;
  readonly designatedRouter?: Ipv4;
  readonly backupDesignatedRouter?: Ipv4;
  readonly passive: boolean;
  readonly address?: Ipv4;
  readonly neighborCount: number;
}

export interface OspfLsdbEntry {
  readonly type: "router" | "network";
  readonly linkStateId: Ipv4;
  readonly advertisingRouter: Ipv4;
  readonly sequence: number;
  readonly ageNs: number;
  readonly checksum: number;
  readonly linkCount: number;
}

export interface OspfRoute {
  readonly network: Ipv4;
  readonly maskInt: number;
  readonly nextHop: Ipv4 | undefined;
  readonly interfaceId: string;
  readonly cost: number;
}

/**
 * How the SPF schedule actually behaved, for tests and diagnostics.
 *
 * A request, a scheduled event and a computation are three different things,
 * and only the last one is expensive — `maximumSpfRunsPerOperation` counts
 * `executions` alone. These counters are runtime: they are never serialized
 * into a `LabDocument`, a submission or a grading result.
 */
export interface OspfSpfCounters {
  /** Times something asked for a recomputation. */
  readonly requests: number;
  /** Requests absorbed by an SPF event that was already scheduled. */
  readonly coalescedRequests: number;
  /** Deterministic virtual events the schedule created. */
  readonly scheduledEvents: number;
  /** Walks actually performed, which is what the per-operation budget bounds. */
  readonly executions: number;
  /** Walks skipped because every input the walk reads was unchanged. */
  readonly skippedUnchanged: number;
  /** Walks skipped because the database describes nothing but this router. */
  readonly skippedEmptyTopology: number;
}

export interface OspfOverview {
  readonly processId: number;
  readonly running: boolean;
  readonly routerId?: Ipv4;
  readonly routerIdSource: "configured" | "loopback" | "interface" | "none";
  readonly area: number;
  readonly spfRuns: number;
  readonly lastSpfAtNs?: number;
  readonly defaultCost: number;
  readonly lsaCount: number;
  readonly neighborCount: number;
  readonly problems: readonly string[];
}

/** An L3 interface as OSPF sees it. */
export interface OspfInterfaceDescriptor {
  readonly id: string;
  readonly address: Ipv4 | undefined;
  readonly maskInt: number;
  readonly operationalUp: boolean;
  readonly loopback: boolean;
}

/** The device surface the OSPF process needs; `Router` implements it. */
export interface OspfHost {
  readonly id: string;
  readonly name: string;
  readonly engine: SimulationEngine;
  ospfInterfaces(): readonly OspfInterfaceDescriptor[];
  ospfSend(interfaceId: string, destination: Ipv4, packet: OspfPacket): void;
  /** Routing table changed: recompute the forwarding decisions. */
  ospfRoutesChanged(): void;
}

/**
 * One LSA instance offered to a neighbour and not yet acknowledged.
 *
 * The header *is* the instance identity: sequence and checksum together are
 * what `isNewer` compares, so a re-originated body can never be mistaken for
 * the advertisement still in flight, and an acknowledgement for the older
 * instance can never clear the newer one.
 */
interface UnacknowledgedLsa {
  readonly header: OspfLsaHeader;
  readonly firstSentAtNs: number;
  lastSentAtNs: number;
  /** Transmissions of this instance so far, the first offer included. */
  attempts: number;
}

/** One outstanding retransmission-list entry, for inspection and tests. */
export interface OspfRetransmissionEntry {
  readonly neighborRouterId: Ipv4;
  readonly interfaceId: string;
  readonly type: OspfLsaHeader["type"];
  readonly linkStateId: Ipv4;
  readonly advertisingRouter: Ipv4;
  readonly sequence: number;
  readonly checksum: number;
  readonly attempts: number;
  readonly firstSentAtNs: number;
  readonly lastSentAtNs: number;
}

/**
 * How reliable flooding actually behaved, for tests and diagnostics.
 *
 * Runtime only: never serialized into a `LabDocument`, a submission or a
 * grading result.
 */
export interface OspfFloodCounters {
  /** LSA instances put on a retransmission list for the first time. */
  readonly offers: number;
  /** Instances offered again because no acknowledgement arrived. */
  readonly retransmissions: number;
  /** Instances an acknowledgement cleared, explicit or implied. */
  readonly acknowledgements: number;
  /** Instances given up on after the retransmission bound, each with a problem. */
  readonly abandoned: number;
  /** Link State Update packets carrying first offers. */
  readonly initialUpdates: number;
  /** Link State Update packets carrying retransmissions. */
  readonly retransmittedUpdates: number;
  /** Instances still waiting for an acknowledgement right now. */
  readonly outstanding: number;
}

interface NeighborRuntime {
  routerId: Ipv4;
  address: Ipv4;
  interfaceId: string;
  priority: number;
  state: OspfNeighborState;
  designatedRouter: Ipv4 | undefined;
  backupDesignatedRouter: Ipv4 | undefined;
  lastHelloAtNs: number;
  deadIntervalNs: number;
  master: boolean;
  ddSequence: number;
  pendingRequests: string[];
  /** Retransmission list, keyed by LSA identity and bounded by the LSDB. */
  unacknowledged: Map<string, UnacknowledgedLsa>;
  rejectionReason: string | undefined;
}

interface InterfaceRuntime {
  id: string;
  designatedRouter: Ipv4 | undefined;
  backupDesignatedRouter: Ipv4 | undefined;
  /** Non-preemptive: an elected DR is kept until it or the interface fails. */
  electionSettled: boolean;
  /** Virtual time the interface came up, for the OSPF wait timer. */
  upSinceNs: number | undefined;
}

export class OspfProcess {
  private processId = 1;
  private configuredRouterId: Ipv4 | undefined;
  private activeRouterId: Ipv4 | undefined;
  private routerIdSource: OspfOverview["routerIdSource"] = "none";
  private running = false;
  private readonly networks: OspfNetworkStatement[] = [];
  private readonly passiveInterfaces = new Set<string>();
  private readonly interfaceConfig = new Map<string, OspfInterfaceConfiguration>();
  private readonly interfaceRuntime = new Map<string, InterfaceRuntime>();
  private readonly neighbors = new Map<string, NeighborRuntime>();
  private readonly lsdb = new Map<string, OspfLsa>();
  private readonly problems = new Set<string>();
  private routes: OspfRoute[] = [];
  private sequence = 0x80000001;
  private spfRuns = 0;
  private lastSpfAtNs: number | undefined;
  /** Fingerprint of the inputs the last SPF walk actually read. */
  private lastSpfInputs: string | undefined;
  /** Bumped by every request; the schedule only ever chases the latest one. */
  private spfRequestedRevision = 0;
  /** The revision the most recent computation observed. */
  private spfCompletedRevision = 0;
  /** True while a deterministic SPF event is on the queue. */
  private spfScheduled = false;
  /** Re-entrancy guard: installing routes makes other subsystems look back. */
  private spfExecuting = false;
  private spfMetrics = emptySpfCounters();
  /** True while one deterministic retransmission event is on the queue. */
  private retransmissionScheduled = false;
  private floodMetrics = emptyFloodCounters();
  /** Virtual time of the most recent tick, used to freeze the dead timers. */
  private lastActiveAtNs: number | undefined;
  private readonly activity: ProtocolActivity;

  constructor(private readonly host: OspfHost) {
    this.activity = new ProtocolActivity(
      () => this.engineOrUndefined(),
      {
        name: "ospf",
        intervalNs: DEFAULT_OSPF_HELLO_INTERVAL_NS,
        quiescenceRounds: OSPF_QUIESCENCE_ROUNDS,
        maximumTicks: OSPF_MAXIMUM_TICKS,
      },
      () => this.tick(),
    );
  }

  // --- configuration ------------------------------------------------------

  /** `router ospf <process-id>`. */
  createProcess(processId: number): void {
    if (!Number.isInteger(processId) || processId < 1 || processId > 65_535) {
      throw new ControlProtocolConfigurationError("OSPF process id must be between 1 and 65535", "processId");
    }
    if (this.running && processId !== this.processId) {
      throw new ControlProtocolConfigurationError(
        `OSPF process ${this.processId} is already running; SimulatorNet supports one process per device`,
        "processId",
      );
    }
    this.processId = processId;
    this.running = true;
    this.arm();
  }

  /** `no router ospf <process-id>`. */
  removeProcess(): void {
    this.running = false;
    this.resetRuntime();
  }

  get enabled(): boolean {
    return this.running;
  }

  get currentProcessId(): number {
    return this.processId;
  }

  /** `router-id <a.b.c.d>`. */
  setRouterId(routerId: Ipv4 | undefined): void {
    this.configuredRouterId = routerId;
    if (routerId !== undefined) {
      // The router id never drifts after the process starts; an explicit
      // `clear ip ospf process` re-selects it.
      this.activeRouterId = undefined;
    }
    this.arm();
  }

  configuredRouterIdValue(): Ipv4 | undefined {
    return this.configuredRouterId;
  }

  /** `network <address> <wildcard> area 0`. */
  addNetwork(network: Ipv4, wildcard: Ipv4, area: number): void {
    this.requireBackbone(area);
    const key = `${network} ${wildcard}`;
    if (this.networks.some((statement) => `${statement.network} ${statement.wildcard}` === key)) return;
    this.networks.push({ network, wildcard, area });
    this.arm();
  }

  removeNetwork(network: Ipv4, wildcard: Ipv4): void {
    const index = this.networks.findIndex((statement) =>
      statement.network === network && statement.wildcard === wildcard);
    if (index >= 0) this.networks.splice(index, 1);
    this.arm();
  }

  /** `passive-interface <name>`. */
  setPassiveInterface(interfaceId: string, passive: boolean): void {
    if (passive) this.passiveInterfaces.add(interfaceId);
    else this.passiveInterfaces.delete(interfaceId);
    this.arm();
  }

  /** `ip ospf <process> area 0`, `ip ospf cost`, `ip ospf priority`, ... */
  configureInterface(interfaceId: string, configuration: OspfInterfaceConfiguration): void {
    if (configuration.area !== undefined) this.requireBackbone(configuration.area);
    if (configuration.cost !== undefined
      && (!Number.isInteger(configuration.cost) || configuration.cost < 1 || configuration.cost > 65_535)) {
      throw new ControlProtocolConfigurationError("OSPF interface cost must be between 1 and 65535", "cost");
    }
    if (configuration.priority !== undefined
      && (!Number.isInteger(configuration.priority) || configuration.priority < 0 || configuration.priority > 255)) {
      throw new ControlProtocolConfigurationError("OSPF interface priority must be between 0 and 255", "priority");
    }
    for (const [field, value] of [
      ["helloIntervalNs", configuration.helloIntervalNs],
      ["deadIntervalNs", configuration.deadIntervalNs],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new ControlProtocolConfigurationError(`OSPF ${field} must be positive`, field);
      }
    }
    this.interfaceConfig.set(interfaceId, { ...this.interfaceConfigurationOf(interfaceId), ...configuration });
    this.arm();
  }

  removeInterfaceConfiguration(interfaceId: string): void {
    this.interfaceConfig.delete(interfaceId);
    this.arm();
  }

  interfaceConfigurationOf(interfaceId: string): OspfInterfaceConfiguration {
    return this.interfaceConfig.get(interfaceId) ?? {};
  }

  private requireBackbone(area: number): void {
    if (area !== OSPF_BACKBONE_AREA) {
      throw new ControlProtocolConfigurationError(
        `Only OSPF area ${OSPF_BACKBONE_AREA} is supported in this release`,
        "area",
      );
    }
  }

  /** Persistent configuration only; no adjacency, LSDB or SPF runtime. */
  configuration(): OspfConfiguration {
    return {
      processId: this.processId,
      routerId: this.configuredRouterId,
      networks: [...this.networks]
        .sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || ipToInt(a.wildcard) - ipToInt(b.wildcard))
        .map((statement) => ({ ...statement })),
      passiveInterfaces: [...this.passiveInterfaces].sort((a, b) => a.localeCompare(b)),
      interfaces: [...this.interfaceConfig.entries()]
        .filter(([, configuration]) => Object.values(configuration).some((value) => value !== undefined))
        .map(([id, configuration]) => ({ id, configuration: { ...configuration } }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  // --- router id ----------------------------------------------------------

  /**
   * Configured id, else the highest active loopback address, else the highest
   * active interface address. Once the process is running the id is frozen
   * until an explicit restart, exactly like a real router.
   */
  private selectRouterId(): Ipv4 | undefined {
    if (this.activeRouterId !== undefined) return this.activeRouterId;
    if (this.configuredRouterId !== undefined) {
      this.activeRouterId = this.configuredRouterId;
      this.routerIdSource = "configured";
      return this.activeRouterId;
    }
    const interfaces = this.host.ospfInterfaces().filter((iface) => iface.address !== undefined);
    const highest = (candidates: readonly OspfInterfaceDescriptor[]): Ipv4 | undefined =>
      candidates.reduce<Ipv4 | undefined>((best, iface) =>
        best === undefined || ipToInt(iface.address!) > ipToInt(best) ? iface.address : best, undefined);
    const loopback = highest(interfaces.filter((iface) => iface.loopback && iface.operationalUp));
    if (loopback !== undefined) {
      this.activeRouterId = loopback;
      this.routerIdSource = "loopback";
      return loopback;
    }
    const physical = highest(interfaces.filter((iface) => !iface.loopback && iface.operationalUp));
    if (physical !== undefined) {
      this.activeRouterId = physical;
      this.routerIdSource = "interface";
      return physical;
    }
    this.routerIdSource = "none";
    return undefined;
  }

  routerId(): Ipv4 | undefined {
    return this.activeRouterId;
  }

  // --- lifecycle ----------------------------------------------------------

  /** `clear ip ospf process`: drop runtime, keep configuration, start again. */
  restart(): void {
    const wasRunning = this.running;
    this.resetRuntime();
    this.running = wasRunning;
    if (wasRunning) this.arm();
  }

  resetRuntime(): void {
    this.neighbors.clear();
    this.lsdb.clear();
    this.interfaceRuntime.clear();
    this.problems.clear();
    this.routes = [];
    this.activeRouterId = undefined;
    this.routerIdSource = "none";
    this.sequence = 0x80000001;
    this.spfRuns = 0;
    this.lastSpfAtNs = undefined;
    this.lastSpfInputs = undefined;
    this.spfRequestedRevision = 0;
    this.spfCompletedRevision = 0;
    // An SPF event already on the queue is left to fire: it cannot be recalled,
    // and it finds an unchanged fingerprint and costs nothing. A retransmission
    // event is left the same way — every neighbour has just been dropped, so it
    // finds no outstanding instance and stops rather than rescheduling.
    this.spfScheduled = false;
    this.spfMetrics = emptySpfCounters();
    this.retransmissionScheduled = false;
    this.floodMetrics = emptyFloodCounters();
    this.lastActiveAtNs = undefined;
    this.activity.resetBudget();
    this.host.ospfRoutesChanged();
  }

  onInterfaceStateChanged(_interfaceId: string): void {
    if (!this.running) return;
    // A link transition tears the adjacency down at once: the local link state
    // is authoritative and far more useful in a lab than a dead-timer wait.
    for (const [key, neighbor] of [...this.neighbors]) {
      const descriptor = this.descriptorOf(neighbor.interfaceId);
      if (descriptor?.operationalUp) continue;
      this.neighbors.delete(key);
      this.traceNeighborState(neighbor, "down", "interface down");
    }
    for (const runtime of this.interfaceRuntime.values()) {
      const descriptor = this.descriptorOf(runtime.id);
      if (!descriptor?.operationalUp) {
        runtime.designatedRouter = undefined;
        runtime.backupDesignatedRouter = undefined;
        runtime.electionSettled = false;
        // A bounced interface restarts its wait timer, so the segment elects
        // again from the full set of neighbours rather than the first to answer.
        runtime.upSinceNs = undefined;
      }
    }
    this.arm();
  }

  /**
   * Re-open the activity window.
   *
   * While the process is quiescent nobody sends hellos, so a quiet stretch must
   * not count against any neighbour's dead interval — otherwise every adjacency
   * in a converged lab would collapse the moment virtual time was advanced.
   * Re-activating therefore shifts each neighbour's last-hello stamp forward by
   * the idle duration; only time during which the process was actually running
   * is charged to the dead timer.
   */
  arm(): void {
    if (!this.running) return;
    const engine = this.engineOrUndefined();
    if (engine && !this.activity.active && this.lastActiveAtNs !== undefined) {
      const idleNs = engine.now() - this.lastActiveAtNs;
      if (idleNs > 0) {
        for (const neighbor of this.neighbors.values()) neighbor.lastHelloAtNs += idleNs;
      }
      this.lastActiveAtNs = engine.now();
    }
    this.activity.arm();
  }

  get active(): boolean {
    return this.activity.active;
  }

  private tick(): void {
    if (!this.running) return;
    this.lastActiveAtNs = this.engine.now();
    const routerId = this.selectRouterId();
    if (routerId === undefined) {
      this.problems.add("OSPF process cannot start: no usable IPv4 address for the router id");
      return;
    }
    this.problems.delete("OSPF process cannot start: no usable IPv4 address for the router id");
    this.expireNeighbors();
    this.electDesignatedRouters();
    // The election may have just made some 2-Way neighbours adjacent.
    for (const neighbor of [...this.neighbors.values()].sort(byNeighborOrder)) {
      if (neighbor.state === "two-way" && this.shouldFormAdjacency(neighbor)) this.startExchange(neighbor);
    }
    this.sendHellos();
    this.originateLsas();
    this.requestSpf("periodic tick");
  }

  // --- interfaces ---------------------------------------------------------

  /** Interfaces OSPF actually runs on, in stable identifier order. */
  private enabledInterfaces(): OspfInterfaceDescriptor[] {
    return this.host.ospfInterfaces()
      .filter((iface) => iface.address !== undefined && this.interfaceEnabled(iface))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private interfaceEnabled(iface: OspfInterfaceDescriptor): boolean {
    const explicit = this.interfaceConfig.get(iface.id)?.enabled;
    // Interface configuration takes precedence over the network statements.
    if (explicit !== undefined) return explicit;
    if (iface.address === undefined) return false;
    return this.networks.some((statement) => matchesWildcard(iface.address!, statement.network, statement.wildcard));
  }

  private isPassive(iface: OspfInterfaceDescriptor): boolean {
    // A loopback has no peer, so it is always advertised and never adjacent.
    return iface.loopback || this.passiveInterfaces.has(iface.id);
  }

  private networkTypeOf(iface: OspfInterfaceDescriptor): OspfNetworkType {
    return this.interfaceConfig.get(iface.id)?.networkType ?? "broadcast";
  }

  costOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.cost ?? DEFAULT_OSPF_COST;
  }

  private priorityOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.priority ?? DEFAULT_OSPF_PRIORITY;
  }

  private helloIntervalOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.helloIntervalNs ?? DEFAULT_OSPF_HELLO_INTERVAL_NS;
  }

  private deadIntervalOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.deadIntervalNs ?? DEFAULT_OSPF_DEAD_INTERVAL_NS;
  }

  private descriptorOf(interfaceId: string): OspfInterfaceDescriptor | undefined {
    return this.host.ospfInterfaces().find((iface) => iface.id === interfaceId);
  }

  private runtimeOf(interfaceId: string): InterfaceRuntime {
    let runtime = this.interfaceRuntime.get(interfaceId);
    if (!runtime) {
      runtime = {
        id: interfaceId,
        designatedRouter: undefined,
        backupDesignatedRouter: undefined,
        electionSettled: false,
        upSinceNs: undefined,
      };
      this.interfaceRuntime.set(interfaceId, runtime);
    }
    return runtime;
  }

  // --- hello --------------------------------------------------------------

  private sendHellos(): void {
    const routerId = this.activeRouterId!;
    for (const iface of this.enabledInterfaces()) {
      if (!iface.operationalUp) continue;
      // A passive interface advertises its network but never says hello.
      if (this.isPassive(iface)) continue;
      const runtime = this.runtimeOf(iface.id);
      const packet: OspfHelloPacket = {
        kind: "ospf",
        type: "hello",
        routerId,
        areaId: OSPF_BACKBONE_AREA,
        sourceAddress: iface.address!,
        networkMask: intToIp(iface.maskInt),
        helloIntervalNs: this.helloIntervalOf(iface.id),
        deadIntervalNs: this.deadIntervalOf(iface.id),
        priority: this.priorityOf(iface.id),
        networkType: this.networkTypeOf(iface),
        designatedRouter: runtime.designatedRouter,
        backupDesignatedRouter: runtime.backupDesignatedRouter,
        neighbors: this.neighborsOn(iface.id).map((neighbor) => neighbor.routerId),
      };
      this.charge("ospfEvents");
      this.trace("ospf-hello-sent", {
        interface: iface.id,
        routerId,
        neighbors: packet.neighbors.length,
        designatedRouter: runtime.designatedRouter ?? null,
      });
      this.host.ospfSend(iface.id, OSPF_ALL_ROUTERS, packet);
    }
  }

  private neighborsOn(interfaceId: string): NeighborRuntime[] {
    return [...this.neighbors.values()]
      .filter((neighbor) => neighbor.interfaceId === interfaceId)
      .sort((a, b) => ipToInt(a.routerId) - ipToInt(b.routerId));
  }

  // --- packet reception ---------------------------------------------------

  onPacket(packet: OspfPacket, interfaceId: string, sourceAddress: Ipv4): void {
    if (!this.running) return;
    const routerId = this.selectRouterId();
    if (routerId === undefined) return;
    const iface = this.descriptorOf(interfaceId);
    if (!iface || !this.interfaceEnabled(iface) || !iface.operationalUp) return;
    if (this.isPassive(iface)) return;
    if (packet.routerId === routerId) {
      this.reject(interfaceId, packet.routerId, "duplicate router id on the segment");
      return;
    }
    this.charge("ospfEvents");
    if (packet.type === "hello") this.onHello(packet, iface, sourceAddress);
    else if (packet.type === "dbd") this.onDatabaseDescription(packet, interfaceId);
    else if (packet.type === "lsr") this.onLinkStateRequest(packet, interfaceId);
    else if (packet.type === "lsu") this.onLinkStateUpdate(packet, interfaceId);
    else this.onLinkStateAck(packet, interfaceId);
  }

  private onHello(packet: OspfHelloPacket, iface: OspfInterfaceDescriptor, sourceAddress: Ipv4): void {
    this.trace("ospf-hello-received", {
      interface: iface.id,
      neighborRouterId: packet.routerId,
      priority: packet.priority,
      designatedRouter: packet.designatedRouter ?? null,
    });
    const mismatch = this.helloMismatch(packet, iface);
    if (mismatch) {
      this.reject(iface.id, packet.routerId, mismatch);
      return;
    }
    const key = neighborKey(iface.id, packet.routerId);
    const engine = this.engine;
    let neighbor = this.neighbors.get(key);
    if (!neighbor) {
      enforceStructuralLimit("maximumOspfNeighborsPerDevice", this.neighbors.size + 1);
      neighbor = {
        routerId: packet.routerId,
        address: sourceAddress,
        interfaceId: iface.id,
        priority: packet.priority,
        state: "down",
        designatedRouter: packet.designatedRouter,
        backupDesignatedRouter: packet.backupDesignatedRouter,
        lastHelloAtNs: engine.now(),
        deadIntervalNs: packet.deadIntervalNs,
        master: false,
        ddSequence: 0,
        pendingRequests: [],
        unacknowledged: new Map(),
        rejectionReason: undefined,
      };
      this.neighbors.set(key, neighbor);
      this.setNeighborState(neighbor, "init", "hello received");
    } else {
      neighbor.address = sourceAddress;
      neighbor.priority = packet.priority;
      neighbor.designatedRouter = packet.designatedRouter;
      neighbor.backupDesignatedRouter = packet.backupDesignatedRouter;
      neighbor.lastHelloAtNs = engine.now();
      neighbor.deadIntervalNs = packet.deadIntervalNs;
      neighbor.rejectionReason = undefined;
      if (neighbor.state === "down") this.setNeighborState(neighbor, "init", "hello received");
    }
    // Bidirectional communication: the neighbour listed us in its hello.
    if (packet.neighbors.includes(this.activeRouterId!)) {
      if (neighbor.state === "init") {
        this.setNeighborState(neighbor, "two-way", "two-way received");
        this.electDesignatedRouters();
        if (this.shouldFormAdjacency(neighbor)) this.startExchange(neighbor);
      }
    } else if (neighbor.state !== "init" && neighbor.state !== "down") {
      this.setNeighborState(neighbor, "init", "one-way hello");
    }
  }

  /**
   * A neighbour is refused when any of the parameters that must agree differ.
   * There is no authentication in this release, so it is never considered.
   */
  private helloMismatch(packet: OspfHelloPacket, iface: OspfInterfaceDescriptor): string | undefined {
    if (packet.areaId !== OSPF_BACKBONE_AREA) return `area mismatch (${packet.areaId} != ${OSPF_BACKBONE_AREA})`;
    if (packet.helloIntervalNs !== this.helloIntervalOf(iface.id)) {
      return `hello interval mismatch (${packet.helloIntervalNs} != ${this.helloIntervalOf(iface.id)})`;
    }
    if (packet.deadIntervalNs !== this.deadIntervalOf(iface.id)) {
      return `dead interval mismatch (${packet.deadIntervalNs} != ${this.deadIntervalOf(iface.id)})`;
    }
    if (maskToInt(packet.networkMask) !== iface.maskInt) {
      return `subnet mask mismatch (${packet.networkMask} != ${intToIp(iface.maskInt)})`;
    }
    if (packet.networkType !== this.networkTypeOf(iface)) {
      return `network type mismatch (${packet.networkType} != ${this.networkTypeOf(iface)})`;
    }
    return undefined;
  }

  private reject(interfaceId: string, neighborRouterId: Ipv4, reason: string): void {
    const message = `${interfaceId}: adjacency with ${neighborRouterId} rejected — ${reason}`;
    if (!this.problems.has(message)) {
      this.problems.add(message);
      this.trace("ospf-adjacency-rejected", { interface: interfaceId, neighborRouterId, reason });
    }
    const key = neighborKey(interfaceId, neighborRouterId);
    const neighbor = this.neighbors.get(key);
    if (neighbor) {
      this.neighbors.delete(key);
      this.traceNeighborState(neighbor, "down", reason);
    }
  }

  /**
   * The dead interval is evaluated lazily, like the forwarding database and the
   * discovery tables: a neighbour is declared down the first time the process
   * runs or is inspected after its dead interval has passed. A router whose
   * peer stopped answering while the local link stayed up therefore keeps the
   * adjacency until the dead timer really has expired in virtual time — and
   * advancing the clock past it does drop the neighbour, without a scheduled
   * event that would keep a bounded Auto run alive for ever.
   */
  private expireNeighbors(): boolean {
    const engine = this.engineOrUndefined();
    if (!engine) return false;
    const now = engine.now();
    let expired = false;
    for (const [key, neighbor] of [...this.neighbors]) {
      if (now - neighbor.lastHelloAtNs < neighbor.deadIntervalNs) continue;
      this.neighbors.delete(key);
      this.traceNeighborState(neighbor, "down", "dead interval expired");
      const runtime = this.runtimeOf(neighbor.interfaceId);
      runtime.electionSettled = false;
      expired = true;
    }
    return expired;
  }

  /**
   * Inspection entry point: age out dead neighbours, then recompute.
   *
   * The recomputation is not deferred here. Nothing runs the engine between
   * this and the answer the caller is about to read, so a reader always sees a
   * tree that matches the database it is shown.
   */
  private refreshBeforeInspection(): void {
    if (!this.running || this.activeRouterId === undefined) return;
    if (this.expireNeighbors()) {
      this.electDesignatedRouters();
      this.originateLsas();
      this.requestSpf("neighbour aged out during inspection");
      this.arm();
    }
    this.flushPendingSpf();
  }

  // --- DR / BDR election --------------------------------------------------

  /**
   * The wait timer. An interface does not elect anybody until it has been up
   * long enough for every neighbour on the segment to reach 2-Way, so the
   * result depends on the configured priorities and router ids rather than on
   * whichever hello happened to arrive first.
   */
  private waitIntervalOf(interfaceId: string): number {
    return 2 * this.helloIntervalOf(interfaceId);
  }

  private isWaiting(iface: OspfInterfaceDescriptor): boolean {
    const runtime = this.interfaceRuntime.get(iface.id);
    if (runtime?.upSinceNs === undefined) return true;
    return this.engine.now() - runtime.upSinceNs < this.waitIntervalOf(iface.id);
  }

  private electDesignatedRouters(): void {
    for (const iface of this.enabledInterfaces()) {
      const runtime = this.runtimeOf(iface.id);
      if (!iface.operationalUp || this.isPassive(iface) || this.networkTypeOf(iface) === "point-to-point") {
        runtime.designatedRouter = undefined;
        runtime.backupDesignatedRouter = undefined;
        runtime.upSinceNs = iface.operationalUp ? runtime.upSinceNs ?? this.engine.now() : undefined;
        continue;
      }
      if (runtime.upSinceNs === undefined) runtime.upSinceNs = this.engine.now();
      if (this.isWaiting(iface)) continue;
      // Non-preemptive: once elected, the DR keeps the role until it goes away.
      if (runtime.electionSettled
        && runtime.designatedRouter !== undefined
        && this.candidatesOn(iface).some((candidate) => candidate.address === runtime.designatedRouter)) {
        // The DR stands, but the backup slot still tracks the segment.
        const remaining = this.eligibleCandidates(iface)
          .filter((candidate) => candidate.address !== runtime.designatedRouter);
        runtime.backupDesignatedRouter = remaining[0]?.address;
        continue;
      }
      const candidates = this.eligibleCandidates(iface);
      const designated = candidates[0];
      const backup = candidates[1];
      const changedDr = runtime.designatedRouter !== designated?.address;
      const changedBdr = runtime.backupDesignatedRouter !== backup?.address;
      runtime.designatedRouter = designated?.address;
      runtime.backupDesignatedRouter = backup?.address;
      runtime.electionSettled = designated !== undefined;
      if (changedDr && designated) {
        this.trace("ospf-dr-elected", {
          interface: iface.id,
          designatedRouter: designated.address,
          routerId: designated.routerId,
          priority: designated.priority,
        });
      }
      if (changedBdr && backup) {
        this.trace("ospf-bdr-elected", {
          interface: iface.id,
          backupDesignatedRouter: backup.address,
          routerId: backup.routerId,
          priority: backup.priority,
        });
      }
    }
  }

  /** Election candidates, best first. Priority 0 never takes part. */
  private eligibleCandidates(iface: OspfInterfaceDescriptor): Array<{
    routerId: Ipv4;
    address: Ipv4;
    priority: number;
  }> {
    return sortOspfElectionCandidates(this.candidatesOn(iface));
  }

  private candidatesOn(iface: OspfInterfaceDescriptor): Array<{
    routerId: Ipv4;
    address: Ipv4;
    priority: number;
  }> {
    const local = {
      routerId: this.activeRouterId!,
      address: iface.address!,
      priority: this.priorityOf(iface.id),
    };
    const remote = this.neighborsOn(iface.id)
      .filter((neighbor) => neighbor.state !== "down" && neighbor.state !== "init")
      .map((neighbor) => ({ routerId: neighbor.routerId, address: neighbor.address, priority: neighbor.priority }));
    return [local, ...remote];
  }

  private isDesignatedRouterOn(interfaceId: string): boolean {
    const iface = this.descriptorOf(interfaceId);
    const runtime = this.interfaceRuntime.get(interfaceId);
    return iface?.address !== undefined && runtime?.designatedRouter === iface.address;
  }

  /**
   * On a point-to-point link both ends become fully adjacent. On a broadcast
   * segment only the DR and BDR do; every other pair stays at 2-Way.
   */
  private shouldFormAdjacency(neighbor: NeighborRuntime): boolean {
    const iface = this.descriptorOf(neighbor.interfaceId);
    if (!iface) return false;
    if (this.networkTypeOf(iface) === "point-to-point") return true;
    // While the wait timer runs nobody is adjacent yet; the tick that ends the
    // wait promotes every 2-Way neighbour that the election makes adjacent.
    if (this.isWaiting(iface)) return false;
    const runtime = this.runtimeOf(neighbor.interfaceId);
    if (runtime.designatedRouter === undefined) return true;
    const localIsDrOrBdr = runtime.designatedRouter === iface.address
      || runtime.backupDesignatedRouter === iface.address;
    const neighborIsDrOrBdr = runtime.designatedRouter === neighbor.address
      || runtime.backupDesignatedRouter === neighbor.address;
    return localIsDrOrBdr || neighborIsDrOrBdr;
  }

  // --- database exchange --------------------------------------------------

  private startExchange(neighbor: NeighborRuntime): void {
    this.setNeighborState(neighbor, "exstart", "adjacency required");
    // Deterministic master/slave: the higher router id drives the exchange.
    neighbor.master = compareOspfRouterIds(this.activeRouterId!, neighbor.routerId) > 0;
    neighbor.ddSequence++;
    this.sendDatabaseDescription(neighbor, true);
  }

  private sendDatabaseDescription(neighbor: NeighborRuntime, init: boolean): void {
    const iface = this.descriptorOf(neighbor.interfaceId);
    if (!iface?.address) return;
    const packet: OspfDatabaseDescriptionPacket = {
      kind: "ospf",
      type: "dbd",
      routerId: this.activeRouterId!,
      areaId: OSPF_BACKBONE_AREA,
      sourceAddress: iface.address,
      sequence: neighbor.ddSequence,
      init,
      more: false,
      master: neighbor.master,
      headers: this.sortedLsas().map(lsaHeaderOf),
    };
    this.charge("ospfEvents");
    this.host.ospfSend(neighbor.interfaceId, neighbor.address, packet);
  }

  private onDatabaseDescription(packet: OspfDatabaseDescriptionPacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    if (!neighbor) return;
    if (neighbor.state === "two-way" || neighbor.state === "init") {
      this.setNeighborState(neighbor, "exstart", "database description received");
      neighbor.master = compareOspfRouterIds(this.activeRouterId!, packet.routerId) > 0;
    }
    if (neighbor.state === "exstart") {
      this.setNeighborState(neighbor, "exchange", "database description exchange");
      if (packet.init) {
        neighbor.ddSequence = packet.sequence;
        this.sendDatabaseDescription(neighbor, false);
      }
    }
    const missing = packet.headers.filter((header) => this.isNewer(header));
    neighbor.pendingRequests = missing.map((header) =>
      lsaKey(header.type, header.linkStateId, header.advertisingRouter));
    if (missing.length === 0) {
      this.setNeighborState(neighbor, "full", "databases already synchronized");
      this.arm();
      return;
    }
    this.setNeighborState(neighbor, "loading", "requesting missing link states");
    const request: OspfLinkStateRequestPacket = {
      kind: "ospf",
      type: "lsr",
      routerId: this.activeRouterId!,
      areaId: OSPF_BACKBONE_AREA,
      sourceAddress: this.descriptorOf(interfaceId)!.address!,
      requests: missing.map((header) => ({
        type: header.type,
        linkStateId: header.linkStateId,
        advertisingRouter: header.advertisingRouter,
      })),
    };
    this.charge("ospfEvents");
    this.host.ospfSend(interfaceId, neighbor.address, request);
  }

  private onLinkStateRequest(packet: OspfLinkStateRequestPacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    if (!neighbor) return;
    const lsas = packet.requests
      .map((request) => this.lsdb.get(lsaKey(request.type, request.linkStateId, request.advertisingRouter)))
      .filter((lsa): lsa is OspfLsa => lsa !== undefined);
    if (lsas.length === 0) return;
    // The reply goes on the retransmission list like any other offer. RFC 2328
    // relies on the requester repeating its Link State Request instead; this
    // model has no request timer, so a tail-dropped reply would leave a
    // neighbour stuck in Loading with no way back.
    this.offerLsas(neighbor, lsas);
  }

  private onLinkStateUpdate(packet: OspfLinkStateUpdatePacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    let installed = 0;
    for (const lsa of packet.lsas) {
      // Implied acknowledgement: the neighbour has just sent us back the very
      // instance we are waiting for it to confirm, so it evidently holds it.
      if (neighbor) this.acknowledgeInstance(neighbor, lsaHeaderOf(lsa));
      if (!this.installLsa(lsa, interfaceId)) continue;
      installed++;
    }
    if (neighbor) {
      // A duplicate must still be acknowledged — that is what makes the sender's
      // retransmission stop — while installing nothing, so it mutates no
      // database and starts no SPF walk.
      const acknowledgement: OspfLinkStateAckPacket = {
        kind: "ospf",
        type: "lsack",
        routerId: this.activeRouterId!,
        areaId: OSPF_BACKBONE_AREA,
        sourceAddress: this.descriptorOf(interfaceId)!.address!,
        headers: packet.lsas.map(lsaHeaderOf),
      };
      this.charge("ospfEvents");
      this.host.ospfSend(interfaceId, neighbor.address, acknowledgement);
      if (neighbor.state === "loading" || neighbor.state === "exchange") {
        neighbor.pendingRequests = [];
        this.setNeighborState(neighbor, "full", "link state database synchronized");
      }
    }
    if (installed > 0) {
      this.trace("ospf-lsdb-changed", { interface: interfaceId, installed, size: this.lsdb.size });
      this.floodLsas(packet.lsas.filter((lsa) => this.lsdb.get(lsaKeyOf(lsa)) === lsa), interfaceId);
      this.requestSpf("link state database changed");
      this.arm();
    }
  }

  private onLinkStateAck(packet: OspfLinkStateAckPacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    if (!neighbor) return;
    let cleared = 0;
    for (const header of packet.headers) {
      if (this.acknowledgeInstance(neighbor, header)) cleared++;
    }
    this.trace("ospf-lsa-acknowledged", {
      interface: interfaceId,
      neighborRouterId: packet.routerId,
      count: packet.headers.length,
      cleared,
      outstanding: neighbor.unacknowledged.size,
    });
    if (neighbor.state === "loading" || neighbor.state === "exchange") {
      this.setNeighborState(neighbor, "full", "link state database synchronized");
    }
  }

  /**
   * Clear exactly the acknowledged instance from one neighbour's list.
   *
   * Matching is on the whole instance identity, never on the LSA key alone: an
   * acknowledgement that names an older sequence — or the same sequence with a
   * different body — must leave a newer advertisement outstanding, and an
   * acknowledgement is never allowed to mean "the neighbour is up to date".
   */
  private acknowledgeInstance(neighbor: NeighborRuntime, header: OspfLsaHeader): boolean {
    const key = lsaKey(header.type, header.linkStateId, header.advertisingRouter);
    const pending = neighbor.unacknowledged.get(key);
    if (pending === undefined || !isSameLsaInstance(pending.header, header)) return false;
    neighbor.unacknowledged.delete(key);
    this.floodMetrics.acknowledgements++;
    return true;
  }

  private sendLinkStateUpdate(
    interfaceId: string,
    destination: Ipv4,
    lsas: readonly OspfLsa[],
    reason: "initial" | "retransmission" = "initial",
  ): void {
    const iface = this.descriptorOf(interfaceId);
    if (!iface?.address || lsas.length === 0) return;
    const packet: OspfLinkStateUpdatePacket = {
      kind: "ospf",
      type: "lsu",
      routerId: this.activeRouterId!,
      areaId: OSPF_BACKBONE_AREA,
      sourceAddress: iface.address,
      lsas: [...lsas],
    };
    this.charge("lsaFloods", lsas.length);
    this.charge("ospfEvents");
    if (reason === "retransmission") this.floodMetrics.retransmittedUpdates++;
    else this.floodMetrics.initialUpdates++;
    this.trace(reason === "retransmission" ? "ospf-lsa-retransmitted" : "ospf-lsa-flooded", {
      interface: interfaceId,
      destination,
      count: lsas.length,
    });
    this.host.ospfSend(interfaceId, destination, packet);
  }

  /** Reliable, bounded flooding to every full adjacency except the source. */
  private floodLsas(lsas: readonly OspfLsa[], exceptInterfaceId?: string): void {
    if (lsas.length === 0) return;
    for (const neighbor of [...this.neighbors.values()].sort(byNeighborOrder)) {
      if (neighbor.state !== "full") continue;
      if (neighbor.interfaceId === exceptInterfaceId) continue;
      this.offerLsas(neighbor, lsas);
    }
  }

  /**
   * Offer advertisements to one neighbour and remember what it still owes us.
   *
   * Handing the packet to the interface is *not* delivery. It is queued behind
   * a finite egress queue that may tail-drop it, and the OSPF sender is never
   * told that happened — it finds out because no acknowledgement arrives. The
   * retransmission list is therefore written before the update is sent, and the
   * entry is what makes the loss recoverable.
   */
  private offerLsas(neighbor: NeighborRuntime, lsas: readonly OspfLsa[]): void {
    const due = lsas.filter((lsa) => this.admitToRetransmissionList(neighbor, lsa));
    if (due.length === 0) return;
    this.sendLinkStateUpdate(neighbor.interfaceId, neighbor.address, due);
    this.scheduleRetransmission();
  }

  /**
   * Put one instance on a neighbour's retransmission list, if it is not already
   * there, and report whether this update has to carry it.
   *
   * An instance that is already outstanding is deliberately *not* sent again
   * here: the retransmission timer owns it, and re-offering it on every flood
   * that mentions it is exactly the burst amplification a finite queue cannot
   * absorb. A newer instance replaces the stale entry and starts its own count,
   * so a re-originated advertisement is always delivered.
   */
  private admitToRetransmissionList(neighbor: NeighborRuntime, lsa: OspfLsa): boolean {
    const key = lsaKeyOf(lsa);
    const header = lsaHeaderOf(lsa);
    const pending = neighbor.unacknowledged.get(key);
    if (pending !== undefined && isSameLsaInstance(pending.header, header)) return false;
    const now = this.engine.now();
    neighbor.unacknowledged.set(key, {
      header,
      firstSentAtNs: now,
      lastSentAtNs: now,
      attempts: 1,
    });
    this.floodMetrics.offers++;
    return true;
  }

  // --- retransmission -----------------------------------------------------

  /**
   * Arm the retransmission timer, but only while something is outstanding.
   *
   * Like the IPsec lifetimes, this deliberately keeps **no periodic timer**: a
   * repeating event would leave the deterministic queue permanently non-empty
   * and `runUntilIdle()` would never return. One event exists while at least one
   * instance is unacknowledged, and the walk only re-arms itself while entries
   * remain, so a converged area schedules nothing at all.
   */
  private scheduleRetransmission(): void {
    if (this.retransmissionScheduled) return;
    const engine = this.engineOrUndefined();
    if (!engine || !this.hasOutstandingRetransmissions()) return;
    this.retransmissionScheduled = true;
    engine.scheduleIn(OSPF_RETRANSMISSION_INTERVAL_NS, () => {
      this.retransmissionScheduled = false;
      if (!this.running) return;
      this.retransmitUnacknowledged();
    });
  }

  private hasOutstandingRetransmissions(): boolean {
    for (const neighbor of this.neighbors.values()) {
      if (neighbor.unacknowledged.size > 0) return true;
    }
    return false;
  }

  /**
   * Offer every still-unacknowledged instance once more.
   *
   * The walk is ordered by neighbour router id, then interface, then LSA key —
   * and there is one entry per key, holding the instance currently in flight —
   * so two runs of the same lab emit the same packets in the same order.
   * Everything one neighbour is still owed travels in a single Link State
   * Update, which is what keeps a recovery from repeating the burst that caused
   * the loss.
   */
  private retransmitUnacknowledged(): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    const now = engine.now();
    for (const neighbor of [...this.neighbors.values()].sort(byRetransmissionOrder)) {
      if (neighbor.unacknowledged.size === 0) continue;
      const due: OspfLsa[] = [];
      for (const key of [...neighbor.unacknowledged.keys()].sort(compareRetransmissionKeys)) {
        const pending = neighbor.unacknowledged.get(key)!;
        const current = this.lsdb.get(key);
        // The instance is gone, or a newer one has replaced it and carries its
        // own entry: this one is no longer correctness state worth a packet.
        if (current === undefined || !isSameLsaInstance(pending.header, lsaHeaderOf(current))) {
          neighbor.unacknowledged.delete(key);
          continue;
        }
        if (pending.attempts > MAXIMUM_LSA_RETRANSMISSIONS) {
          neighbor.unacknowledged.delete(key);
          this.floodMetrics.abandoned++;
          this.reportUnacknowledged(neighbor, pending);
          continue;
        }
        pending.attempts++;
        pending.lastSentAtNs = now;
        this.floodMetrics.retransmissions++;
        due.push(current);
      }
      if (due.length > 0) {
        this.sendLinkStateUpdate(neighbor.interfaceId, neighbor.address, due, "retransmission");
      }
    }
    this.scheduleRetransmission();
  }

  /**
   * A neighbour that never acknowledged is reported, never quietly forgotten.
   *
   * The advertisement itself stays in the database and the adjacency stays up —
   * exactly as on a real router, where only the dead interval tears an adjacency
   * down — so the lab shows an operator-visible problem rather than a silently
   * divergent area.
   */
  private reportUnacknowledged(neighbor: NeighborRuntime, pending: UnacknowledgedLsa): void {
    const { type, linkStateId, advertisingRouter, sequence } = pending.header;
    const message = `${neighbor.interfaceId}: ${type} LSA ${linkStateId} from ${advertisingRouter}`
      + ` was not acknowledged by ${neighbor.routerId} after ${MAXIMUM_LSA_RETRANSMISSIONS} retransmissions`;
    this.problems.add(message);
    this.trace("ospf-lsa-retransmission-exhausted", {
      interface: neighbor.interfaceId,
      neighborRouterId: neighbor.routerId,
      type,
      linkStateId,
      advertisingRouter,
      sequence,
      attempts: pending.attempts,
    });
  }

  /** Outstanding retransmission-list entries, in the walk's own stable order. */
  retransmissionEntries(): OspfRetransmissionEntry[] {
    const entries: OspfRetransmissionEntry[] = [];
    for (const neighbor of [...this.neighbors.values()].sort(byRetransmissionOrder)) {
      for (const key of [...neighbor.unacknowledged.keys()].sort(compareRetransmissionKeys)) {
        const pending = neighbor.unacknowledged.get(key)!;
        entries.push({
          neighborRouterId: neighbor.routerId,
          interfaceId: neighbor.interfaceId,
          type: pending.header.type,
          linkStateId: pending.header.linkStateId,
          advertisingRouter: pending.header.advertisingRouter,
          sequence: pending.header.sequence,
          checksum: pending.header.checksum,
          attempts: pending.attempts,
          firstSentAtNs: pending.firstSentAtNs,
          lastSentAtNs: pending.lastSentAtNs,
        });
      }
    }
    return entries;
  }

  /** How reliable flooding behaved. Runtime only; never serialized. */
  floodCounters(): OspfFloodCounters {
    return { ...this.floodMetrics, outstanding: this.retransmissionEntries().length };
  }

  /** True while a retransmission event is on the deterministic queue. */
  get retransmissionTimerArmed(): boolean {
    return this.retransmissionScheduled;
  }

  private isNewer(header: OspfLsaHeader): boolean {
    const existing = this.lsdb.get(lsaKey(header.type, header.linkStateId, header.advertisingRouter));
    if (!existing) return true;
    if (header.sequence !== existing.sequence) return header.sequence > existing.sequence;
    return header.checksum !== existing.checksum && header.originatedAtNs > existing.originatedAtNs;
  }

  private installLsa(lsa: OspfLsa, interfaceId: string): boolean {
    if (lsa.advertisingRouter === this.activeRouterId) return false; // never learn our own
    if (!this.isNewer(lsaHeaderOf(lsa))) return false; // duplicate suppression
    enforceStructuralLimit("maximumLsasPerLab", this.lsdb.size + 1);
    this.lsdb.set(lsaKeyOf(lsa), lsa);
    this.trace("ospf-lsa-flooded", {
      interface: interfaceId,
      type: lsa.type,
      linkStateId: lsa.linkStateId,
      advertisingRouter: lsa.advertisingRouter,
      sequence: lsa.sequence,
      received: true,
    });
    return true;
  }

  // --- LSA origination ----------------------------------------------------

  private originateLsas(): void {
    const routerId = this.activeRouterId!;
    const links: OspfRouterLsaLink[] = [];
    for (const iface of this.enabledInterfaces()) {
      if (!iface.operationalUp) continue;
      const network = intToIp((ipToInt(iface.address!) & iface.maskInt) >>> 0);
      if (this.isPassive(iface)) {
        links.push({ type: "stub", linkId: network, linkData: intToIp(iface.maskInt), metric: this.costOf(iface.id) });
        continue;
      }
      const adjacent = this.neighborsOn(iface.id).filter((neighbor) => neighbor.state === "full");
      if (this.networkTypeOf(iface) === "point-to-point") {
        for (const neighbor of adjacent) {
          links.push({
            type: "point-to-point",
            linkId: neighbor.routerId,
            linkData: iface.address!,
            metric: this.costOf(iface.id),
          });
        }
        links.push({ type: "stub", linkId: network, linkData: intToIp(iface.maskInt), metric: this.costOf(iface.id) });
        continue;
      }
      const runtime = this.runtimeOf(iface.id);
      if (runtime.designatedRouter !== undefined && adjacent.length > 0) {
        links.push({
          type: "transit",
          linkId: runtime.designatedRouter,
          linkData: iface.address!,
          metric: this.costOf(iface.id),
        });
      } else {
        links.push({ type: "stub", linkId: network, linkData: intToIp(iface.maskInt), metric: this.costOf(iface.id) });
      }
    }
    links.sort((a, b) => a.type.localeCompare(b.type) || a.linkId.localeCompare(b.linkId)
      || a.linkData.localeCompare(b.linkData));

    this.replaceLocalLsa({
      type: "router",
      linkStateId: routerId,
      advertisingRouter: routerId,
      links,
    });

    // The designated router describes the transit segment with a Network LSA.
    for (const iface of this.enabledInterfaces()) {
      if (!iface.operationalUp || this.isPassive(iface)) continue;
      if (this.networkTypeOf(iface) === "point-to-point") continue;
      if (!this.isDesignatedRouterOn(iface.id)) continue;
      const attached = [routerId, ...this.neighborsOn(iface.id)
        .filter((neighbor) => neighbor.state === "full")
        .map((neighbor) => neighbor.routerId)]
        .sort((a, b) => ipToInt(a) - ipToInt(b));
      if (attached.length < 2) continue;
      this.replaceLocalLsa({
        type: "network",
        linkStateId: iface.address!,
        advertisingRouter: routerId,
        networkMask: intToIp(iface.maskInt),
        attachedRouters: attached,
      });
    }
  }

  private replaceLocalLsa(
    body:
      | { type: "router"; linkStateId: Ipv4; advertisingRouter: Ipv4; links: OspfRouterLsaLink[] }
      | {
        type: "network";
        linkStateId: Ipv4;
        advertisingRouter: Ipv4;
        networkMask: Ipv4;
        attachedRouters: Ipv4[];
      },
  ): void {
    const key = lsaKey(body.type, body.linkStateId, body.advertisingRouter);
    const existing = this.lsdb.get(key);
    // The checksum only covers the body, so an unchanged LSA is not re-issued
    // and neighbours are never woken up for nothing.
    const candidateChecksum = lsaChecksum({
      ...body,
      sequence: existing?.sequence ?? this.sequence,
      originatedAtNs: existing?.originatedAtNs ?? 0,
    } as OspfLsaChecksumInput);
    const bodyChecksum = existing === undefined
      ? undefined
      : lsaChecksum({ ...existing, sequence: existing.sequence } as OspfLsaChecksumInput);
    if (existing && bodyChecksum === candidateChecksum) return; // nothing changed
    const sequence = existing ? existing.sequence + 1 : this.sequence++;
    const draft = { ...body, sequence, originatedAtNs: this.engine.now() } as OspfLsaChecksumInput;
    const finalLsa = { ...draft, checksum: lsaChecksum(draft) } as OspfLsa;
    enforceStructuralLimit("maximumLsasPerLab", this.lsdb.size + (existing ? 0 : 1));
    this.lsdb.set(key, finalLsa);
    this.trace("ospf-lsa-originated", {
      type: finalLsa.type,
      linkStateId: finalLsa.linkStateId,
      advertisingRouter: finalLsa.advertisingRouter,
      sequence: finalLsa.sequence,
      links: finalLsa.type === "router" ? finalLsa.links.length : finalLsa.attachedRouters.length,
    });
    this.floodLsas([finalLsa]);
    this.arm();
  }

  /**
   * Hand a neighbour the whole database the moment the adjacency reaches Full.
   *
   * The database description exchange runs *before* Full, so every LSA this
   * router originates *because of* that adjacency — its own Router LSA and the
   * segment's Network LSA — is created afterwards, and ordinary flooding skips
   * a neighbour that is still synchronizing. On a router that brings several
   * segments up in one activity window, each later neighbour therefore missed
   * the Network LSAs of the earlier ones for good, and SPF could not expand a
   * transit segment whose Network LSA it did not hold.
   *
   * One bounded update per Full transition closes that window. The receiver's
   * duplicate suppression discards everything it already holds, so nothing is
   * re-flooded and the exchange terminates. It travels through the ordinary
   * retransmission list, because this single packet carries the whole database
   * and losing it to a full egress queue is precisely what must be recoverable.
   */
  private synchronizeDatabase(neighbor: NeighborRuntime): void {
    this.offerLsas(neighbor, this.sortedLsas());
  }

  private sortedLsas(): OspfLsa[] {
    return [...this.lsdb.values()].sort((a, b) =>
      a.type.localeCompare(b.type)
      || ipToInt(a.linkStateId) - ipToInt(b.linkStateId)
      || ipToInt(a.advertisingRouter) - ipToInt(b.advertisingRouter));
  }

  // --- SPF scheduling -----------------------------------------------------

  /**
   * The single entry point for "the topology may have moved, look again".
   *
   * Every place that used to start a walk — a tick, an installed link-state
   * update, an adjacency reaching Full or being lost, a neighbour ageing out —
   * asks here instead, so the scheduling decision lives in one function rather
   * than as flags spread through the flooding code.
   *
   * The first request schedules one deterministic virtual event. Every further
   * request that arrives before it fires only advances the requested revision;
   * it never creates a second event. That is what turns a flood wave, which
   * delivers the whole database one update at a time, into a single
   * computation.
   */
  private requestSpf(reason: string): void {
    if (!this.running || this.activeRouterId === undefined) return;
    this.spfRequestedRevision++;
    this.spfMetrics.requests++;
    if (this.spfScheduled) {
      this.spfMetrics.coalescedRequests++;
      return;
    }
    this.scheduleSpf(reason);
  }

  private scheduleSpf(reason: string): void {
    const engine = this.engineOrUndefined();
    if (!engine) return; // no clock yet: the next arm() requests again
    this.spfScheduled = true;
    this.spfMetrics.scheduledEvents++;
    this.trace("ospf-spf-scheduled", {
      reason,
      revision: this.spfRequestedRevision,
      dueAtNs: engine.now() + OSPF_SPF_COALESCE_DELAY_NS,
    });
    engine.scheduleIn(OSPF_SPF_COALESCE_DELAY_NS, () => {
      this.spfScheduled = false;
      if (!this.running) return;
      // Snapshot first: anything that changes while the walk runs must still be
      // seen as outstanding afterwards, which is how a late change stops being
      // lost the way it was before M10.17.1.
      const observed = this.spfRequestedRevision;
      this.executeSpf();
      this.spfCompletedRevision = observed;
      if (this.spfRequestedRevision !== this.spfCompletedRevision) {
        this.scheduleSpf("state changed while spf was running");
      }
    });
  }

  /**
   * Bring the tree up to date now, because somebody is about to read it.
   *
   * Inspection and forwarding must never see a routing table that a pending
   * event has not caught up with yet. An event already on the queue is left
   * alone — it will find an unchanged fingerprint and skip.
   */
  private flushPendingSpf(): void {
    if (this.spfExecuting) return;
    if (this.spfRequestedRevision === this.spfCompletedRevision) return;
    const observed = this.spfRequestedRevision;
    this.executeSpf();
    this.spfCompletedRevision = observed;
  }

  /** How the schedule behaved. Runtime only; never serialized. */
  spfCounters(): OspfSpfCounters {
    return { ...this.spfMetrics };
  }

  // --- SPF ----------------------------------------------------------------

  /**
   * Everything the SPF walk reads, in one canonical string.
   *
   * SPF is a pure function of the database plus the local next-hop inputs, so a
   * tick that changed none of them can only rebuild the identical tree. The
   * fingerprint is derived from the very values the walk reads rather than from
   * a dirty flag somebody has to remember to set — which is what stops a skipped
   * run from ever hiding a real change.
   */
  private spfInputFingerprint(): string {
    const parts: string[] = [this.activeRouterId ?? ""];
    for (const lsa of this.sortedLsas()) {
      parts.push(`l|${lsa.type}|${lsa.linkStateId}|${lsa.advertisingRouter}|${lsa.sequence}|${lsa.checksum}`);
    }
    for (const iface of this.enabledInterfaces()) {
      const runtime = this.interfaceRuntime.get(iface.id);
      parts.push(`i|${iface.id}|${iface.address ?? ""}|${iface.operationalUp ? 1 : 0}|`
        + `${runtime?.designatedRouter ?? ""}`);
      for (const neighbor of this.neighborsOn(iface.id)) {
        parts.push(`n|${neighbor.routerId}|${neighbor.address}|${neighbor.state}`);
      }
    }
    return parts.join("\n");
  }

  /**
   * Dijkstra over the link-state database. Candidates are always taken in a
   * deterministic order — total cost, then advertising router id, then the
   * stable interface identifier — so the same LSDB always yields the same tree.
   *
   * Two walks are skipped rather than charged.
   *
   * A run whose inputs are unchanged would install the same routes; the guard
   * is a fingerprint of the values the walk reads rather than a dirty flag, so
   * it cannot hide a change.
   *
   * A database that holds nothing but this router's own advertisements
   * describes a tree of one vertex, so while the routing table is already empty
   * the walk can only produce the empty result again. That is a redundant
   * cold-start phase — every router goes through it before the wait timer lets
   * a first adjacency form — and not a suppressed change: the moment any other
   * router's advertisement arrives the fingerprint differs and the walk runs.
   */
  private executeSpf(): void {
    const routerId = this.activeRouterId;
    if (routerId === undefined) return;
    const inputs = this.spfInputFingerprint();
    if (inputs === this.lastSpfInputs) {
      this.spfMetrics.skippedUnchanged++;
      return;
    }
    if (this.routes.length === 0 && !this.hasRemoteLsa(routerId)) {
      this.lastSpfInputs = inputs;
      this.spfMetrics.skippedEmptyTopology++;
      return;
    }
    this.lastSpfInputs = inputs;
    this.spfExecuting = true;
    try {
      this.walkShortestPathTree(routerId);
    } finally {
      this.spfExecuting = false;
    }
  }

  private hasRemoteLsa(routerId: Ipv4): boolean {
    for (const lsa of this.lsdb.values()) {
      if (lsa.advertisingRouter !== routerId) return true;
    }
    return false;
  }

  private walkShortestPathTree(routerId: Ipv4): void {
    this.spfMetrics.executions++;
    this.charge("spfRuns");
    this.spfRuns++;
    this.lastSpfAtNs = this.engine.now();
    this.trace("ospf-spf-started", { routerId, lsaCount: this.lsdb.size });

    /**
     * The tree holds both kinds of vertex the database describes. A transit
     * segment is a vertex in its own right — that is how routers on the far
     * side of it are reached, and it is also the only place its own prefix can
     * come from.
     */
    interface Vertex {
      readonly kind: "router" | "network";
      /** Router id for a router; the designated router's address for a network. */
      readonly id: Ipv4;
      readonly cost: number;
      readonly nextHop: Ipv4 | undefined;
      readonly interfaceId: string | undefined;
    }
    const vertexKey = (kind: Vertex["kind"], id: Ipv4): string => `${kind}|${id}`;

    const routerLsas = new Map<Ipv4, OspfLsa>();
    const networkLsas = new Map<Ipv4, OspfLsa>();
    for (const lsa of this.sortedLsas()) {
      if (lsa.type === "router") routerLsas.set(lsa.linkStateId, lsa);
      else networkLsas.set(lsa.linkStateId, lsa);
    }
    const connectedNetworks = this.connectedNetworkInts();
    const settled = new Map<string, Vertex>();
    const candidates: Vertex[] = [
      { kind: "router", id: routerId, cost: 0, nextHop: undefined, interfaceId: undefined },
    ];

    while (candidates.length > 0) {
      candidates.sort((a, b) =>
        a.cost - b.cost
        || ipToInt(a.id) - ipToInt(b.id)
        || a.kind.localeCompare(b.kind)
        || (a.interfaceId ?? "").localeCompare(b.interfaceId ?? ""));
      const current = candidates.shift()!;
      const currentKey = vertexKey(current.kind, current.id);
      if (settled.has(currentKey)) continue;
      settled.set(currentKey, current);

      if (current.kind === "network") {
        // A network vertex costs nothing more to leave: the metric was already
        // paid by the router link that reached it.
        const lsa = networkLsas.get(current.id);
        if (!lsa || lsa.type !== "network") continue;
        for (const attached of lsa.attachedRouters) {
          if (settled.has(vertexKey("router", attached))) continue;
          const resolved = this.nextHopAcross(current.interfaceId, current.nextHop, attached);
          if (resolved.interfaceId === undefined) continue;
          candidates.push({ kind: "router", id: attached, cost: current.cost, ...resolved });
        }
        continue;
      }

      const lsa = routerLsas.get(current.id);
      if (!lsa || lsa.type !== "router") continue;
      for (const link of lsa.links) {
        if (link.type === "stub") continue;
        const kind = link.type === "point-to-point" ? "router" : "network";
        if (settled.has(vertexKey(kind, link.linkId))) continue;
        const local = current.id === routerId;
        const resolved = kind === "router"
          ? (local
            ? this.localNextHopFor(link, link.linkId)
            : { nextHop: current.nextHop, interfaceId: current.interfaceId })
          // A transit segment this router is attached to is reached directly:
          // it has no next hop, and each router behind it resolves its own.
          : (local
            ? { nextHop: undefined, interfaceId: this.localInterfaceAddressed(link.linkData) }
            : { nextHop: current.nextHop, interfaceId: current.interfaceId });
        if (resolved.interfaceId === undefined) continue;
        candidates.push({ kind, id: link.linkId, cost: current.cost + link.metric, ...resolved });
      }
    }

    const routes = new Map<string, OspfRoute>();
    /** Keep the cheapest, then the lexicographically smaller egress. */
    const offer = (network: Ipv4, maskInt: number, cost: number, vertex: Vertex): void => {
      if (vertex.interfaceId === undefined) return;
      // Anything we are directly connected to keeps its better distance.
      if (connectedNetworks.has(ipToInt(network))) return;
      const key = `${network}/${maskInt}`;
      const existing = routes.get(key);
      if (existing && (existing.cost < cost
        || (existing.cost === cost && existing.interfaceId.localeCompare(vertex.interfaceId) <= 0))) {
        return;
      }
      routes.set(key, { network, maskInt, nextHop: vertex.nextHop, interfaceId: vertex.interfaceId, cost });
    };

    // Settle order is by cost then identifier, so this is stable regardless of
    // when an advertisement arrived or which router won a designated election.
    const reached = [...settled.values()];
    for (const vertex of reached) {
      if (vertex.kind !== "router" || vertex.id === routerId) continue;
      const lsa = routerLsas.get(vertex.id);
      if (!lsa || lsa.type !== "router") continue;
      for (const link of lsa.links) {
        if (link.type !== "stub") continue;
        const maskInt = maskToInt(link.linkData);
        offer(intToIp((ipToInt(link.linkId) & maskInt) >>> 0), maskInt, vertex.cost + link.metric, vertex);
      }
    }

    /**
     * A reachable transit segment is a route to the *subnet*, never to the
     * designated router's own address. The prefix comes from the Network LSA:
     * its link-state id is the designated router's interface address and its
     * mask is the segment's, so 10.0.23.1 with 255.255.255.252 is 10.0.23.0/30.
     * Without this a segment between two remote routers took part in SPF and
     * was still missing from the routing table, because only Router LSA stub
     * links ever became routes and a broadcast segment is described by a
     * transit link instead.
     */
    for (const vertex of reached) {
      if (vertex.kind !== "network") continue;
      const lsa = networkLsas.get(vertex.id);
      if (!lsa || lsa.type !== "network") continue;
      const maskInt = maskToInt(lsa.networkMask);
      offer(intToIp((ipToInt(lsa.linkStateId) & maskInt) >>> 0), maskInt, vertex.cost, vertex);
    }

    const next = [...routes.values()].sort((a, b) => ipToInt(a.network) - ipToInt(b.network) || a.maskInt - b.maskInt);
    const changed = JSON.stringify(next) !== JSON.stringify(this.routes);
    const previous = this.routes;
    this.routes = next;
    this.trace("ospf-spf-completed", { routerId, routes: next.length, vertices: settled.size });
    if (!changed) return;
    for (const route of next) {
      if (previous.some((old) => old.network === route.network && old.maskInt === route.maskInt
        && old.nextHop === route.nextHop && old.cost === route.cost)) continue;
      this.trace("ospf-route-installed", {
        network: route.network,
        prefixLength: prefixLengthOf(route.maskInt),
        nextHop: route.nextHop ?? null,
        interface: route.interfaceId,
        cost: route.cost,
      });
    }
    for (const route of previous) {
      if (next.some((current) => current.network === route.network && current.maskInt === route.maskInt)) continue;
      this.trace("ospf-route-withdrawn", {
        network: route.network,
        prefixLength: prefixLengthOf(route.maskInt),
        cost: route.cost,
      });
    }
    this.host.ospfRoutesChanged();
  }

  /**
   * Networks this router is attached to itself, as integers.
   *
   * Taken from the live interfaces rather than from our own Router LSA, because
   * a transit segment appears there as a transit link and has no stub to read a
   * prefix from — which is exactly the case a directly attached transit route
   * must not compete with.
   */
  private connectedNetworkInts(): Set<number> {
    const networks = new Set<number>();
    for (const iface of this.enabledInterfaces()) {
      if (!iface.operationalUp || iface.address === undefined) continue;
      networks.add((ipToInt(iface.address) & iface.maskInt) >>> 0);
    }
    return networks;
  }

  /** The local interface that carries `address`, if this router owns it. */
  private localInterfaceAddressed(address: Ipv4): string | undefined {
    return this.enabledInterfaces().find((iface) => iface.address === address)?.id;
  }

  /**
   * The first hop towards a router attached to an already-reached segment.
   *
   * A segment further away inherits the hop that reached it. One we are
   * attached to has no hop yet, so each attached router resolves to its own
   * address on that segment — or, for a router we never exchanged hellos with,
   * to the designated router that describes it.
   */
  private nextHopAcross(
    interfaceId: string | undefined,
    inheritedNextHop: Ipv4 | undefined,
    attachedRouterId: Ipv4,
  ): { nextHop: Ipv4 | undefined; interfaceId: string | undefined } {
    if (interfaceId === undefined) return { nextHop: undefined, interfaceId: undefined };
    if (inheritedNextHop !== undefined) return { nextHop: inheritedNextHop, interfaceId };
    const neighbor = this.neighborsOn(interfaceId).find((candidate) => candidate.routerId === attachedRouterId);
    if (neighbor) return { nextHop: neighbor.address, interfaceId };
    const designated = this.interfaceRuntime.get(interfaceId)?.designatedRouter;
    return { nextHop: designated, interfaceId };
  }

  private localNextHopFor(
    link: OspfRouterLsaLink,
    neighborRouterId: Ipv4,
  ): { nextHop: Ipv4 | undefined; interfaceId: string | undefined } {
    for (const iface of this.enabledInterfaces()) {
      if (iface.address !== link.linkData) continue;
      const neighbor = this.neighborsOn(iface.id).find((candidate) => candidate.routerId === neighborRouterId);
      if (neighbor) return { nextHop: neighbor.address, interfaceId: iface.id };
      // A transit segment reached through the DR: the next hop is the DR itself.
      const runtime = this.runtimeOf(iface.id);
      if (runtime.designatedRouter !== undefined) {
        return { nextHop: runtime.designatedRouter, interfaceId: iface.id };
      }
    }
    return { nextHop: undefined, interfaceId: undefined };
  }

  // --- inspection ---------------------------------------------------------

  /** Routes OSPF currently offers to the routing table. */
  routeTable(): OspfRoute[] {
    // Forwarding reads this on every lookup, so a coalesced recomputation is
    // never allowed to leave the routing table behind the database.
    this.flushPendingSpf();
    return this.routes.map((route) => ({ ...route }));
  }

  overview(): OspfOverview {
    this.refreshBeforeInspection();
    return {
      processId: this.processId,
      running: this.running,
      routerId: this.activeRouterId,
      routerIdSource: this.routerIdSource,
      area: OSPF_BACKBONE_AREA,
      spfRuns: this.spfRuns,
      lastSpfAtNs: this.lastSpfAtNs,
      defaultCost: DEFAULT_OSPF_COST,
      lsaCount: this.lsdb.size,
      neighborCount: this.neighbors.size,
      problems: [...this.problems].sort(),
    };
  }

  neighborSummaries(): OspfNeighborSummary[] {
    this.refreshBeforeInspection();
    const now = this.engineOrUndefined()?.now() ?? 0;
    return [...this.neighbors.values()]
      .sort(byNeighborOrder)
      .map((neighbor): OspfNeighborSummary => {
        const runtime = this.interfaceRuntime.get(neighbor.interfaceId);
        const iface = this.descriptorOf(neighbor.interfaceId);
        const pointToPoint = iface !== undefined && this.networkTypeOf(iface) === "point-to-point";
        return {
          neighborRouterId: neighbor.routerId,
          priority: neighbor.priority,
          state: neighbor.state,
          address: neighbor.address,
          interfaceId: neighbor.interfaceId,
          role: pointToPoint
            ? "point-to-point"
            : runtime?.designatedRouter === neighbor.address
              ? "dr"
              : runtime?.backupDesignatedRouter === neighbor.address
                ? "bdr"
                : "drother",
          deadTimeNs: Math.max(0, neighbor.lastHelloAtNs + neighbor.deadIntervalNs - now),
          lastHelloAtNs: neighbor.lastHelloAtNs,
        };
      });
  }

  interfaceSummaries(): OspfInterfaceSummary[] {
    this.refreshBeforeInspection();
    return this.enabledInterfaces().map((iface): OspfInterfaceSummary => {
      const runtime = this.interfaceRuntime.get(iface.id);
      const passive = this.isPassive(iface);
      const pointToPoint = this.networkTypeOf(iface) === "point-to-point";
      const neighborCount = this.neighborsOn(iface.id).length;
      return {
        interfaceId: iface.id,
        area: OSPF_BACKBONE_AREA,
        cost: this.costOf(iface.id),
        state: !iface.operationalUp
          ? "down"
          : iface.loopback
            ? "loopback"
            : passive
              ? "waiting"
              : pointToPoint
                ? "point-to-point"
                : runtime?.designatedRouter === iface.address
                  ? "dr"
                  : runtime?.backupDesignatedRouter === iface.address
                    ? "bdr"
                    : runtime?.designatedRouter !== undefined
                      ? "drother"
                      : "waiting",
        networkType: iface.loopback ? "loopback" : this.networkTypeOf(iface),
        helloIntervalNs: this.helloIntervalOf(iface.id),
        deadIntervalNs: this.deadIntervalOf(iface.id),
        priority: this.priorityOf(iface.id),
        designatedRouter: runtime?.designatedRouter,
        backupDesignatedRouter: runtime?.backupDesignatedRouter,
        passive,
        address: iface.address,
        neighborCount,
      };
    });
  }

  database(): OspfLsdbEntry[] {
    this.flushPendingSpf();
    const now = this.engineOrUndefined()?.now() ?? 0;
    return this.sortedLsas().map((lsa) => ({
      type: lsa.type,
      linkStateId: lsa.linkStateId,
      advertisingRouter: lsa.advertisingRouter,
      sequence: lsa.sequence,
      ageNs: Math.max(0, now - lsa.originatedAtNs),
      checksum: lsa.checksum,
      linkCount: lsa.type === "router" ? lsa.links.length : lsa.attachedRouters.length,
    }));
  }

  // --- helpers ------------------------------------------------------------

  private setNeighborState(neighbor: NeighborRuntime, state: OspfNeighborState, reason: string): void {
    if (neighbor.state === state) return;
    this.charge("adjacencyTransitions");
    const previous = neighbor.state;
    neighbor.state = state;
    // An adjacency that falls below Exchange is no longer synchronizing, so
    // whatever it had not acknowledged is void: the database exchange starts
    // again from scratch. Keeping the entries would retransmit into an adjacency
    // that no longer exists and would hold the retransmission timer open.
    if (state !== "full" && state !== "loading" && state !== "exchange") neighbor.unacknowledged.clear();
    this.trace("ospf-neighbor-state-changed", {
      interface: neighbor.interfaceId,
      neighborRouterId: neighbor.routerId,
      previousState: previous,
      state,
      reason,
    });
    // Any adjacency transition is a real stimulus: re-open the activity window
    // so a restarted or re-cabled neighbour is picked up without waiting.
    this.arm();
    if (state === "full") {
      // Originate first: the neighbour must also receive the Network LSA that
      // this very adjacency has just brought into existence.
      this.originateLsas();
      this.synchronizeDatabase(neighbor);
      this.requestSpf("adjacency reached full");
    }
  }

  private traceNeighborState(neighbor: NeighborRuntime, state: OspfNeighborState, reason: string): void {
    this.trace("ospf-neighbor-state-changed", {
      interface: neighbor.interfaceId,
      neighborRouterId: neighbor.routerId,
      previousState: neighbor.state,
      state,
      reason,
    });
    // Losing an adjacency changes what we advertise and how we route.
    this.originateLsas();
    this.requestSpf("adjacency lost");
  }

  private get engine(): SimulationEngine {
    return this.host.engine;
  }

  private engineOrUndefined(): SimulationEngine | undefined {
    return (this.host as { engine?: SimulationEngine }).engine;
  }

  private charge(key: "ospfEvents" | "lsaFloods" | "spfRuns" | "adjacencyTransitions", amount = 1): void {
    this.engineOrUndefined()?.controlProtocolBudget.consume(key, undefined, amount);
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    engine.trace({ time: engine.now(), type, device: this.host.id, detail });
  }
}

function emptySpfCounters(): {
  requests: number;
  coalescedRequests: number;
  scheduledEvents: number;
  executions: number;
  skippedUnchanged: number;
  skippedEmptyTopology: number;
} {
  return {
    requests: 0,
    coalescedRequests: 0,
    scheduledEvents: 0,
    executions: 0,
    skippedUnchanged: 0,
    skippedEmptyTopology: 0,
  };
}

function emptyFloodCounters(): {
  offers: number;
  retransmissions: number;
  acknowledgements: number;
  abandoned: number;
  initialUpdates: number;
  retransmittedUpdates: number;
} {
  return {
    offers: 0,
    retransmissions: 0,
    acknowledgements: 0,
    abandoned: 0,
    initialUpdates: 0,
    retransmittedUpdates: 0,
  };
}

function neighborKey(interfaceId: string, routerId: Ipv4): string {
  return `${interfaceId} ${routerId}`;
}

/**
 * Two headers describe the same advertisement *instance*.
 *
 * Sequence alone is not enough: `isNewer` also compares the body checksum, so
 * an acknowledgement or a retransmission must agree on both before it is
 * allowed to clear or repeat correctness state.
 */
function isSameLsaInstance(a: OspfLsaHeader, b: OspfLsaHeader): boolean {
  return a.sequence === b.sequence && a.checksum === b.checksum;
}

/**
 * The retransmission walk's neighbour order: router id first, then interface.
 *
 * Flooding orders neighbours by interface because it works one segment at a
 * time; a retransmission is about who still owes an acknowledgement, so it is
 * ordered by the peer. Both are total and stable, which is all determinism
 * needs.
 */
function byRetransmissionOrder(
  a: { interfaceId: string; routerId: Ipv4 },
  b: { interfaceId: string; routerId: Ipv4 },
): number {
  return compareOspfRouterIds(a.routerId, b.routerId) || a.interfaceId.localeCompare(b.interfaceId);
}

/** LSA keys in a stable order: type, then link-state id, then advertising router. */
function compareRetransmissionKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lsaKeyOf(lsa: OspfLsa): string {
  return lsaKey(lsa.type, lsa.linkStateId, lsa.advertisingRouter);
}

function byNeighborOrder(a: { interfaceId: string; routerId: Ipv4 }, b: { interfaceId: string; routerId: Ipv4 }): number {
  return a.interfaceId.localeCompare(b.interfaceId) || compareOspfRouterIds(a.routerId, b.routerId);
}

/** `network <address> <wildcard>`: a zero wildcard bit must match exactly. */
export function matchesWildcard(address: Ipv4, network: Ipv4, wildcard: Ipv4): boolean {
  const mask = ~ipToInt(wildcard) >>> 0;
  return ((ipToInt(address) & mask) >>> 0) === ((ipToInt(network) & mask) >>> 0);
}

function prefixLengthOf(maskInt: number): number {
  let value = maskInt >>> 0;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}
