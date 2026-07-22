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

  /** Configure a port as an access port in `vlan`. */
  setAccess(port: string, vlan: number): void {
    this.portConfig.set(port, { mode: "access", accessVlan: vlan, nativeVlan: DEFAULT_VLAN });
  }

  /** Configure a port as an 802.1Q trunk. */
  setTrunk(port: string, opts: { nativeVlan?: number; allowedVlans?: Iterable<number> } = {}): void {
    this.portConfig.set(port, {
      mode: "trunk",
      accessVlan: DEFAULT_VLAN,
      nativeVlan: opts.nativeVlan ?? DEFAULT_VLAN,
      allowedVlans: opts.allowedVlans ? new Set(opts.allowedVlans) : undefined,
    });
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
