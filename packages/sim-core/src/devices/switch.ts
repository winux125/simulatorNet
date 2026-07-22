import type { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import { isBroadcastMac, type Mac, normalizeMac } from "../util/mac";
import { Device } from "./device";

export interface MacTableEntry {
  port: string;
  learnedAt: number;
}

/**
 * A learning L2 Ethernet switch.
 *
 * On every received frame it learns the source MAC against the ingress port.
 * It then forwards: known unicast goes out the single learned port; broadcast
 * and unknown-unicast destinations are flooded to every other port. VLANs and
 * STP arrive in the next milestone; this is a single flat broadcast domain.
 */
export class L2Switch extends Device {
  readonly macTable = new Map<Mac, MacTableEntry>();

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    const src = normalizeMac(frame.src);
    this.macTable.set(src, { port: ingress.name, learnedAt: this.engine.now() });
    this.engine.trace({
      time: this.engine.now(),
      type: "mac-learn",
      device: this.id,
      detail: { mac: src, port: ingress.name },
    });

    const dst = normalizeMac(frame.dst);
    if (isBroadcastMac(dst)) {
      this.flood(frame, ingress);
      return;
    }

    const entry = this.macTable.get(dst);
    if (!entry) {
      this.flood(frame, ingress);
      return;
    }

    const egress = this.interfaces.get(entry.port);
    if (!egress || egress === ingress) return; // destination is on the ingress port: drop
    this.engine.trace({
      time: this.engine.now(),
      type: "forward",
      device: this.id,
      detail: { dst, port: egress.name },
    });
    egress.transmit(frame);
  }

  private flood(frame: EthernetFrame, ingress: EthernetInterface): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "flood",
      device: this.id,
      detail: { dst: normalizeMac(frame.dst) },
    });
    for (const iface of this.interfaces.values()) {
      if (iface === ingress) continue;
      if (!iface.operationalUp) continue;
      iface.transmit(frame);
    }
  }
}
