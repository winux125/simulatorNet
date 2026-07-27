import type { SimulationEngine } from "../engine/simulation-engine";
import type { OspfNeighborState, OspfNetworkType } from "../packets/ospf";
import {
  OSPFV3_ALL_ROUTERS,
  ospfv3LsaChecksum,
  type Ospfv3HelloPacket,
  type Ospfv3Packet,
  type Ospfv3RouterLsa,
} from "../packets/ospfv3";
import type { Ipv4 } from "../util/ipv4";
import { ipToInt } from "../util/ipv4";
import { ipv6Network, isIpv6LinkLocal, normalizeIpv6, type Ipv6 } from "../util/ipv6";
import {
  compareOspfRouterIds,
  shortestOspfPaths,
  sortOspfElectionCandidates,
} from "./ospf-common";
import {
  DEFAULT_OSPF_COST,
  DEFAULT_OSPF_DEAD_INTERVAL_NS,
  DEFAULT_OSPF_HELLO_INTERVAL_NS,
  DEFAULT_OSPF_PRIORITY,
  OSPF_ADMINISTRATIVE_DISTANCE,
} from "./ospf";
import {
  ControlProtocolConfigurationError,
  enforceStructuralLimit,
} from "./limits";
import { ProtocolActivity } from "./protocol-activity";

const OSPFV3_QUIESCENCE_ROUNDS = 4;
const OSPFV3_MAXIMUM_TICKS = 4_096;
const MAXIMUM_RETRANSMISSIONS = 3;

export interface Ospfv3InterfaceDescriptor {
  readonly id: string;
  readonly linkLocal?: Ipv6;
  readonly prefixes: ReadonlyArray<{ network: Ipv6; prefixLength: number }>;
  readonly operationalUp: boolean;
  readonly loopback: boolean;
}

export interface Ospfv3InterfaceConfiguration {
  readonly enabled?: boolean;
  readonly area?: number;
  readonly cost?: number;
  readonly priority?: number;
  readonly networkType?: OspfNetworkType;
  readonly helloIntervalNs?: number;
  readonly deadIntervalNs?: number;
}

export interface Ospfv3Configuration {
  readonly processId: number;
  readonly routerId?: Ipv4;
  readonly passiveInterfaces: readonly string[];
  readonly interfaces: ReadonlyArray<{ id: string; configuration: Ospfv3InterfaceConfiguration }>;
}

export interface Ospfv3NeighborSummary {
  readonly neighborRouterId: Ipv4;
  readonly address: Ipv6;
  readonly interfaceId: string;
  readonly state: OspfNeighborState;
  readonly priority: number;
  readonly role: "dr" | "bdr" | "drother" | "point-to-point";
  readonly lastHelloAtNs: number;
  readonly deadTimeNs: number;
}

export interface Ospfv3Route {
  readonly network: Ipv6;
  readonly prefixLength: number;
  readonly nextHop: Ipv6;
  readonly interfaceId: string;
  readonly cost: number;
  readonly administrativeDistance: typeof OSPF_ADMINISTRATIVE_DISTANCE;
}

export interface Ospfv3LsdbEntry {
  readonly advertisingRouter: Ipv4;
  readonly sequence: number;
  readonly checksum: number;
  readonly ageNs: number;
  readonly prefixCount: number;
  readonly linkCount: number;
}

export interface Ospfv3Overview {
  readonly processId: number;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly routerId?: Ipv4;
  readonly neighbors: number;
  readonly fullNeighbors: number;
  readonly lsas: number;
  readonly routes: number;
  readonly spfRuns: number;
}

export interface Ospfv3Host {
  readonly id: string;
  readonly engine: SimulationEngine;
  ospfv3Interfaces(): readonly Ospfv3InterfaceDescriptor[];
  ospfv3Send(interfaceId: string, destination: Ipv6, packet: Ospfv3Packet): void;
  ospfv3RoutesChanged(): void;
}

interface NeighborRuntime {
  routerId: Ipv4;
  address: Ipv6;
  interfaceId: string;
  state: OspfNeighborState;
  priority: number;
  designatedRouter?: Ipv4;
  backupDesignatedRouter?: Ipv4;
  lastHelloAtNs: number;
  deadIntervalNs: number;
}

interface InterfaceRuntime {
  designatedRouter?: Ipv4;
  backupDesignatedRouter?: Ipv4;
}

interface PendingUpdate {
  readonly neighborKey: string;
  readonly packet: Extract<Ospfv3Packet, { type: "lsu" }>;
  attempts: number;
}

/**
 * OSPFv3 area-0 process. It reuses OSPFv2 timers, neighbor states, activity
 * windows, resource budgets, DR ordering and the common stable Dijkstra walk.
 * The packet model is intentionally structured and omits authentication and
 * external LSAs.
 */
export class Ospfv3Process {
  private processId = 1;
  private configuredRouterId: Ipv4 | undefined;
  private running = false;
  private readonly passiveInterfaces = new Set<string>();
  private readonly interfaceConfig = new Map<string, Ospfv3InterfaceConfiguration>();
  private readonly interfaceRuntime = new Map<string, InterfaceRuntime>();
  private readonly neighbors = new Map<string, NeighborRuntime>();
  private readonly lsdb = new Map<Ipv4, Ospfv3RouterLsa>();
  private readonly pendingUpdates = new Map<string, PendingUpdate>();
  private readonly problems = new Set<string>();
  private routes: Ospfv3Route[] = [];
  private sequence = 0x80000001;
  private nextUpdateId = 1;
  private spfRuns = 0;
  private localDirty = true;
  private readonly activity: ProtocolActivity;

  constructor(private readonly host: Ospfv3Host) {
    this.activity = new ProtocolActivity(
      () => this.engineOrUndefined(),
      {
        name: "ospfv3",
        intervalNs: DEFAULT_OSPF_HELLO_INTERVAL_NS,
        quiescenceRounds: OSPFV3_QUIESCENCE_ROUNDS,
        maximumTicks: OSPFV3_MAXIMUM_TICKS,
      },
      () => this.tick(),
    );
  }

  createProcess(processId: number): void {
    if (!Number.isInteger(processId) || processId < 1 || processId > 65_535) {
      throw new ControlProtocolConfigurationError("OSPFv3 process id must be between 1 and 65535", "processId");
    }
    if (this.running && this.processId !== processId) {
      throw new ControlProtocolConfigurationError(
        `OSPFv3 process ${this.processId} is already running; only one process is supported`,
        "processId",
      );
    }
    this.processId = processId;
    this.running = true;
    this.markDirty();
  }

  removeProcess(): void {
    this.running = false;
    this.resetRuntime();
  }

  get enabled(): boolean {
    return this.running;
  }

  setRouterId(routerId: Ipv4 | undefined): void {
    if (routerId !== undefined) ipToInt(routerId);
    this.configuredRouterId = routerId;
    this.markDirty();
  }

  routerId(): Ipv4 | undefined {
    return this.configuredRouterId;
  }

  configureInterface(interfaceId: string, configuration: Ospfv3InterfaceConfiguration): void {
    if (configuration.area !== undefined && configuration.area !== 0) {
      throw new ControlProtocolConfigurationError("Only OSPFv3 area 0 is supported", "area");
    }
    if (configuration.cost !== undefined
      && (!Number.isInteger(configuration.cost) || configuration.cost < 1 || configuration.cost > 65_535)) {
      throw new ControlProtocolConfigurationError("OSPFv3 interface cost must be between 1 and 65535", "cost");
    }
    if (configuration.priority !== undefined
      && (!Number.isInteger(configuration.priority) || configuration.priority < 0 || configuration.priority > 255)) {
      throw new ControlProtocolConfigurationError("OSPFv3 interface priority must be between 0 and 255", "priority");
    }
    for (const [field, value] of [
      ["helloIntervalNs", configuration.helloIntervalNs],
      ["deadIntervalNs", configuration.deadIntervalNs],
    ] as const) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new ControlProtocolConfigurationError(`OSPFv3 ${field} must be positive`, field);
      }
    }
    enforceStructuralLimit("maximumOspfInterfacesPerDevice", this.interfaceConfig.size + 1);
    this.interfaceConfig.set(interfaceId, {
      ...this.interfaceConfigurationOf(interfaceId),
      ...configuration,
      area: 0,
    });
    this.markDirty();
  }

  interfaceConfigurationOf(interfaceId: string): Ospfv3InterfaceConfiguration {
    return this.interfaceConfig.get(interfaceId) ?? {};
  }

  setPassiveInterface(interfaceId: string, passive: boolean): void {
    if (passive) this.passiveInterfaces.add(interfaceId);
    else this.passiveInterfaces.delete(interfaceId);
    this.markDirty();
  }

  configuration(): Ospfv3Configuration {
    return {
      processId: this.processId,
      routerId: this.configuredRouterId,
      passiveInterfaces: [...this.passiveInterfaces].sort((left, right) => left.localeCompare(right)),
      interfaces: [...this.interfaceConfig.entries()]
        .map(([id, configuration]) => ({ id, configuration: { ...configuration } }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  resetRuntime(): void {
    this.neighbors.clear();
    this.lsdb.clear();
    this.interfaceRuntime.clear();
    this.pendingUpdates.clear();
    this.problems.clear();
    this.routes = [];
    this.sequence = 0x80000001;
    this.nextUpdateId = 1;
    this.spfRuns = 0;
    this.localDirty = true;
    this.activity.quiesce();
    this.activity.resetBudget();
    this.host.ospfv3RoutesChanged();
  }

  restart(): void {
    const wasRunning = this.running;
    this.resetRuntime();
    this.running = wasRunning;
    if (wasRunning) this.arm();
  }

  arm(): void {
    if (this.running) this.activity.arm();
  }

  onInterfaceStateChanged(interfaceId: string): void {
    if (!this.running) return;
    const descriptor = this.descriptor(interfaceId);
    if (!descriptor?.operationalUp) {
      for (const [key, neighbor] of [...this.neighbors]) {
        if (neighbor.interfaceId !== interfaceId) continue;
        this.traceState(neighbor, "down", "interface down");
        this.neighbors.delete(key);
      }
      this.interfaceRuntime.delete(interfaceId);
      this.markDirty();
    } else {
      this.arm();
    }
  }

  onPacket(packet: Ospfv3Packet, interfaceId: string, sourceAddress: Ipv6): void {
    if (!this.running || !this.configuredRouterId || packet.routerId === this.configuredRouterId) return;
    const descriptor = this.descriptor(interfaceId);
    if (!descriptor || !this.interfaceEnabled(interfaceId) || !descriptor.operationalUp
      || this.passiveInterfaces.has(interfaceId)) return;
    this.charge("ospfEvents");
    if (packet.type === "hello") this.onHello(packet, interfaceId, sourceAddress);
    else if (packet.type === "lsu") this.onUpdate(packet, interfaceId, sourceAddress);
    else this.onAck(packet, interfaceId);
  }

  neighborSummaries(): Ospfv3NeighborSummary[] {
    this.refreshBeforeInspection();
    return [...this.neighbors.values()]
      .sort((left, right) =>
        left.interfaceId.localeCompare(right.interfaceId)
        || compareOspfRouterIds(left.routerId, right.routerId))
      .map((neighbor) => {
        const runtime = this.interfaceRuntime.get(neighbor.interfaceId);
        const networkType = this.networkTypeOf(neighbor.interfaceId);
        const role = networkType === "point-to-point"
          ? "point-to-point"
          : runtime?.designatedRouter === neighbor.routerId
            ? "dr"
            : runtime?.backupDesignatedRouter === neighbor.routerId
              ? "bdr"
              : "drother";
        return {
          neighborRouterId: neighbor.routerId,
          address: neighbor.address,
          interfaceId: neighbor.interfaceId,
          state: neighbor.state,
          priority: neighbor.priority,
          role,
          lastHelloAtNs: neighbor.lastHelloAtNs,
          deadTimeNs: Math.max(0, neighbor.deadIntervalNs - (this.engine.now() - neighbor.lastHelloAtNs)),
        };
      });
  }

  routeTable(): Ospfv3Route[] {
    this.refreshBeforeInspection();
    return this.routes.map((route) => ({ ...route }));
  }

  database(): Ospfv3LsdbEntry[] {
    return [...this.lsdb.values()]
      .sort((left, right) => compareOspfRouterIds(left.advertisingRouter, right.advertisingRouter))
      .map((lsa) => ({
        advertisingRouter: lsa.advertisingRouter,
        sequence: lsa.sequence,
        checksum: lsa.checksum,
        ageNs: Math.max(0, this.engine.now() - lsa.originatedAtNs),
        prefixCount: lsa.prefixes.length,
        linkCount: lsa.links.length,
      }));
  }

  overview(): Ospfv3Overview {
    this.refreshBeforeInspection();
    return {
      processId: this.processId,
      enabled: this.running,
      running: this.running && this.configuredRouterId !== undefined && this.enabledInterfaces().length > 0,
      routerId: this.configuredRouterId,
      neighbors: this.neighbors.size,
      fullNeighbors: [...this.neighbors.values()].filter((neighbor) => neighbor.state === "full").length,
      lsas: this.lsdb.size,
      routes: this.routes.length,
      spfRuns: this.spfRuns,
    };
  }

  problemSummaries(): string[] {
    return [...this.problems].sort((left, right) => left.localeCompare(right));
  }

  private tick(): void {
    if (!this.running || !this.configuredRouterId) return;
    this.expireNeighbors();
    this.electDesignatedRouters();
    if (this.localDirty) this.originateLocalLsa();
    this.retransmitPending();
    this.sendHellos();
  }

  private sendHellos(): void {
    const routerId = this.configuredRouterId;
    if (!routerId) return;
    for (const iface of this.enabledInterfaces()) {
      if (!iface.operationalUp || iface.loopback || this.passiveInterfaces.has(iface.id) || !iface.linkLocal) continue;
      const runtime = this.interfaceRuntime.get(iface.id);
      const packet: Ospfv3HelloPacket = {
        kind: "ospfv3",
        type: "hello",
        routerId,
        areaId: 0,
        interfaceId: stableInterfaceId(iface.id),
        helloIntervalNs: this.helloIntervalOf(iface.id),
        deadIntervalNs: this.deadIntervalOf(iface.id),
        priority: this.priorityOf(iface.id),
        networkType: this.networkTypeOf(iface.id),
        designatedRouter: runtime?.designatedRouter,
        backupDesignatedRouter: runtime?.backupDesignatedRouter,
        neighbors: this.neighborsOn(iface.id).map((neighbor) => neighbor.routerId),
      };
      this.charge("ospfEvents");
      this.host.ospfv3Send(iface.id, OSPFV3_ALL_ROUTERS, packet);
      this.trace("ospfv3-hello-sent", { interface: iface.id, neighbors: packet.neighbors.length });
    }
  }

  private onHello(packet: Ospfv3HelloPacket, interfaceId: string, sourceAddress: Ipv6): void {
    const mismatch = packet.areaId !== 0
      ? "area mismatch"
      : packet.helloIntervalNs !== this.helloIntervalOf(interfaceId)
        ? "hello interval mismatch"
        : packet.deadIntervalNs !== this.deadIntervalOf(interfaceId)
          ? "dead interval mismatch"
          : packet.networkType !== this.networkTypeOf(interfaceId)
            ? "network type mismatch"
            : undefined;
    if (mismatch) {
      this.problems.add(`${interfaceId}: adjacency with ${packet.routerId} rejected — ${mismatch}`);
      return;
    }
    const key = neighborKey(interfaceId, packet.routerId);
    let neighbor = this.neighbors.get(key);
    let changed = false;
    if (!neighbor) {
      enforceStructuralLimit("maximumOspfNeighborsPerDevice", this.neighbors.size + 1);
      neighbor = {
        routerId: packet.routerId,
        address: normalizeIpv6(sourceAddress),
        interfaceId,
        state: "down",
        priority: packet.priority,
        designatedRouter: packet.designatedRouter,
        backupDesignatedRouter: packet.backupDesignatedRouter,
        lastHelloAtNs: this.engine.now(),
        deadIntervalNs: packet.deadIntervalNs,
      };
      this.neighbors.set(key, neighbor);
      this.setState(neighbor, "init", "hello received");
      changed = true;
    } else {
      neighbor.address = normalizeIpv6(sourceAddress);
      neighbor.priority = packet.priority;
      neighbor.designatedRouter = packet.designatedRouter;
      neighbor.backupDesignatedRouter = packet.backupDesignatedRouter;
      neighbor.lastHelloAtNs = this.engine.now();
      neighbor.deadIntervalNs = packet.deadIntervalNs;
    }
    if (packet.neighbors.includes(this.configuredRouterId!)) {
      if (neighbor.state === "init" || neighbor.state === "two-way") {
        this.setState(neighbor, "two-way", "bidirectional hello");
        this.electDesignatedRouters();
        this.setState(neighbor, "exstart", "database exchange started");
        this.setState(neighbor, "exchange", "database summaries exchanged");
        this.setState(neighbor, "loading", "link states synchronized");
        this.setState(neighbor, "full", "link state databases synchronized");
        changed = true;
      }
    } else if (neighbor.state !== "init") {
      this.setState(neighbor, "init", "one-way hello");
      changed = true;
    }
    if (changed) {
      this.markDirty();
      if (neighbor.state === "full" && this.lsdb.size > 0) {
        this.sendUpdate(neighbor, [...this.lsdb.values()]);
      }
    }
  }

  private onUpdate(
    packet: Extract<Ospfv3Packet, { type: "lsu" }>,
    interfaceId: string,
    sourceAddress: Ipv6,
  ): void {
    let installed = false;
    for (const candidate of packet.lsas) {
      const current = this.lsdb.get(candidate.advertisingRouter);
      if (current && (
        current.sequence > candidate.sequence
        || (current.sequence === candidate.sequence && current.checksum === candidate.checksum)
      )) continue;
      enforceStructuralLimit("maximumLsasPerLab", this.lsdb.size + (current ? 0 : 1));
      this.lsdb.set(candidate.advertisingRouter, cloneLsa(candidate));
      installed = true;
    }
    const ack: Extract<Ospfv3Packet, { type: "lsack" }> = {
      kind: "ospfv3",
      type: "lsack",
      routerId: this.configuredRouterId!,
      areaId: 0,
      updateId: packet.updateId,
      advertisingRouters: packet.lsas.map((lsa) => lsa.advertisingRouter),
    };
    this.host.ospfv3Send(interfaceId, sourceAddress, ack);
    if (!installed) return;
    this.charge("lsaFloods", packet.lsas.length);
    this.runSpf();
    for (const neighbor of this.fullNeighbors()) {
      if (neighbor.routerId === packet.routerId) continue;
      this.sendUpdate(neighbor, packet.lsas);
    }
    this.arm();
  }

  private onAck(packet: Extract<Ospfv3Packet, { type: "lsack" }>, interfaceId: string): void {
    this.pendingUpdates.delete(pendingKey(neighborKey(interfaceId, packet.routerId), packet.updateId));
  }

  private originateLocalLsa(): void {
    const routerId = this.configuredRouterId;
    if (!routerId) return;
    const prefixes = this.enabledInterfaces()
      .flatMap((iface) => iface.prefixes.map((prefix) => ({
        network: ipv6Network(prefix.network, prefix.prefixLength),
        prefixLength: prefix.prefixLength,
        cost: this.costOf(iface.id),
      })))
      .filter((prefix) => !isIpv6LinkLocal(prefix.network))
      .sort((left, right) =>
        left.network.localeCompare(right.network) || left.prefixLength - right.prefixLength);
    const links = this.fullNeighbors()
      .map((neighbor) => ({ routerId: neighbor.routerId, cost: this.costOf(neighbor.interfaceId) }))
      .sort((left, right) => compareOspfRouterIds(left.routerId, right.routerId));
    const base = {
      advertisingRouter: routerId,
      sequence: this.sequence++,
      originatedAtNs: this.engine.now(),
      prefixes,
      links,
    };
    const lsa: Ospfv3RouterLsa = { ...base, checksum: ospfv3LsaChecksum(base) };
    this.lsdb.set(routerId, lsa);
    this.localDirty = false;
    this.runSpf();
    for (const neighbor of this.fullNeighbors()) this.sendUpdate(neighbor, [lsa]);
  }

  private sendUpdate(neighbor: NeighborRuntime, lsas: readonly Ospfv3RouterLsa[]): void {
    if (lsas.length === 0) return;
    const packet: Extract<Ospfv3Packet, { type: "lsu" }> = {
      kind: "ospfv3",
      type: "lsu",
      routerId: this.configuredRouterId!,
      areaId: 0,
      updateId: this.nextUpdateId++,
      lsas: lsas.map(cloneLsa),
    };
    const key = pendingKey(neighborKey(neighbor.interfaceId, neighbor.routerId), packet.updateId);
    this.pendingUpdates.set(key, { neighborKey: neighborKey(neighbor.interfaceId, neighbor.routerId), packet, attempts: 1 });
    this.charge("lsaFloods", lsas.length);
    this.charge("ospfEvents");
    this.host.ospfv3Send(neighbor.interfaceId, neighbor.address, packet);
  }

  private retransmitPending(): void {
    for (const [key, pending] of [...this.pendingUpdates]) {
      const neighbor = this.neighbors.get(pending.neighborKey);
      if (!neighbor || neighbor.state !== "full" || pending.attempts >= MAXIMUM_RETRANSMISSIONS) {
        this.pendingUpdates.delete(key);
        continue;
      }
      pending.attempts++;
      this.charge("lsaFloods", pending.packet.lsas.length);
      this.host.ospfv3Send(neighbor.interfaceId, neighbor.address, pending.packet);
    }
  }

  private runSpf(): void {
    const routerId = this.configuredRouterId;
    if (!routerId) return;
    this.charge("spfRuns");
    this.spfRuns++;
    const edges = [...this.lsdb.values()].flatMap((lsa) =>
      lsa.links.map((link) => ({ from: lsa.advertisingRouter, to: link.routerId, cost: link.cost })));
    const paths = new Map(shortestOspfPaths(routerId, edges).map((path) => [path.routerId, path]));
    const localPrefixes = new Set(
      (this.lsdb.get(routerId)?.prefixes ?? []).map((prefix) => `${prefix.network}/${prefix.prefixLength}`),
    );
    const next = new Map<string, Ospfv3Route>();
    for (const lsa of this.lsdb.values()) {
      if (lsa.advertisingRouter === routerId) continue;
      const path = paths.get(lsa.advertisingRouter);
      const firstHop = path?.firstHop ? this.neighborByRouterId(path.firstHop) : undefined;
      if (!path || !firstHop) continue;
      for (const prefix of lsa.prefixes) {
        const key = `${prefix.network}/${prefix.prefixLength}`;
        if (localPrefixes.has(key)) continue;
        const candidate: Ospfv3Route = {
          network: prefix.network,
          prefixLength: prefix.prefixLength,
          nextHop: firstHop.address,
          interfaceId: firstHop.interfaceId,
          cost: path.cost + prefix.cost,
          administrativeDistance: OSPF_ADMINISTRATIVE_DISTANCE,
        };
        const existing = next.get(key);
        if (!existing || candidate.cost < existing.cost
          || (candidate.cost === existing.cost
            && candidate.nextHop.localeCompare(existing.nextHop) < 0)) {
          next.set(key, candidate);
        }
      }
    }
    const routes = [...next.values()].sort((left, right) =>
      left.network.localeCompare(right.network)
      || left.prefixLength - right.prefixLength
      || left.nextHop.localeCompare(right.nextHop));
    const changed = JSON.stringify(routes) !== JSON.stringify(this.routes);
    this.routes = routes;
    this.trace("ospfv3-spf-completed", { routerId, routes: routes.length, vertices: paths.size });
    if (changed) this.host.ospfv3RoutesChanged();
  }

  private electDesignatedRouters(): void {
    for (const iface of this.enabledInterfaces()) {
      const runtime = this.interfaceRuntime.get(iface.id) ?? {};
      this.interfaceRuntime.set(iface.id, runtime);
      if (this.networkTypeOf(iface.id) === "point-to-point" || iface.loopback || !iface.operationalUp) {
        runtime.designatedRouter = undefined;
        runtime.backupDesignatedRouter = undefined;
        continue;
      }
      const candidates = sortOspfElectionCandidates([
        { routerId: this.configuredRouterId!, priority: this.priorityOf(iface.id) },
        ...this.neighborsOn(iface.id)
          .filter((neighbor) => neighbor.state !== "down" && neighbor.state !== "init")
          .map((neighbor) => ({ routerId: neighbor.routerId, priority: neighbor.priority })),
      ]);
      runtime.designatedRouter = candidates[0]?.routerId;
      runtime.backupDesignatedRouter = candidates[1]?.routerId;
    }
  }

  private expireNeighbors(): boolean {
    let changed = false;
    for (const [key, neighbor] of [...this.neighbors]) {
      if (this.engine.now() - neighbor.lastHelloAtNs < neighbor.deadIntervalNs) continue;
      this.neighbors.delete(key);
      this.traceState(neighbor, "down", "dead interval expired");
      changed = true;
    }
    if (changed) this.markDirty();
    return changed;
  }

  private refreshBeforeInspection(): void {
    if (this.expireNeighbors()) {
      this.originateLocalLsa();
      this.arm();
    }
  }

  private markDirty(): void {
    this.localDirty = true;
    this.arm();
  }

  private setState(neighbor: NeighborRuntime, state: OspfNeighborState, reason: string): void {
    if (neighbor.state === state) return;
    this.charge("adjacencyTransitions");
    const previous = neighbor.state;
    neighbor.state = state;
    this.trace("ospfv3-neighbor-state-changed", {
      interface: neighbor.interfaceId,
      neighborRouterId: neighbor.routerId,
      previousState: previous,
      state,
      reason,
    });
  }

  private traceState(neighbor: NeighborRuntime, state: OspfNeighborState, reason: string): void {
    this.trace("ospfv3-neighbor-state-changed", {
      interface: neighbor.interfaceId,
      neighborRouterId: neighbor.routerId,
      previousState: neighbor.state,
      state,
      reason,
    });
  }

  private enabledInterfaces(): Ospfv3InterfaceDescriptor[] {
    return this.host.ospfv3Interfaces()
      .filter((iface) => this.interfaceEnabled(iface.id))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  private interfaceEnabled(interfaceId: string): boolean {
    return this.interfaceConfig.get(interfaceId)?.enabled === true;
  }

  private descriptor(interfaceId: string): Ospfv3InterfaceDescriptor | undefined {
    return this.host.ospfv3Interfaces().find((iface) => iface.id === interfaceId);
  }

  private neighborsOn(interfaceId: string): NeighborRuntime[] {
    return [...this.neighbors.values()]
      .filter((neighbor) => neighbor.interfaceId === interfaceId)
      .sort((left, right) => compareOspfRouterIds(left.routerId, right.routerId));
  }

  private fullNeighbors(): NeighborRuntime[] {
    return [...this.neighbors.values()]
      .filter((neighbor) => neighbor.state === "full")
      .sort((left, right) =>
        left.interfaceId.localeCompare(right.interfaceId)
        || compareOspfRouterIds(left.routerId, right.routerId));
  }

  private neighborByRouterId(routerId: Ipv4): NeighborRuntime | undefined {
    return this.fullNeighbors().find((neighbor) => neighbor.routerId === routerId);
  }

  private costOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.cost ?? DEFAULT_OSPF_COST;
  }

  private priorityOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.priority ?? DEFAULT_OSPF_PRIORITY;
  }

  private networkTypeOf(interfaceId: string): OspfNetworkType {
    return this.interfaceConfig.get(interfaceId)?.networkType ?? "broadcast";
  }

  private helloIntervalOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.helloIntervalNs ?? DEFAULT_OSPF_HELLO_INTERVAL_NS;
  }

  private deadIntervalOf(interfaceId: string): number {
    return this.interfaceConfig.get(interfaceId)?.deadIntervalNs ?? DEFAULT_OSPF_DEAD_INTERVAL_NS;
  }

  private charge(
    key: "ospfEvents" | "lsaFloods" | "spfRuns" | "adjacencyTransitions",
    amount = 1,
  ): void {
    this.engineOrUndefined()?.controlProtocolBudget.consume(key, undefined, amount);
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.engineOrUndefined();
    if (engine) engine.trace({ time: engine.now(), type, device: this.host.id, detail });
  }

  private get engine(): SimulationEngine {
    return this.host.engine;
  }

  private engineOrUndefined(): SimulationEngine | undefined {
    return (this.host as { engine?: SimulationEngine }).engine;
  }
}

function neighborKey(interfaceId: string, routerId: Ipv4): string {
  return `${interfaceId}\u0000${routerId}`;
}

function pendingKey(neighbor: string, updateId: number): string {
  return `${neighbor}\u0000${updateId}`;
}

function stableInterfaceId(interfaceId: string): number {
  let hash = 2_166_136_261;
  for (const char of interfaceId) hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619) >>> 0;
  return hash;
}

function cloneLsa(lsa: Ospfv3RouterLsa): Ospfv3RouterLsa {
  return {
    ...lsa,
    prefixes: lsa.prefixes.map((prefix) => ({ ...prefix })),
    links: lsa.links.map((link) => ({ ...link })),
  };
}
