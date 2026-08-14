import { NS_PER_S } from "../engine/constants";
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

const OSPF_QUIESCENCE_ROUNDS = 4;
const OSPF_MAXIMUM_TICKS = 4_096;
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

/** One LSA instance sent to a neighbour and not yet acknowledged. */
interface UnacknowledgedLsa {
  /** Sequence of the instance we are waiting for; a newer one starts over. */
  sequence: number;
  attempts: number;
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
    this.runSpf();
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

  /** Inspection entry point: age out dead neighbours, then recompute. */
  private refreshBeforeInspection(): void {
    if (!this.running || this.activeRouterId === undefined) return;
    if (!this.expireNeighbors()) return;
    this.electDesignatedRouters();
    this.originateLsas();
    this.runSpf();
    this.arm();
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
    this.sendLinkStateUpdate(interfaceId, neighbor.address, lsas);
  }

  private onLinkStateUpdate(packet: OspfLinkStateUpdatePacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    let installed = 0;
    for (const lsa of packet.lsas) {
      if (!this.installLsa(lsa, interfaceId)) continue;
      installed++;
    }
    if (neighbor) {
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
      this.runSpf();
      this.arm();
    }
  }

  private onLinkStateAck(packet: OspfLinkStateAckPacket, interfaceId: string): void {
    const neighbor = this.neighbors.get(neighborKey(interfaceId, packet.routerId));
    if (!neighbor) return;
    for (const header of packet.headers) {
      const key = lsaKey(header.type, header.linkStateId, header.advertisingRouter);
      // Only the acknowledged instance leaves the list; an older acknowledgement
      // must not clear a newer advertisement that is still in flight.
      if (neighbor.unacknowledged.get(key)?.sequence === header.sequence) neighbor.unacknowledged.delete(key);
    }
    this.trace("ospf-lsa-acknowledged", {
      interface: interfaceId,
      neighborRouterId: packet.routerId,
      count: packet.headers.length,
    });
    if (neighbor.state === "loading" || neighbor.state === "exchange") {
      this.setNeighborState(neighbor, "full", "link state database synchronized");
    }
  }

  private sendLinkStateUpdate(interfaceId: string, destination: Ipv4, lsas: readonly OspfLsa[]): void {
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
    this.trace("ospf-lsa-flooded", { interface: interfaceId, destination, count: lsas.length });
    this.host.ospfSend(interfaceId, destination, packet);
  }

  /** Reliable, bounded flooding to every full adjacency except the source. */
  private floodLsas(lsas: readonly OspfLsa[], exceptInterfaceId?: string): void {
    if (lsas.length === 0) return;
    for (const neighbor of [...this.neighbors.values()].sort(byNeighborOrder)) {
      if (neighbor.state !== "full") continue;
      if (neighbor.interfaceId === exceptInterfaceId) continue;
      const due = lsas.filter((lsa) => this.admitToRetransmissionList(neighbor, lsa));
      if (due.length === 0) continue;
      this.sendLinkStateUpdate(neighbor.interfaceId, neighbor.address, due);
    }
  }

  /**
   * The retransmission bound applies to *one LSA*, never to distinct LSAs.
   *
   * A neighbour that stops acknowledging must not keep us sending for ever, but
   * an advertisement the neighbour has never been offered is not a
   * retransmission: dropping it leaves a permanent hole in its database,
   * because nothing here refreshes an LSA periodically and duplicate
   * suppression stops it from ever being flooded again. A newer instance of the
   * same LSA starts the count over, so a re-originated advertisement is always
   * delivered.
   */
  private admitToRetransmissionList(neighbor: NeighborRuntime, lsa: OspfLsa): boolean {
    const key = lsaKeyOf(lsa);
    const pending = neighbor.unacknowledged.get(key);
    if (pending === undefined || pending.sequence !== lsa.sequence) {
      neighbor.unacknowledged.set(key, { sequence: lsa.sequence, attempts: 1 });
      return true;
    }
    if (pending.attempts >= MAXIMUM_LSA_RETRANSMISSIONS) return false;
    pending.attempts++;
    return true;
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
   * re-flooded and the exchange terminates.
   */
  private synchronizeDatabase(neighbor: NeighborRuntime): void {
    const lsas = this.sortedLsas();
    if (lsas.length === 0) return;
    this.sendLinkStateUpdate(neighbor.interfaceId, neighbor.address, lsas);
  }

  private sortedLsas(): OspfLsa[] {
    return [...this.lsdb.values()].sort((a, b) =>
      a.type.localeCompare(b.type)
      || ipToInt(a.linkStateId) - ipToInt(b.linkStateId)
      || ipToInt(a.advertisingRouter) - ipToInt(b.advertisingRouter));
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
   * A run whose inputs are unchanged is skipped: it would install the same
   * routes, and charging the per-operation budget for it is what put a lab of
   * nine routers within a handful of runs of `maximumSpfRunsPerOperation`.
   */
  private runSpf(): void {
    const routerId = this.activeRouterId;
    if (routerId === undefined) return;
    const inputs = this.spfInputFingerprint();
    if (inputs === this.lastSpfInputs) return;
    this.lastSpfInputs = inputs;
    this.charge("spfRuns");
    this.spfRuns++;
    this.lastSpfAtNs = this.engine.now();
    this.trace("ospf-spf-started", { routerId, lsaCount: this.lsdb.size });

    interface Vertex {
      readonly routerId: Ipv4;
      readonly cost: number;
      readonly nextHop: Ipv4 | undefined;
      readonly interfaceId: string | undefined;
    }
    const routerLsas = new Map<Ipv4, OspfLsa>();
    for (const lsa of this.sortedLsas()) {
      if (lsa.type === "router") routerLsas.set(lsa.linkStateId, lsa);
    }
    const localLsa = routerLsas.get(routerId);
    const settled = new Map<Ipv4, Vertex>();
    const candidates: Vertex[] = [{ routerId, cost: 0, nextHop: undefined, interfaceId: undefined }];

    while (candidates.length > 0) {
      candidates.sort((a, b) =>
        a.cost - b.cost
        || ipToInt(a.routerId) - ipToInt(b.routerId)
        || (a.interfaceId ?? "").localeCompare(b.interfaceId ?? ""));
      const current = candidates.shift()!;
      if (settled.has(current.routerId)) continue;
      settled.set(current.routerId, current);
      const lsa = routerLsas.get(current.routerId);
      if (!lsa || lsa.type !== "router") continue;
      for (const link of lsa.links) {
        if (link.type === "stub") continue;
        const neighbors = link.type === "point-to-point"
          ? [link.linkId]
          : this.attachedRoutersOf(link.linkId).filter((attached) => attached !== current.routerId);
        for (const neighborRouterId of neighbors) {
          if (settled.has(neighborRouterId)) continue;
          const resolved = current.routerId === routerId
            ? this.localNextHopFor(link, neighborRouterId)
            : { nextHop: current.nextHop, interfaceId: current.interfaceId };
          if (resolved.interfaceId === undefined) continue;
          candidates.push({
            routerId: neighborRouterId,
            cost: current.cost + link.metric,
            nextHop: resolved.nextHop,
            interfaceId: resolved.interfaceId,
          });
        }
      }
    }

    const routes = new Map<string, OspfRoute>();
    for (const [vertexRouterId, vertex] of settled) {
      if (vertexRouterId === routerId) continue;
      const lsa = routerLsas.get(vertexRouterId);
      if (!lsa || lsa.type !== "router" || vertex.interfaceId === undefined) continue;
      for (const link of lsa.links) {
        if (link.type !== "stub") continue;
        const maskInt = maskToInt(link.linkData);
        const network = intToIp((ipToInt(link.linkId) & maskInt) >>> 0);
        const key = `${network}/${maskInt}`;
        // Skip anything we are directly connected to; connected always wins.
        if (localLsa?.type === "router"
          && localLsa.links.some((own) => own.type === "stub"
            && ((ipToInt(own.linkId) & maskToInt(own.linkData)) >>> 0) === ipToInt(network))) {
          continue;
        }
        const cost = vertex.cost + link.metric;
        const existing = routes.get(key);
        if (existing && (existing.cost < cost
          || (existing.cost === cost && existing.interfaceId.localeCompare(vertex.interfaceId) <= 0))) {
          continue;
        }
        routes.set(key, {
          network,
          maskInt,
          nextHop: vertex.nextHop,
          interfaceId: vertex.interfaceId,
          cost,
        });
      }
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

  private attachedRoutersOf(designatedRouterAddress: Ipv4): Ipv4[] {
    for (const lsa of this.sortedLsas()) {
      if (lsa.type === "network" && lsa.linkStateId === designatedRouterAddress) return [...lsa.attachedRouters];
    }
    return [];
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
      this.runSpf();
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
    this.runSpf();
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

function neighborKey(interfaceId: string, routerId: Ipv4): string {
  return `${interfaceId} ${routerId}`;
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
