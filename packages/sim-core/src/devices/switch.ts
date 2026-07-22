import type { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import { isBroadcastMac, type Mac, normalizeMac } from "../util/mac";
import { Device } from "./device";

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
 * access port. STP is not modelled yet — topologies must be loop-free.
 */
export class L2Switch extends Device {
  /** Last-seen location of each MAC (for inspection / `show mac address-table`). */
  readonly macTable = new Map<Mac, MacTableEntry>();
  /** Forwarding database keyed per VLAN, so one MAC can live in several VLANs. */
  private readonly fdb = new Map<string, MacTableEntry>();
  private readonly portConfig = new Map<string, SwitchPortConfig>();
  /** The VLAN database (`vlan <id>` / `name <name>`); VLAN 1 always exists. */
  private readonly vlans = new Map<number, VlanInfo>([[DEFAULT_VLAN, { id: DEFAULT_VLAN, name: "default" }]]);

  // --- configuration (public API called by the CLI) ----------------------

  /** `vlan <id>`: create the VLAN in the database if absent. */
  defineVlan(id: number): void {
    if (!this.vlans.has(id)) this.vlans.set(id, { id, name: defaultVlanName(id) });
  }

  /** `name <name>` inside `vlan <id>` configuration. */
  setVlanName(id: number, name: string): void {
    this.defineVlan(id);
    this.vlans.get(id)!.name = name;
  }

  /** `switchport mode access`. */
  setPortModeAccess(port: string): void {
    this.ensureConfig(port).mode = "access";
  }

  /** `switchport mode trunk`. */
  setPortModeTrunk(port: string): void {
    this.ensureConfig(port).mode = "trunk";
  }

  /** `switchport access vlan <id>`. */
  setAccessVlan(port: string, vlan: number): void {
    this.defineVlan(vlan);
    this.ensureConfig(port).accessVlan = vlan;
  }

  /** `switchport trunk native vlan <id>`. */
  setTrunkNativeVlan(port: string, vlan: number): void {
    this.ensureConfig(port).nativeVlan = vlan;
  }

  /** `switchport trunk allowed vlan <list>`. */
  setTrunkAllowedVlans(port: string, vlans: Iterable<number>): void {
    this.ensureConfig(port).allowedVlans = new Set(vlans);
  }

  /** Convenience: configure an access port in one call. */
  setAccess(port: string, vlan: number): void {
    this.defineVlan(vlan);
    this.portConfig.set(port, { mode: "access", accessVlan: vlan, nativeVlan: DEFAULT_VLAN });
  }

  /** Convenience: configure an 802.1Q trunk in one call. */
  setTrunk(port: string, opts: { nativeVlan?: number; allowedVlans?: Iterable<number> } = {}): void {
    this.portConfig.set(port, {
      mode: "trunk",
      accessVlan: DEFAULT_VLAN,
      nativeVlan: opts.nativeVlan ?? DEFAULT_VLAN,
      allowedVlans: opts.allowedVlans ? new Set(opts.allowedVlans) : undefined,
    });
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
    for (const [key, entry] of this.fdb) {
      // The composite key is `${vlan} ${mac}` — recover the MAC after the space.
      const mac = key.slice(key.indexOf(" ") + 1);
      rows.push({ vlan: entry.vlan, mac, port: entry.port });
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
    const vlan = this.ingressVlan(ingress.name, frame);
    if (vlan === undefined) return; // frame not permitted on this port: drop

    const src = normalizeMac(frame.src);
    const entry = { port: ingress.name, vlan, learnedAt: this.engine.now() };
    this.macTable.set(src, entry);
    this.fdb.set(fdbKey(vlan, src), entry);
    this.engine.trace({
      time: this.engine.now(),
      type: "mac-learn",
      device: this.id,
      detail: { mac: src, port: ingress.name, vlan },
    });

    const dst = normalizeMac(frame.dst);
    const dstEntry = isBroadcastMac(dst) ? undefined : this.fdb.get(fdbKey(vlan, dst));

    // Flood when broadcast or the destination is unknown within this VLAN.
    if (!dstEntry) {
      this.flood(frame, vlan, ingress);
      return;
    }

    const egress = this.interfaces.get(dstEntry.port);
    if (!egress || egress === ingress) return; // same-port destination: drop
    if (!this.portCarriesVlan(egress.name, vlan)) return;
    this.engine.trace({
      time: this.engine.now(),
      type: "forward",
      device: this.id,
      detail: { dst, port: egress.name, vlan },
    });
    egress.transmit(this.egressFrame(egress.name, vlan, frame));
  }

  private flood(frame: EthernetFrame, vlan: number, ingress: EthernetInterface): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "flood",
      device: this.id,
      detail: { dst: normalizeMac(frame.dst), vlan },
    });
    for (const iface of this.interfaces.values()) {
      if (iface === ingress) continue;
      if (!iface.operationalUp) continue;
      if (!this.portCarriesVlan(iface.name, vlan)) continue;
      iface.transmit(this.egressFrame(iface.name, vlan, frame));
    }
  }

  /** The VLAN a frame belongs to on ingress, or `undefined` if it must be dropped. */
  private ingressVlan(port: string, frame: EthernetFrame): number | undefined {
    const cfg = this.portConfigOf(port);
    if (cfg.mode === "access") {
      // Access ports expect untagged traffic; a foreign tag is dropped.
      if (frame.vlan !== undefined && frame.vlan !== cfg.accessVlan) return undefined;
      return cfg.accessVlan;
    }
    const vlan = frame.vlan ?? cfg.nativeVlan;
    return this.trunkAllows(cfg, vlan) ? vlan : undefined;
  }

  private portCarriesVlan(port: string, vlan: number): boolean {
    const cfg = this.portConfigOf(port);
    return cfg.mode === "access" ? cfg.accessVlan === vlan : this.trunkAllows(cfg, vlan);
  }

  private trunkAllows(cfg: SwitchPortConfig, vlan: number): boolean {
    return cfg.allowedVlans === undefined || cfg.allowedVlans.has(vlan);
  }

  /** Re-tag a frame for egress on `port`: untagged on access / native, else tagged. */
  private egressFrame(port: string, vlan: number, frame: EthernetFrame): EthernetFrame {
    const cfg = this.portConfigOf(port);
    const tagged = cfg.mode === "trunk" && vlan !== cfg.nativeVlan;
    if (tagged) {
      return frame.vlan === vlan ? frame : { ...frame, vlan };
    }
    return frame.vlan === undefined ? frame : { ...frame, vlan: undefined };
  }
}

/** Composite key so the forwarding database is scoped per VLAN. */
function fdbKey(vlan: number, mac: Mac): string {
  return `${vlan} ${mac}`;
}
