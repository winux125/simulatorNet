import type { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import { Device } from "./device";

/** Physical Ethernet repeater: no addressing, learning, filtering, or VLANs. */
export class Hub extends Device {
  readonly deviceType = "hub" as const;
  repeatedFrameCount = 0;
  droppedFrameCount = 0;

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    if (!ingress.operationalUp) {
      this.dropped(frame, ingress.name, "ingress-interface-down");
      return;
    }
    this.engine.trace({
      time: this.engine.now(),
      type: "hub-frame-received",
      device: this.id,
      detail: { ingress: ingress.name, src: frame.src, dst: frame.dst },
    });

    let repeated = 0;
    for (const egress of this.interfaces.values()) {
      if (egress === ingress) continue;
      if (!egress.operationalUp) {
        this.dropped(frame, egress.name, "egress-interface-down");
        continue;
      }
      egress.transmit(frame);
      repeated++;
      this.repeatedFrameCount++;
      this.engine.trace({
        time: this.engine.now(),
        type: "hub-frame-repeated",
        device: this.id,
        detail: { ingress: ingress.name, egress: egress.name, src: frame.src, dst: frame.dst },
      });
    }
    if (repeated === 0) this.dropped(frame, ingress.name, "no-active-egress");
  }

  private dropped(frame: EthernetFrame, interfaceId: string, reason: string): void {
    this.droppedFrameCount++;
    this.engine.trace({
      time: this.engine.now(),
      type: "hub-frame-dropped",
      device: this.id,
      detail: { interface: interfaceId, reason, src: frame.src, dst: frame.dst },
    });
  }
}
