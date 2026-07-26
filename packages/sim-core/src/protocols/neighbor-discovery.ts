import { NS_PER_S } from "../engine/constants";
import type { SimulationEngine } from "../engine/simulation-engine";
import {
  type CdpPacket,
  type DiscoveryCapability,
  type DiscoveryProtocol,
  isDiscoveryWithdrawal,
  type LldpPacket,
  SIMULATORNET_SOFTWARE,
} from "../packets/discovery";
import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";
import { ControlProtocolConfigurationError, enforceStructuralLimit } from "./limits";
import { ProtocolActivity } from "./protocol-activity";

/**
 * Deterministic CDP and LLDP neighbour discovery.
 *
 * Both protocols are strictly link-local: an advertisement is consumed by the
 * directly connected device's control plane, so it is never routed, never
 * crosses a router, never depends on end-user VLAN forwarding, and is never
 * evaluated by an IP ACL. A spanning-tree blocking port still exchanges them,
 * exactly like a BPDU — a blocked port stops user data, not link-local control.
 *
 * Both are disabled by default. SimulatorNet ships them off so that existing
 * labs keep their exact deterministic traces; `cdp run` / `lldp run` turn them
 * on per device.
 */

export const DEFAULT_CDP_INTERVAL_NS = 60 * NS_PER_S;
export const DEFAULT_CDP_HOLD_TIME_NS = 180 * NS_PER_S;
export const DEFAULT_LLDP_INTERVAL_NS = 30 * NS_PER_S;
export const DEFAULT_LLDP_HOLD_TIME_NS = 120 * NS_PER_S;

const DISCOVERY_TICK_INTERVAL_NS = 10 * NS_PER_S;
const DISCOVERY_QUIESCENCE_ROUNDS = 3;
const DISCOVERY_MAXIMUM_TICKS = 1_024;

export interface DiscoveryInterfaceConfiguration {
  readonly cdpEnabled: boolean;
  readonly lldpTransmit: boolean;
  readonly lldpReceive: boolean;
}

export interface DiscoveryConfiguration {
  readonly cdpEnabled: boolean;
  readonly lldpEnabled: boolean;
  readonly cdpIntervalNs: number;
  readonly cdpHoldTimeNs: number;
  readonly lldpIntervalNs: number;
  readonly lldpHoldTimeNs: number;
  readonly interfaces: ReadonlyArray<{ id: string; configuration: DiscoveryInterfaceConfiguration }>;
}

export interface DiscoveryNeighbor {
  readonly protocol: DiscoveryProtocol;
  readonly localInterface: string;
  readonly deviceId: string;
  readonly remoteInterface: string;
  readonly platform: string;
  readonly capabilities: readonly DiscoveryCapability[];
  readonly managementAddress?: Ipv4;
  readonly softwareVersion?: string;
  readonly systemDescription?: string;
  readonly portDescription?: string;
  readonly nativeVlan?: number;
  readonly holdTimeNs: number;
  readonly firstSeenNs: number;
  readonly lastSeenNs: number;
  readonly expiresAtNs: number;
}

export interface DiscoveryInterfaceStatus {
  readonly id: string;
  readonly operationalUp: boolean;
  readonly cdpEnabled: boolean;
  readonly lldpTransmit: boolean;
  readonly lldpReceive: boolean;
}

/** The device surface neighbour discovery needs. */
export interface DiscoveryHost {
  readonly id: string;
  readonly name: string;
  readonly engine: SimulationEngine;
  discoveryInterfaceIds(): readonly string[];
  discoveryInterfaceOperationalUp(port: string): boolean;
  discoveryChassisId(): Mac;
  discoveryPlatform(): string;
  discoveryCapabilities(): readonly DiscoveryCapability[];
  discoveryManagementAddress(): Ipv4 | undefined;
  discoveryPortDescription(port: string): string | undefined;
  discoveryNativeVlan(port: string): number | undefined;
  discoverySend(port: string, payload: CdpPacket | LldpPacket): void;
}

interface MutableNeighbor extends DiscoveryNeighbor {
  lastSeenNs: number;
  expiresAtNs: number;
}

const DEFAULT_INTERFACE_CONFIGURATION: DiscoveryInterfaceConfiguration = Object.freeze({
  cdpEnabled: true,
  lldpTransmit: true,
  lldpReceive: true,
});

export class NeighborDiscovery {
  private cdpEnabled = false;
  private lldpEnabled = false;
  private cdpIntervalNs = DEFAULT_CDP_INTERVAL_NS;
  private cdpHoldTimeNs = DEFAULT_CDP_HOLD_TIME_NS;
  private lldpIntervalNs = DEFAULT_LLDP_INTERVAL_NS;
  private lldpHoldTimeNs = DEFAULT_LLDP_HOLD_TIME_NS;
  private readonly interfaceConfig = new Map<string, DiscoveryInterfaceConfiguration>();
  private readonly neighbors = new Map<string, MutableNeighbor>();
  private readonly activity: ProtocolActivity;

  constructor(
    private readonly host: DiscoveryHost,
    /** Devices that never speak CDP (a vendor-neutral host, for instance). */
    private readonly supportsCdp = true,
  ) {
    this.activity = new ProtocolActivity(
      () => this.engineOrUndefined(),
      {
        name: "neighbor-discovery",
        intervalNs: DISCOVERY_TICK_INTERVAL_NS,
        quiescenceRounds: DISCOVERY_QUIESCENCE_ROUNDS,
        maximumTicks: DISCOVERY_MAXIMUM_TICKS,
      },
      () => this.tick(),
    );
  }

  // --- configuration ------------------------------------------------------

  /** `cdp run` / `no cdp run`. */
  setCdpEnabled(enabled: boolean): void {
    if (enabled && !this.supportsCdp) {
      throw new ControlProtocolConfigurationError(
        `${this.host.name} does not support CDP`,
        "cdp",
      );
    }
    if (this.cdpEnabled === enabled) return;
    if (!enabled) this.withdraw("cdp");
    this.cdpEnabled = enabled;
    if (!enabled) this.purgeProtocol("cdp");
    this.arm();
  }

  /** `lldp run` / `no lldp run`. */
  setLldpEnabled(enabled: boolean): void {
    if (this.lldpEnabled === enabled) return;
    if (!enabled) this.withdraw("lldp");
    this.lldpEnabled = enabled;
    if (!enabled) this.purgeProtocol("lldp");
    this.arm();
  }

  get cdpRunning(): boolean {
    return this.cdpEnabled;
  }

  get lldpRunning(): boolean {
    return this.lldpEnabled;
  }

  setTimers(timers: Partial<{
    cdpIntervalNs: number;
    cdpHoldTimeNs: number;
    lldpIntervalNs: number;
    lldpHoldTimeNs: number;
  }>): void {
    for (const [field, value] of Object.entries(timers)) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new ControlProtocolConfigurationError(`${field} must be a positive number of nanoseconds`, field);
      }
    }
    this.cdpIntervalNs = timers.cdpIntervalNs ?? this.cdpIntervalNs;
    this.cdpHoldTimeNs = timers.cdpHoldTimeNs ?? this.cdpHoldTimeNs;
    this.lldpIntervalNs = timers.lldpIntervalNs ?? this.lldpIntervalNs;
    this.lldpHoldTimeNs = timers.lldpHoldTimeNs ?? this.lldpHoldTimeNs;
    this.arm();
  }

  /** `cdp enable` / `no cdp enable` on an interface. */
  setInterfaceCdpEnabled(port: string, enabled: boolean): void {
    this.updateInterface(port, (current) => ({ ...current, cdpEnabled: enabled }), !enabled ? "cdp" : undefined);
    // Disabling the protocol on a port drops what it learned there as well, so
    // both ends of the link agree immediately.
    if (!enabled) this.purgeInterface(port, "cdp");
  }

  /** `lldp transmit` / `no lldp transmit`. */
  setInterfaceLldpTransmit(port: string, enabled: boolean): void {
    this.updateInterface(port, (current) => ({ ...current, lldpTransmit: enabled }), !enabled ? "lldp" : undefined);
  }

  /** `lldp receive` / `no lldp receive`. */
  setInterfaceLldpReceive(port: string, enabled: boolean): void {
    this.updateInterface(port, (current) => ({ ...current, lldpReceive: enabled }));
    if (!enabled) this.purgeInterface(port, "lldp");
  }

  private updateInterface(
    port: string,
    update: (current: DiscoveryInterfaceConfiguration) => DiscoveryInterfaceConfiguration,
    withdrawProtocol?: DiscoveryProtocol,
  ): void {
    if (!this.host.discoveryInterfaceIds().includes(port)) {
      throw new ControlProtocolConfigurationError(`Unknown interface '${port}'`, "interface");
    }
    // Tell the neighbour before we go quiet, so its table clears immediately.
    if (withdrawProtocol) this.withdrawInterface(port, withdrawProtocol);
    this.interfaceConfig.set(port, update(this.interfaceConfigurationOf(port)));
    this.arm();
  }

  interfaceConfigurationOf(port: string): DiscoveryInterfaceConfiguration {
    return this.interfaceConfig.get(port) ?? DEFAULT_INTERFACE_CONFIGURATION;
  }

  /** Persistent configuration only; the neighbour table is never included. */
  configuration(): DiscoveryConfiguration {
    return {
      cdpEnabled: this.cdpEnabled,
      lldpEnabled: this.lldpEnabled,
      cdpIntervalNs: this.cdpIntervalNs,
      cdpHoldTimeNs: this.cdpHoldTimeNs,
      lldpIntervalNs: this.lldpIntervalNs,
      lldpHoldTimeNs: this.lldpHoldTimeNs,
      interfaces: [...this.interfaceConfig.entries()]
        .filter(([, configuration]) => configuration.cdpEnabled !== true
          || configuration.lldpTransmit !== true
          || configuration.lldpReceive !== true)
        .map(([id, configuration]) => ({ id, configuration: { ...configuration } }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  // --- runtime ------------------------------------------------------------

  neighborTable(): DiscoveryNeighbor[] {
    this.pruneExpired();
    return [...this.neighbors.values()]
      .map((neighbor) => ({ ...neighbor }))
      .sort((a, b) =>
        a.protocol.localeCompare(b.protocol)
        || a.localInterface.localeCompare(b.localInterface)
        || a.deviceId.localeCompare(b.deviceId)
        || a.remoteInterface.localeCompare(b.remoteInterface));
  }

  interfaceStatuses(): DiscoveryInterfaceStatus[] {
    return this.host.discoveryInterfaceIds().map((id) => {
      const configuration = this.interfaceConfigurationOf(id);
      return {
        id,
        operationalUp: this.host.discoveryInterfaceOperationalUp(id),
        cdpEnabled: this.cdpEnabled && configuration.cdpEnabled,
        lldpTransmit: this.lldpEnabled && configuration.lldpTransmit,
        lldpReceive: this.lldpEnabled && configuration.lldpReceive,
      };
    });
  }

  /** `clear cdp table` / `clear lldp table`: a runtime action, not a change. */
  clearNeighbors(protocol?: DiscoveryProtocol): number {
    let cleared = 0;
    for (const [key, neighbor] of [...this.neighbors]) {
      if (protocol !== undefined && neighbor.protocol !== protocol) continue;
      this.neighbors.delete(key);
      cleared++;
    }
    return cleared;
  }

  resetRuntime(): void {
    this.neighbors.clear();
    this.activity.resetBudget();
    this.arm();
  }

  /**
   * A local port that goes operationally down clears the neighbours learned on
   * it at once: the local link state is authoritative and more useful in a lab
   * than waiting out the hold time. Entries otherwise age out normally.
   */
  onPortStateChanged(port: string): void {
    if (!this.enabled) return;
    if (!this.host.discoveryInterfaceOperationalUp(port)) {
      this.purgeInterface(port);
    }
    this.arm();
  }

  get enabled(): boolean {
    return this.cdpEnabled || this.lldpEnabled;
  }

  get active(): boolean {
    return this.activity.active;
  }

  arm(): void {
    if (!this.enabled) return;
    this.activity.arm();
  }

  private tick(): void {
    this.pruneExpired();
    this.advertise();
  }

  /**
   * Neighbours age lazily, exactly like the forwarding database: an entry is
   * dropped the first time it is read after its hold time has passed. Ageing
   * therefore needs no scheduled event, so it can never keep a bounded Auto run
   * alive, can never age a table out in the middle of that same run, and can
   * never wake two neighbours into an endless advertise/expire cycle. Advancing
   * virtual time past the hold time still expires the entry, which is what a
   * lab wants to demonstrate.
   */
  private pruneExpired(): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    const now = engine.now();
    for (const [key, neighbor] of [...this.neighbors]) {
      if (now < neighbor.expiresAtNs) continue;
      this.neighbors.delete(key);
      this.trace(neighbor.protocol === "cdp" ? "cdp-neighbor-expired" : "lldp-neighbor-expired", {
        interface: neighbor.localInterface,
        deviceId: neighbor.deviceId,
        remoteInterface: neighbor.remoteInterface,
        holdTimeNs: neighbor.holdTimeNs,
        lastSeenNs: neighbor.lastSeenNs,
        reason: "hold time expired",
      });
    }
  }

  // --- advertising --------------------------------------------------------

  private advertise(): void {
    for (const port of this.host.discoveryInterfaceIds()) {
      if (!this.host.discoveryInterfaceOperationalUp(port)) continue;
      const configuration = this.interfaceConfigurationOf(port);
      if (this.cdpEnabled && configuration.cdpEnabled) this.sendCdp(port, this.cdpHoldTimeNs);
      if (this.lldpEnabled && configuration.lldpTransmit) this.sendLldp(port, this.lldpHoldTimeNs);
    }
  }

  /** Explicit shutdown notification: hold time / TTL zero clears the peer now. */
  private withdraw(protocol: DiscoveryProtocol): void {
    for (const port of this.host.discoveryInterfaceIds()) this.withdrawInterface(port, protocol);
  }

  private withdrawInterface(port: string, protocol: DiscoveryProtocol): void {
    if (!this.host.discoveryInterfaceOperationalUp(port)) return;
    const configuration = this.interfaceConfigurationOf(port);
    if (protocol === "cdp" && this.cdpEnabled && configuration.cdpEnabled) this.sendCdp(port, 0);
    if (protocol === "lldp" && this.lldpEnabled && configuration.lldpTransmit) this.sendLldp(port, 0);
  }

  private sendCdp(port: string, holdTimeNs: number): void {
    this.charge();
    const packet: CdpPacket = {
      kind: "cdp",
      version: 2,
      deviceId: this.host.name,
      portId: port,
      platform: this.host.discoveryPlatform(),
      capabilities: [...this.host.discoveryCapabilities()],
      softwareVersion: SIMULATORNET_SOFTWARE,
      managementAddress: this.host.discoveryManagementAddress(),
      nativeVlan: this.host.discoveryNativeVlan(port),
      holdTimeNs,
    };
    this.trace("cdp-advertisement-sent", {
      interface: port,
      deviceId: packet.deviceId,
      holdTimeNs,
      withdrawal: holdTimeNs <= 0,
    });
    this.host.discoverySend(port, packet);
  }

  private sendLldp(port: string, ttlNs: number): void {
    this.charge();
    const packet: LldpPacket = {
      kind: "lldp",
      chassisId: this.host.discoveryChassisId(),
      portId: port,
      portDescription: this.host.discoveryPortDescription(port),
      systemName: this.host.name,
      systemDescription: `${this.host.discoveryPlatform()} — ${SIMULATORNET_SOFTWARE}`,
      capabilities: [...this.host.discoveryCapabilities()],
      managementAddress: this.host.discoveryManagementAddress(),
      ttlNs,
    };
    this.trace("lldp-advertisement-sent", {
      interface: port,
      systemName: packet.systemName,
      ttlNs,
      withdrawal: ttlNs <= 0,
    });
    this.host.discoverySend(port, packet);
  }

  // --- reception ----------------------------------------------------------

  onCdp(packet: CdpPacket, port: string): void {
    if (!this.cdpEnabled) return;
    if (!this.interfaceConfigurationOf(port).cdpEnabled) return;
    this.charge();
    this.trace("cdp-advertisement-received", {
      interface: port,
      deviceId: packet.deviceId,
      remoteInterface: packet.portId,
      platform: packet.platform,
    });
    if (isDiscoveryWithdrawal(packet)) {
      this.remove("cdp", port, packet.deviceId, packet.portId, "withdrawn");
      return;
    }
    this.record({
      protocol: "cdp",
      localInterface: port,
      deviceId: packet.deviceId,
      remoteInterface: packet.portId,
      platform: packet.platform,
      capabilities: packet.capabilities,
      managementAddress: packet.managementAddress,
      softwareVersion: packet.softwareVersion,
      nativeVlan: packet.nativeVlan,
      holdTimeNs: packet.holdTimeNs,
    });
  }

  onLldp(packet: LldpPacket, port: string): void {
    if (!this.lldpEnabled) return;
    if (!this.interfaceConfigurationOf(port).lldpReceive) return;
    this.charge();
    this.trace("lldp-advertisement-received", {
      interface: port,
      systemName: packet.systemName,
      remoteInterface: packet.portId,
      chassisId: packet.chassisId,
    });
    if (isDiscoveryWithdrawal(packet)) {
      this.remove("lldp", port, packet.systemName, packet.portId, "withdrawn");
      return;
    }
    this.record({
      protocol: "lldp",
      localInterface: port,
      deviceId: packet.systemName,
      remoteInterface: packet.portId,
      platform: packet.systemDescription,
      capabilities: packet.capabilities,
      managementAddress: packet.managementAddress,
      systemDescription: packet.systemDescription,
      portDescription: packet.portDescription,
      holdTimeNs: packet.ttlNs,
    });
  }

  private record(input: Omit<DiscoveryNeighbor, "firstSeenNs" | "lastSeenNs" | "expiresAtNs">): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    const now = engine.now();
    const key = neighborKey(input.protocol, input.localInterface, input.deviceId, input.remoteInterface);
    const existing = this.neighbors.get(key);
    if (existing) {
      // Refreshing an entry must never create a duplicate row.
      existing.lastSeenNs = now;
      existing.expiresAtNs = now + input.holdTimeNs;
      return;
    }
    enforceStructuralLimit("maximumDiscoveryNeighborsPerDevice", this.neighbors.size + 1);
    const neighbor: MutableNeighbor = {
      ...input,
      capabilities: [...input.capabilities],
      firstSeenNs: now,
      lastSeenNs: now,
      expiresAtNs: now + input.holdTimeNs,
    };
    this.neighbors.set(key, neighbor);
    this.trace(input.protocol === "cdp" ? "cdp-neighbor-added" : "lldp-neighbor-added", {
      interface: input.localInterface,
      deviceId: input.deviceId,
      remoteInterface: input.remoteInterface,
      platform: input.platform,
      managementAddress: input.managementAddress ?? null,
      holdTimeNs: input.holdTimeNs,
    });
    this.arm();
  }

  private remove(
    protocol: DiscoveryProtocol,
    port: string,
    deviceId: string,
    remoteInterface: string,
    reason: string,
  ): void {
    const key = neighborKey(protocol, port, deviceId, remoteInterface);
    const neighbor = this.neighbors.get(key);
    if (!neighbor) return;
    this.neighbors.delete(key);
    this.trace(protocol === "cdp" ? "cdp-neighbor-expired" : "lldp-neighbor-expired", {
      interface: port,
      deviceId,
      remoteInterface,
      reason,
    });
  }

  private purgeInterface(port: string, protocol?: DiscoveryProtocol): void {
    for (const [key, neighbor] of [...this.neighbors]) {
      if (neighbor.localInterface !== port) continue;
      if (protocol !== undefined && neighbor.protocol !== protocol) continue;
      this.neighbors.delete(key);
      this.trace(neighbor.protocol === "cdp" ? "cdp-neighbor-expired" : "lldp-neighbor-expired", {
        interface: port,
        deviceId: neighbor.deviceId,
        remoteInterface: neighbor.remoteInterface,
        reason: "local interface down",
      });
    }
  }

  private purgeProtocol(protocol: DiscoveryProtocol): void {
    for (const [key, neighbor] of [...this.neighbors]) {
      if (neighbor.protocol === protocol) this.neighbors.delete(key);
    }
  }

  // --- helpers ------------------------------------------------------------

  private engineOrUndefined(): SimulationEngine | undefined {
    return (this.host as { engine?: SimulationEngine }).engine;
  }

  private charge(): void {
    this.engineOrUndefined()?.controlProtocolBudget.consume("discoveryAdvertisements");
  }

  private trace(type: string, detail: Record<string, unknown>): void {
    const engine = this.engineOrUndefined();
    if (!engine) return;
    engine.trace({ time: engine.now(), type, device: this.host.id, detail });
  }
}

function neighborKey(
  protocol: DiscoveryProtocol,
  localInterface: string,
  deviceId: string,
  remoteInterface: string,
): string {
  return [protocol, localInterface, deviceId, remoteInterface].join(" ");
}
