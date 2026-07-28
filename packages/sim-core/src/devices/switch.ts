import type { EthernetInterface } from "../net/interface";
import type { BpduPacket } from "../packets/bpdu";
import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import type { CdpPacket, DiscoveryCapability, LldpPacket } from "../packets/discovery";
import type { LacpPacket, PagpPacket } from "../packets/etherchannel";
import { EtherType } from "@sim/contracts";
import { discoveryCapabilitiesFor, discoveryPlatformFor, supportsCdp } from "../protocols/discovery-support";
import { NeighborDiscovery } from "../protocols/neighbor-discovery";
import {
  EtherChannelStack,
  type EtherChannelConfiguration,
  type EtherChannelMode,
  type EtherChannelSummary,
  parsePortChannelName,
  portChannelName,
} from "../protocols/etherchannel";
import {
  SpanningTree,
  type SpanningTreeLogicalPort,
  type SpanningTreeMode,
  type SpanningTreeSummary,
} from "../protocols/spanning-tree";
import {
  CISCO_SHARED_MAC,
  isBroadcastMac,
  LLDP_MAC,
  type Mac,
  normalizeMac,
  PVST_BPDU_MAC,
  SLOW_PROTOCOL_MAC,
} from "../util/mac";
import type { HostTransportStack } from "../transport/host-transport";
import type { IpAddress } from "../util/ip-address";
import type { Ipv4 } from "../util/ipv4";
import { RemoteAccessState } from "../management/remote-access-state";
import { Device } from "./device";
import { ForwardingDatabase } from "./forwarding-database";
import { ManagementSviPlane, type ManagementSviRow } from "./management-svi";

export const DEFAULT_VLAN = 1;

export type SwitchPortMode = "access" | "trunk";

export interface SwitchPortConfig {
  mode: SwitchPortMode;
  /** VLAN of untagged traffic on an access port. */
  accessVlan: number;
  /** VLAN carried untagged over a trunk. */
  nativeVlan: number;
  /** Trunk-allowed VLAN set; `undefined` means "all VLANs allowed". */
  allowedVlans?: Set<number>;
}

export interface MacTableEntry {
  port: string;
  vlan: number;
  learnedAt: number;
}

export interface VlanInfo {
  id: number;
  name: string;
}

/** A row of `show vlan brief`: a VLAN and the access ports assigned to it. */
export interface VlanBriefRow extends VlanInfo {
  ports: string[];
}

/** A row of `show interfaces trunk`. */
export interface TrunkRow {
  port: string;
  nativeVlan: number;
  /** Allowed VLAN ids, or "all" when every VLAN is permitted. */
  allowedVlans: number[] | "all";
}

/** A row of `show mac address-table`. */
export interface MacAddressRow {
  vlan: number;
  mac: Mac;
  port: string;
}

/** A row of `show interfaces` / port config, used by the CLI formatters. */
export interface SwitchPortRow {
  name: string;
  mode: SwitchPortMode;
  accessVlan: number;
  nativeVlan: number;
  allowedVlans: number[] | "all";
  adminUp: boolean;
  operUp: boolean;
  description: string | undefined;
}

function defaultVlanName(id: number): string {
  return id === DEFAULT_VLAN ? "default" : `VLAN${String(id).padStart(4, "0")}`;
}

/**
 * A learning L2 Ethernet switch with 802.1Q VLAN support.
 *
 * Ports are either **access** (a single untagged VLAN) or **trunk** (many
 * VLANs, tagged except for the native VLAN). On ingress the switch resolves the
 * frame's VLAN, learns the source MAC within that VLAN, then forwards inside the
 * VLAN only: known unicast out the single learned port, broadcast/unknown
 * unicast flooded to every other port that carries the VLAN. Egress framing is
 * re-derived per port, so a frame can leave tagged on a trunk and untagged on an
 * access port.
 *
 * A deterministic PVST/Rapid-PVST spanning tree gates the data plane once it is
 * enabled with `spanning-tree mode`. It is disabled by default so that existing
 * loop-free labs keep forwarding from the first virtual nanosecond; a redundant
 * topology must enable it explicitly, and the frame traversal budget stays as
 * the last-resort protection for labs that deliberately leave it off.
 */
export class L2Switch extends Device {
  readonly deviceType: import("@sim/contracts").DeviceType = "l2-switch";
  /** Last-seen location of each MAC (for inspection / `show mac address-table`). */
  readonly macTable = new Map<Mac, MacTableEntry>();
  /** Deterministic PVST/Rapid-PVST control plane; disabled until configured. */
  readonly spanningTree = new SpanningTree(this);
  /** Layer-2 EtherChannel bundles with static, LACP or PAgP negotiation. */
  readonly etherChannel = new EtherChannelStack(this);
  /** CDP/LLDP neighbour discovery; both start disabled until configured. */
  readonly discovery = new NeighborDiscovery(this, supportsCdp(this.deviceType));
  /** Forwarding database keyed per VLAN, so one MAC can live in several VLANs. */
  private readonly fdb = new ForwardingDatabase<number>();
  private readonly portConfig = new Map<string, SwitchPortConfig>();
  /** The VLAN database (`vlan <id>` / `name <name>`); VLAN 1 always exists. */
  private readonly vlans = new Map<number, VlanInfo>([[DEFAULT_VLAN, { id: DEFAULT_VLAN, name: "default" }]]);
  private managementPlane: ManagementSviPlane | undefined;
  /** Persistent Telnet/SSH/VTY configuration; behaviour lives in the service. */
  readonly remoteAccess = new RemoteAccessState(this.id);

  // --- management SVI ------------------------------------------------------

  /**
   * An L3 switch addresses VLANs through real routed SVIs, so the layer-2
   * management interface does not apply to it.
   */
  protected supportsManagementSvi(): boolean {
    return true;
  }

  /** The composed management plane, created on first use. */
  protected management(): ManagementSviPlane {
    if (!this.supportsManagementSvi()) {
      throw new Error(`${this.deviceType} uses routed SVIs instead of a layer-2 management interface`);
    }
    const plane = this.managementPlane ?? new ManagementSviPlane(
      this,
      (vlanId) => this.hasVlan(vlanId) && [...this.interfaces.values()].some((iface) =>
        iface.operationalUp && this.portCarriesVlan(iface.name, vlanId)),
      (frame, vlanId) => this.transmitFromLocal(frame, vlanId),
    );
    this.managementPlane = plane;
    plane.attach(this.engine);
    return plane;
  }

  /** `interface vlan <id>` on an L2 switch: the single management interface. */
  defineManagementSvi(vlanId: number): void {
    this.defineVlan(vlanId);
    this.management().define(vlanId);
  }

  setManagementSviIp(vlanId: number, ip: Ipv4, mask: Ipv4 | number): void {
    this.defineVlan(vlanId);
    this.management().setIp(vlanId, ip, mask);
  }

  setManagementSviAdminState(vlanId: number, adminUp: boolean): void {
    this.defineManagementSvi(vlanId);
    this.management().setAdminState(vlanId, adminUp);
  }

  setManagementSviDescription(vlanId: number, description: string): void {
    this.defineManagementSvi(vlanId);
    this.management().setDescription(vlanId, description);
  }

  removeManagementSvi(): void {
    this.managementPlane?.remove();
  }

  /** `ip default-gateway <ip>`: host default route for management replies only. */
  setManagementDefaultGateway(gateway: Ipv4 | undefined): void {
    this.management().setDefaultGateway(gateway);
  }

  get managementDefaultGateway(): Ipv4 | undefined {
    return this.managementPlane?.defaultGateway;
  }

  managementSviSummary(): ManagementSviRow | undefined {
    if (!this.managementPlane) return undefined;
    this.management();
    return this.managementPlane.summary();
  }

  /** Sockets the switch's own management services listen on. */
  managementTransport(): HostTransportStack {
    return this.management().transport;
  }

  managementAddresses(): IpAddress[] {
    if (!this.managementPlane) return [];
    this.management();
    return this.managementPlane.managementAddresses();
  }

  get managementArpTable(): ReadonlyMap<Ipv4, string> {
    return this.managementPlane?.arpTable ?? new Map();
  }

  /** `ping` from the switch itself, sourced by the management SVI. */
  managementPing(target: Ipv4, sequence = 0): void {
    this.management().ping(target, sequence);
  }

  managementPingResults(): ReadonlyArray<{ sequence: number; success: boolean; rttNs?: number }> {
    return this.managementPlane?.pingResults ?? [];
  }

  // --- spanning tree ------------------------------------------------------

  setSpanningTreeMode(mode: SpanningTreeMode): void {
    this.spanningTree.setMode(mode);
  }

  get spanningTreeMode(): SpanningTreeMode {
    return this.spanningTree.currentMode;
  }

  spanningTreeSummary(): SpanningTreeSummary {
    return this.spanningTree.summary();
  }

  override onInterfaceStateChanged(iface: EthernetInterface): void {
    this.etherChannel.onPortStateChanged(iface.name);
    this.spanningTree.onPortStateChanged(this.logicalPortOf(iface.name));
    this.discovery.onPortStateChanged(iface.name);
    // A management SVI follows its VLAN: losing the last active member port
    // takes it operationally down and closes whatever it was terminating.
    if (this.managementPlane) this.management().onInterfaceStateChanged();
  }

  override rename(name: string): void {
    super.rename(name);
    this.managementPlane?.rename(name);
  }

  // --- neighbour discovery ------------------------------------------------

  discoveryInterfaceIds(): readonly string[] {
    return [...this.interfaces.keys()];
  }

  discoveryInterfaceOperationalUp(port: string): boolean {
    return this.interfaces.get(port)?.operationalUp === true;
  }

  discoveryChassisId(): Mac {
    return this.spanningTreeBridgeMac();
  }

  discoveryPlatform(): string {
    return discoveryPlatformFor(this.deviceType);
  }

  discoveryCapabilities(): readonly DiscoveryCapability[] {
    return discoveryCapabilitiesFor(this.deviceType);
  }

  discoveryManagementAddress(): string | undefined {
    return undefined;
  }

  discoveryPortDescription(port: string): string | undefined {
    return this.interfaces.get(port)?.description;
  }

  discoveryNativeVlan(port: string): number | undefined {
    const cfg = this.portConfigOf(port);
    return cfg.mode === "trunk" ? cfg.nativeVlan : cfg.accessVlan;
  }

  discoverySend(port: string, payload: CdpPacket | LldpPacket): void {
    const iface = this.interfaces.get(port);
    if (!iface?.operationalUp) return;
    // Discovery is link-local: it leaves untagged and is consumed by the peer,
    // so a spanning-tree blocking port still exchanges it.
    iface.transmit({
      src: iface.mac,
      dst: payload.kind === "cdp" ? CISCO_SHARED_MAC : LLDP_MAC,
      etherType: payload.kind === "cdp" ? EtherType.LLC : EtherType.LLDP,
      payload,
    });
  }

  // --- EtherChannel -------------------------------------------------------

  /** `channel-group <id> mode <mode>` on the selected interface. */
  addChannelGroupMember(channelId: number, port: string, mode: EtherChannelMode): void {
    this.etherChannel.addMember(channelId, port, mode);
  }

  /** `no channel-group` on the selected interface. */
  removeChannelGroupMember(port: string): void {
    this.etherChannel.removeMember(port);
  }

  etherChannelConfigurations(): EtherChannelConfiguration[] {
    return this.etherChannel.configurations();
  }

  etherChannelSummaries(): EtherChannelSummary[] {
    return this.etherChannel.summaries();
  }

  etherChannelSystemId(): Mac {
    return this.spanningTreeBridgeMac();
  }

  etherChannelPortNumber(port: string): number {
    return [...this.interfaces.keys()].sort((a, b) => a.localeCompare(b)).indexOf(port) + 1;
  }

  etherChannelHasPort(port: string): boolean {
    return this.interfaces.has(port);
  }

  etherChannelMemberAdminUp(port: string): boolean {
    return this.interfaces.get(port)?.adminUp === true;
  }

  etherChannelMemberOperationalUp(port: string): boolean {
    return this.interfaces.get(port)?.operationalUp === true;
  }

  /**
   * Every switchport attribute members of one bundle must agree on.
   * Administrative state is deliberately excluded: a shut member simply detaches
   * from the bundle, and including it would make the remaining members look
   * incompatible as soon as the reference port was shut down.
   */
  etherChannelSwitchportSignature(port: string): string {
    const cfg = this.rawPortConfigOf(port);
    const allowed = cfg.allowedVlans ? [...cfg.allowedVlans].sort((a, b) => a - b).join(",") : "all";
    return `${cfg.mode}/access=${cfg.accessVlan}/native=${cfg.nativeVlan}/allowed=${allowed}`;
  }

  etherChannelSwitchportConfigured(port: string): boolean {
    return this.portConfig.has(port);
  }

  etherChannelSend(port: string, payload: LacpPacket | PagpPacket): void {
    const iface = this.interfaces.get(port);
    if (!iface?.operationalUp) return;
    iface.transmit({
      src: iface.mac,
      dst: payload.kind === "lacp" ? SLOW_PROTOCOL_MAC : CISCO_SHARED_MAC,
      etherType: EtherType.LLC,
      payload,
    });
  }

  etherChannelTopologyChanged(): void {
    this.spanningTree.arm();
  }

  /** Logical STP/forwarding port for a physical interface. */
  logicalPortOf(port: string): string {
    const channelId = this.etherChannel.channelOf(port);
    return channelId === undefined ? port : portChannelName(channelId);
  }

  /** Physical interfaces currently behind a logical port. */
  physicalPortsOf(logicalPort: string): EthernetInterface[] {
    const direct = this.interfaces.get(logicalPort);
    if (direct) return [direct];
    const channelId = parsePortChannelName(logicalPort);
    if (channelId === undefined) return [];
    return this.etherChannel.activeMembers(channelId)
      .flatMap((port) => {
        const iface = this.interfaces.get(port);
        return iface ? [iface] : [];
      });
  }

  /**
   * Stable per-flow key. Only fields the engine actually models take part, so
   * every frame of one conversation always leaves through the same member.
   */
  protected flowKeyOf(frame: EthernetFrame): string {
    const parts = [normalizeMac(frame.src), normalizeMac(frame.dst)];
    if (frame.payload.kind === "ipv4") parts.push(frame.payload.src, frame.payload.dst);
    return parts.join("|");
  }

  /** Which physical interface actually carries a frame out of a logical port. */
  protected egressInterfaceFor(logicalPort: string, frame: EthernetFrame): EthernetInterface | undefined {
    const direct = this.interfaces.get(logicalPort);
    if (direct) return direct;
    const channelId = parsePortChannelName(logicalPort);
    if (channelId === undefined) return undefined;
    const member = this.etherChannel.selectMember(channelId, this.flowKeyOf(frame));
    if (member === undefined) return undefined;
    this.engine.trace({
      time: this.engine.now(),
      type: "etherchannel-frame-member-selected",
      device: this.id,
      detail: { channel: channelId, port: logicalPort, interface: member, flow: this.flowKeyOf(frame) },
    });
    return this.interfaces.get(member);
  }

  /** Deduplicated logical egress ports, preserving stable interface order. */
  protected egressLogicalPorts(): string[] {
    const ports: string[] = [];
    const seen = new Set<string>();
    for (const name of this.interfaces.keys()) {
      if (!this.switchingEnabledOnPort(name)) continue;
      const logical = this.logicalPortOf(name);
      if (seen.has(logical)) continue;
      seen.add(logical);
      ports.push(logical);
    }
    return ports;
  }

  spanningTreeBridgeMac(): Mac {
    let lowest: Mac | undefined;
    for (const iface of this.interfaces.values()) {
      const mac = normalizeMac(iface.mac);
      if (lowest === undefined || mac.localeCompare(lowest) < 0) lowest = mac;
    }
    return lowest ?? "00:00:00:00:00:00";
  }

  spanningTreeLogicalPorts(): readonly SpanningTreeLogicalPort[] {
    const names = [...this.interfaces.keys()].sort((a, b) => a.localeCompare(b));
    const ports: SpanningTreeLogicalPort[] = [];
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (!this.switchingEnabledOnPort(name)) return;
      const logical = this.logicalPortOf(name);
      if (seen.has(logical)) return;
      seen.add(logical);
      ports.push({
        // A bundle is one logical port: STP must never run an independent
        // instance per member, or the bundle would look like a loop.
        id: logical,
        number: index + 1,
        adminUp: this.logicalPortAdminUp(logical),
        operationalUp: this.logicalPortOperationalUp(logical),
        vlans: this.vlansCarriedBy(logical),
        pointToPoint: true,
      });
    });
    return ports;
  }

  spanningTreeSendBpdu(logicalPort: string, bpdu: BpduPacket): void {
    const iface = this.bpduEgressInterface(logicalPort);
    if (!iface) return;
    iface.transmit({
      src: iface.mac,
      dst: PVST_BPDU_MAC,
      etherType: EtherType.LLC,
      // PVST-like BPDUs ride the VLAN they describe; VLAN 1 goes untagged.
      vlan: bpdu.vlanId === DEFAULT_VLAN ? undefined : bpdu.vlanId,
      payload: bpdu,
    });
  }

  spanningTreeFlushForwarding(vlanId: number): void {
    this.fdb.clearScope(vlanId);
    for (const [mac, entry] of [...this.macTable]) {
      if (entry.vlan === vlanId) this.macTable.delete(mac);
    }
  }

  /** Which physical interface actually carries a logical port's BPDUs. */
  protected bpduEgressInterface(logicalPort: string): EthernetInterface | undefined {
    return this.physicalPortsOf(logicalPort).find((iface) => iface.operationalUp);
  }

  protected logicalPortAdminUp(logicalPort: string): boolean {
    return this.physicalPortsOf(logicalPort).some((iface) => iface.adminUp);
  }

  protected logicalPortOperationalUp(logicalPort: string): boolean {
    return this.physicalPortsOf(logicalPort).some((iface) => iface.operationalUp);
  }

  /** Every VLAN a logical port participates in, used to size STP instances. */
  protected vlansCarriedBy(logicalPort: string): number[] {
    const cfg = this.portConfigOf(logicalPort);
    if (cfg.mode === "access") return [cfg.accessVlan];
    const database = [...this.vlans.keys()];
    const allowed = cfg.allowedVlans ? database.filter((vlan) => cfg.allowedVlans!.has(vlan)) : database;
    const withNative = new Set(allowed);
    if (cfg.allowedVlans === undefined || cfg.allowedVlans.has(cfg.nativeVlan)) withNative.add(cfg.nativeVlan);
    return [...withNative].sort((a, b) => a - b);
  }

  // --- configuration (public API called by the CLI) ----------------------

  /** VLAN membership or port mode changed: let the spanning tree reconverge. */
  protected switchportChanged(): void {
    this.spanningTree.arm();
  }

  /** `vlan <id>`: create the VLAN in the database if absent. */
  defineVlan(id: number): void {
    if (this.vlans.has(id)) return;
    this.vlans.set(id, { id, name: defaultVlanName(id) });
    this.switchportChanged();
  }

  hasVlan(id: number): boolean {
    return this.vlans.has(id);
  }

  /** `name <name>` inside `vlan <id>` configuration. */
  setVlanName(id: number, name: string): void {
    this.defineVlan(id);
    this.vlans.get(id)!.name = name;
  }

  /** `switchport mode access`. */
  setPortModeAccess(port: string): void {
    this.ensureConfig(port).mode = "access";
    this.switchportChanged();
  }

  /** `switchport mode trunk`. */
  setPortModeTrunk(port: string): void {
    this.ensureConfig(port).mode = "trunk";
    this.switchportChanged();
  }

  /** `switchport access vlan <id>`. */
  setAccessVlan(port: string, vlan: number): void {
    this.defineVlan(vlan);
    this.ensureConfig(port).accessVlan = vlan;
    this.switchportChanged();
  }

  /** `switchport trunk native vlan <id>`. */
  setTrunkNativeVlan(port: string, vlan: number): void {
    this.ensureConfig(port).nativeVlan = vlan;
    this.switchportChanged();
  }

  /** `switchport trunk allowed vlan <list>`. */
  setTrunkAllowedVlans(port: string, vlans: Iterable<number>): void {
    this.ensureConfig(port).allowedVlans = new Set(vlans);
    this.switchportChanged();
  }

  /** Convenience: configure an access port in one call. */
  setAccess(port: string, vlan: number): void {
    this.defineVlan(vlan);
    this.portConfig.set(port, { mode: "access", accessVlan: vlan, nativeVlan: DEFAULT_VLAN });
    this.switchportChanged();
  }

  /** Convenience: configure an 802.1Q trunk in one call. */
  setTrunk(port: string, opts: { nativeVlan?: number; allowedVlans?: Iterable<number> } = {}): void {
    this.portConfig.set(port, {
      mode: "trunk",
      accessVlan: DEFAULT_VLAN,
      nativeVlan: opts.nativeVlan ?? DEFAULT_VLAN,
      allowedVlans: opts.allowedVlans ? new Set(opts.allowedVlans) : undefined,
    });
    this.switchportChanged();
  }

  private ensureConfig(port: string): SwitchPortConfig {
    let cfg = this.portConfig.get(port);
    if (!cfg) {
      cfg = { mode: "access", accessVlan: DEFAULT_VLAN, nativeVlan: DEFAULT_VLAN };
      this.portConfig.set(port, cfg);
    }
    return cfg;
  }

  // --- inspection (public API for the CLI `show` formatters) -------------

  /** `show vlan brief`: every VLAN with its assigned access ports, id-ordered. */
  vlanBrief(): VlanBriefRow[] {
    const rows = new Map<number, VlanBriefRow>();
    for (const info of this.vlans.values()) {
      rows.set(info.id, { id: info.id, name: info.name, ports: [] });
    }
    // Bundled members are represented by their Port-channel, as on a real switch.
    for (const name of this.egressLogicalPorts()) {
      const cfg = this.portConfigOf(name);
      if (cfg.mode !== "access") continue; // trunk ports are not listed under a VLAN
      let row = rows.get(cfg.accessVlan);
      if (!row) {
        row = { id: cfg.accessVlan, name: defaultVlanName(cfg.accessVlan), ports: [] };
        rows.set(cfg.accessVlan, row);
      }
      row.ports.push(name);
    }
    return [...rows.values()].sort((a, b) => a.id - b.id);
  }

  /** Persistent VLAN database, excluding the runtime forwarding table. */
  vlanDefinitions(): VlanInfo[] {
    return [...this.vlans.values()]
      .map((vlan) => ({ ...vlan }))
      .sort((a, b) => a.id - b.id);
  }

  /** `show interfaces trunk`: the trunk ports and their VLAN scope. */
  trunkSummary(): TrunkRow[] {
    const rows: TrunkRow[] = [];
    for (const name of this.egressLogicalPorts()) {
      const cfg = this.portConfigOf(name);
      if (cfg.mode !== "trunk") continue;
      rows.push({
        port: name,
        nativeVlan: cfg.nativeVlan,
        allowedVlans: cfg.allowedVlans ? [...cfg.allowedVlans].sort((a, b) => a - b) : "all",
      });
    }
    return rows;
  }

  /** `show mac address-table`: the learned forwarding entries. */
  macAddressTable(): MacAddressRow[] {
    const rows: MacAddressRow[] = [];
    for (const entry of this.fdb.entries(this.engine.now())) {
      rows.push({ vlan: entry.scope, mac: entry.mac, port: entry.port });
    }
    return rows.sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac));
  }

  /** Per-port configuration + status, for `show interfaces` and running-config. */
  portSummaries(): SwitchPortRow[] {
    const rows: SwitchPortRow[] = [];
    for (const [name, iface] of this.interfaces) {
      // Report what was configured on this port, never the bundle's inherited
      // values, so saving a lab can never rewrite a member's configuration.
      const cfg = this.rawPortConfigOf(name);
      rows.push({
        name,
        mode: cfg.mode,
        accessVlan: cfg.accessVlan,
        nativeVlan: cfg.nativeVlan,
        allowedVlans: cfg.allowedVlans ? [...cfg.allowedVlans].sort((a, b) => a - b) : "all",
        adminUp: iface.adminUp,
        operUp: iface.operationalUp,
        description: iface.description,
      });
    }
    return rows;
  }

  /**
   * The effective config used by the data plane. A member of an EtherChannel
   * inherits the bundle's switchport configuration without its own stored
   * configuration ever being rewritten.
   */
  portConfigOf(port: string): SwitchPortConfig {
    const memberChannel = this.etherChannel.channelOf(port);
    if (memberChannel !== undefined) return this.bundleConfigOf(memberChannel);
    const channelId = parsePortChannelName(port);
    if (channelId !== undefined && this.etherChannel.hasChannel(channelId)) return this.bundleConfigOf(channelId);
    return this.rawPortConfigOf(port);
  }

  /** The configuration stored for this exact port; used by `show` and saving. */
  rawPortConfigOf(port: string): SwitchPortConfig {
    return (
      this.portConfig.get(port) ?? {
        mode: "access",
        accessVlan: DEFAULT_VLAN,
        nativeVlan: DEFAULT_VLAN,
      }
    );
  }

  /**
   * A bundle takes its switchport configuration from the Port-channel
   * interface when one was configured, otherwise from its first member.
   */
  private bundleConfigOf(channelId: number): SwitchPortConfig {
    const logical = portChannelName(channelId);
    if (this.portConfig.has(logical)) return this.rawPortConfigOf(logical);
    const reference = this.etherChannel.configurations()
      .find((channel) => channel.channelId === channelId)?.members[0];
    return this.rawPortConfigOf(reference ?? logical);
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    if (!this.switchingEnabledOnPort(ingress.name)) return;
    // Link-local control frames are consumed here: a blocking port still
    // receives and sends BPDUs, which is exactly how a loop stays broken.
    if (isControlPayload(frame.payload)) {
      this.receiveControlFrame(frame, ingress);
      return;
    }
    const vlan = this.ingressVlan(ingress.name, frame);
    if (vlan === undefined) return; // frame not permitted on this port: drop

    const logical = this.logicalPortOf(ingress.name);
    const stpState = this.spanningTree.portState(logical, vlan);
    if (!this.spanningTree.allowsLearning(logical, vlan)) {
      this.engine.trace({
        time: this.engine.now(),
        type: "stp-frame-blocked",
        device: this.id,
        detail: {
          interface: ingress.name,
          port: logical,
          vlan,
          state: stpState,
          role: this.spanningTree.portRole(logical, vlan),
          direction: "ingress",
        },
      });
      return;
    }

    const src = normalizeMac(frame.src);
    // Addresses are learned against the logical port, so an EtherChannel shows
    // up once in the forwarding database instead of once per member.
    const entry = { port: logical, vlan, learnedAt: this.engine.now() };
    this.macTable.set(src, entry);
    this.fdb.learn(vlan, src, logical, this.engine.now());
    this.engine.trace({
      time: this.engine.now(),
      type: "mac-learn",
      device: this.id,
      detail: { mac: src, port: logical, vlan },
    });

    // Learning state learns addresses but must not yet relay user data.
    if (!this.spanningTree.allowsForwarding(logical, vlan)) {
      this.engine.trace({
        time: this.engine.now(),
        type: "stp-frame-blocked",
        device: this.id,
        detail: { interface: ingress.name, port: logical, vlan, state: stpState, direction: "learning-only" },
      });
      return;
    }

    const dst = normalizeMac(frame.dst);
    const consumed = this.receiveLocal(frame, ingress, vlan);
    const dstEntry = isBroadcastMac(dst) ? undefined : this.fdb.lookup(vlan, dst, this.engine.now());
    if (consumed && !isBroadcastMac(dst)) return;

    // Flood when broadcast or the destination is unknown within this VLAN.
    if (!dstEntry) {
      this.flood(frame, vlan, ingress);
      return;
    }

    const egressLogical = dstEntry.port;
    if (egressLogical === logical) return; // same-port destination: drop
    if (!this.portCarriesVlan(egressLogical, vlan)) return;
    if (!this.egressAllowedBySpanningTree(egressLogical, vlan)) return;
    const egress = this.egressInterfaceFor(egressLogical, frame);
    if (!egress?.operationalUp) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "forward",
      device: this.id,
      detail: { dst, port: egressLogical, interface: egress.name, vlan },
    });
    egress.transmit(this.egressFrame(egressLogical, vlan, frame));
  }

  /** Dispatch a link-local control payload to the matching control plane. */
  protected receiveControlFrame(frame: EthernetFrame, ingress: EthernetInterface): void {
    const payload = frame.payload;
    if (payload.kind === "bpdu") {
      this.spanningTree.onBpdu(payload, this.logicalPortOf(ingress.name));
      return;
    }
    // Negotiation messages belong to the physical member, never to the bundle.
    if (payload.kind === "lacp") this.etherChannel.onLacpdu(payload, ingress.name);
    else if (payload.kind === "pagp") this.etherChannel.onPagp(payload, ingress.name);
    else if (payload.kind === "cdp") this.discovery.onCdp(payload, ingress.name);
    else if (payload.kind === "lldp") this.discovery.onLldp(payload, ingress.name);
  }

  protected egressAllowedBySpanningTree(port: string, vlan: number): boolean {
    const logical = this.logicalPortOf(port);
    if (this.spanningTree.allowsForwarding(logical, vlan)) return true;
    this.engine.trace({
      time: this.engine.now(),
      type: "stp-frame-blocked",
      device: this.id,
      detail: {
        interface: port,
        port: logical,
        vlan,
        state: this.spanningTree.portState(logical, vlan),
        role: this.spanningTree.portRole(logical, vlan),
        direction: "egress",
      },
    });
    return false;
  }

  protected flood(frame: EthernetFrame, vlan: number, ingress?: EthernetInterface): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "flood",
      device: this.id,
      detail: { dst: normalizeMac(frame.dst), vlan },
    });
    const ingressLogical = ingress ? this.logicalPortOf(ingress.name) : undefined;
    for (const logical of this.egressLogicalPorts()) {
      if (logical === ingressLogical) continue;
      if (!this.portCarriesVlan(logical, vlan)) continue;
      if (!this.egressAllowedBySpanningTree(logical, vlan)) continue;
      // One copy per bundle, never one per member.
      const iface = this.egressInterfaceFor(logical, frame);
      if (!iface?.operationalUp) continue;
      iface.transmit(this.egressFrame(logical, vlan, frame));
    }
  }

  /** The VLAN a frame belongs to on ingress, or `undefined` if it must be dropped. */
  protected ingressVlan(port: string, frame: EthernetFrame): number | undefined {
    const cfg = this.portConfigOf(port);
    if (cfg.mode === "access") {
      // Access ports expect untagged traffic; a foreign tag is dropped.
      if (frame.vlan !== undefined && frame.vlan !== cfg.accessVlan) return undefined;
      return cfg.accessVlan;
    }
    const vlan = frame.vlan ?? cfg.nativeVlan;
    return this.trunkAllows(cfg, vlan) ? vlan : undefined;
  }

  portCarriesVlan(port: string, vlan: number): boolean {
    if (!this.switchingEnabledOnPort(port)) return false;
    const cfg = this.portConfigOf(port);
    return cfg.mode === "access" ? cfg.accessVlan === vlan : this.trunkAllows(cfg, vlan);
  }

  private trunkAllows(cfg: SwitchPortConfig, vlan: number): boolean {
    return cfg.allowedVlans === undefined || cfg.allowedVlans.has(vlan);
  }

  /** Re-tag a frame for egress on `port`: untagged on access / native, else tagged. */
  protected egressFrame(port: string, vlan: number, frame: EthernetFrame): EthernetFrame {
    const cfg = this.portConfigOf(port);
    const tagged = cfg.mode === "trunk" && vlan !== cfg.nativeVlan;
    if (tagged) {
      return frame.vlan === vlan ? frame : { ...frame, vlan };
    }
    return frame.vlan === undefined ? frame : { ...frame, vlan: undefined };
  }

  /** A suspended EtherChannel member carries no user data at all. */
  protected switchingEnabledOnPort(port: string): boolean {
    return !this.etherChannel.isSuspended(port);
  }

  /** Hook for a local control/L3 plane. Broadcasts may be consumed and flooded. */
  protected receiveLocal(frame: EthernetFrame, _ingress: EthernetInterface, vlan: number): boolean {
    if (!this.managementPlane) return false;
    this.management();
    return this.managementPlane.receive(frame, vlan);
  }

  protected transmitFromLocal(frame: EthernetFrame, vlan: number): void {
    const destination = normalizeMac(frame.dst);
    const learned = isBroadcastMac(destination) ? undefined : this.fdb.lookup(vlan, destination, this.engine.now());
    if (learned
      && this.portCarriesVlan(learned.port, vlan)
      && this.egressAllowedBySpanningTree(learned.port, vlan)) {
      const egress = this.egressInterfaceFor(learned.port, frame);
      if (egress?.operationalUp) {
        egress.transmit(this.egressFrame(learned.port, vlan, frame));
        return;
      }
    }
    this.flood(frame, vlan);
  }
}
