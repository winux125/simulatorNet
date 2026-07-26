import type { EthernetInterface } from "../net/interface";
import type { BpduPacket } from "../packets/bpdu";
import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import { EtherType } from "@sim/contracts";
import {
  SpanningTree,
  type SpanningTreeLogicalPort,
  type SpanningTreeMode,
  type SpanningTreeSummary,
} from "../protocols/spanning-tree";
import { isBroadcastMac, type Mac, normalizeMac, PVST_BPDU_MAC } from "../util/mac";
import { Device } from "./device";
import { ForwardingDatabase } from "./forwarding-database";

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
  /** Forwarding database keyed per VLAN, so one MAC can live in several VLANs. */
  private readonly fdb = new ForwardingDatabase<number>();
  private readonly portConfig = new Map<string, SwitchPortConfig>();
  /** The VLAN database (`vlan <id>` / `name <name>`); VLAN 1 always exists. */
  private readonly vlans = new Map<number, VlanInfo>([[DEFAULT_VLAN, { id: DEFAULT_VLAN, name: "default" }]]);

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
    this.spanningTree.onPortStateChanged(this.logicalPortOf(iface.name));
  }

  /** Logical STP/forwarding port for a physical interface; a bundle overrides it. */
  logicalPortOf(port: string): string {
    return port;
  }

  /** Physical interfaces behind a logical port; a bundle overrides it. */
  physicalPortsOf(logicalPort: string): EthernetInterface[] {
    const iface = this.interfaces.get(logicalPort);
    return iface ? [iface] : [];
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
    for (const name of this.interfaces.keys()) {
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
    for (const name of this.interfaces.keys()) {
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
      const cfg = this.portConfigOf(name);
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

  /** The effective config for a port; unconfigured ports are access VLAN 1. */
  portConfigOf(port: string): SwitchPortConfig {
    return (
      this.portConfig.get(port) ?? {
        mode: "access",
        accessVlan: DEFAULT_VLAN,
        nativeVlan: DEFAULT_VLAN,
      }
    );
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
    const entry = { port: ingress.name, vlan, learnedAt: this.engine.now() };
    this.macTable.set(src, entry);
    this.fdb.learn(vlan, src, ingress.name, this.engine.now());
    this.engine.trace({
      time: this.engine.now(),
      type: "mac-learn",
      device: this.id,
      detail: { mac: src, port: ingress.name, vlan },
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

    const egress = this.interfaces.get(dstEntry.port);
    if (!egress || egress === ingress) return; // same-port destination: drop
    if (!this.portCarriesVlan(egress.name, vlan)) return;
    if (!this.egressAllowedBySpanningTree(egress.name, vlan)) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "forward",
      device: this.id,
      detail: { dst, port: egress.name, vlan },
    });
    egress.transmit(this.egressFrame(egress.name, vlan, frame));
  }

  /** Dispatch a link-local control payload to the matching control plane. */
  protected receiveControlFrame(frame: EthernetFrame, ingress: EthernetInterface): void {
    if (frame.payload.kind === "bpdu") {
      this.spanningTree.onBpdu(frame.payload, this.logicalPortOf(ingress.name));
    }
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
    for (const iface of this.interfaces.values()) {
      if (iface === ingress) continue;
      if (!this.switchingEnabledOnPort(iface.name)) continue;
      if (!iface.operationalUp) continue;
      if (!this.portCarriesVlan(iface.name, vlan)) continue;
      if (!this.egressAllowedBySpanningTree(iface.name, vlan)) continue;
      iface.transmit(this.egressFrame(iface.name, vlan, frame));
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

  protected switchingEnabledOnPort(_port: string): boolean {
    return true;
  }

  /** Hook for a local control/L3 plane. Broadcasts may be consumed and flooded. */
  protected receiveLocal(_frame: EthernetFrame, _ingress: EthernetInterface, _vlan: number): boolean {
    return false;
  }

  protected transmitFromLocal(frame: EthernetFrame, vlan: number): void {
    const destination = normalizeMac(frame.dst);
    const learned = isBroadcastMac(destination) ? undefined : this.fdb.lookup(vlan, destination, this.engine.now());
    const egress = learned ? this.interfaces.get(learned.port) : undefined;
    if (egress?.operationalUp
      && this.portCarriesVlan(egress.name, vlan)
      && this.egressAllowedBySpanningTree(egress.name, vlan)) {
      egress.transmit(this.egressFrame(egress.name, vlan, frame));
      return;
    }
    this.flood(frame, vlan);
  }
}
