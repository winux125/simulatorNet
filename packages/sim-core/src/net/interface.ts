import type { Device } from "../devices/device";
import type { EthernetFrame } from "../packets/ethernet";
import type { Mac } from "../util/mac";
import type { Link } from "./link";

/**
 * A physical Ethernet port on a device. Sending a frame schedules its delivery
 * to the peer interface after the link's propagation delay — the single place
 * where "the wire" is modelled.
 */
export class EthernetInterface {
  link: Link | undefined;
  /** Administrative state: `no shutdown` (true) vs `shutdown` (false). */
  adminUp = true;

  constructor(
    readonly device: Device,
    readonly name: string,
    public mac: Mac,
  ) {}

  peer(): EthernetInterface | undefined {
    if (!this.link) return undefined;
    return this.link.a === this ? this.link.b : this.link.a;
  }

  /** Usable only when cabled and both ends are administratively up. */
  get operationalUp(): boolean {
    const peer = this.peer();
    return this.adminUp && peer !== undefined && peer.adminUp;
  }

  /** Transmit a frame onto the wire; delivery to the peer is scheduled. */
  transmit(frame: EthernetFrame): void {
    const peer = this.peer();
    const link = this.link;
    if (!link || !peer || !this.operationalUp) return; // link down: frame dropped
    const engine = this.device.engine;
    engine.scheduleIn(link.propagationDelayNs, () => {
      peer.device.onReceive(frame, peer);
    });
  }
}
