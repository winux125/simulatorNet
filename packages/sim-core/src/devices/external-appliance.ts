import type { ExternalApplianceAuthHint } from "@sim/contracts";
import type { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import { Device } from "./device";

/** Inert source provenance carried by an imported placeholder node. */
export interface ExternalApplianceSource {
  platform: string;
  vendor?: string;
  nodeKind?: string;
  template?: string;
  iconHint?: string;
  /** Preserved startup text; never parsed as config and never executed. */
  unparsedConfig?: string;
  warnings: readonly string[];
  authHint: ExternalApplianceAuthHint;
}

/**
 * Inert placeholder for a node imported from another platform that SimulatorNet
 * does not simulate (see the `external-appliance` device type). It exists so an
 * imported topology can still be built, wired and inspected: it owns its
 * interfaces (so links resolve deterministically) but has **no data plane** — it
 * never learns, forwards, answers ARP, or originates traffic. Every frame that
 * reaches it is silently dropped. `source` is inert metadata, not sim state.
 */
export class ExternalAppliance extends Device {
  readonly deviceType = "external-appliance" as const;
  /** Frames dropped because there is no simulated network OS behind this node. */
  droppedFrameCount = 0;
  source: ExternalApplianceSource = { platform: "unknown", warnings: [], authHint: "unknown" };

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    this.droppedFrameCount++;
    this.engine.trace({
      time: this.engine.now(),
      type: "external-appliance-frame-dropped",
      device: this.id,
      detail: { ingress: ingress.name, src: frame.src, dst: frame.dst },
    });
  }
}
