import { EthernetInterface } from "../net/interface";
import type { EthernetFrame } from "../packets/ethernet";
import type { HostTransportStack } from "../transport/host-transport";
import type { IpAddress } from "../util/ip-address";
import type { Ipv4 } from "../util/ipv4";
import { isIpv6Multicast } from "../util/ipv6";
import { type Mac, normalizeMac } from "../util/mac";
import type { Device } from "./device";
import { Router } from "./router";

export interface ManagementSviRow {
  readonly vlanId: number;
  readonly name: string;
  readonly ip: Ipv4 | undefined;
  readonly maskInt: number;
  readonly adminUp: boolean;
  readonly operUp: boolean;
  readonly description: string | undefined;
}

class ManagementSviInterface extends EthernetInterface {
  constructor(
    device: Device,
    name: string,
    mac: Mac,
    readonly vlanId: number,
    private readonly isOperational: () => boolean,
    private readonly send: (frame: EthernetFrame) => void,
  ) {
    super(device, name, mac);
  }

  override get operationalUp(): boolean {
    return this.adminUp && this.isOperational();
  }

  override transmit(frame: EthernetFrame): void {
    if (this.operationalUp) this.send(frame);
  }
}

/**
 * The management interface of an L2 switch: one `interface vlan <id>` plus
 * `ip default-gateway`.
 *
 * It exists so the switch itself can be reached — ping, Telnet/SSH, SNMP,
 * Syslog and AAA traffic all terminate here — and nothing else. IP routing is
 * permanently disabled on the composed plane, so a transit packet is never
 * forwarded and the switch stays a layer-2 forwarding device. Reachability
 * follows the VLAN: the interface is operationally up only while an active
 * switchport carries the management VLAN.
 */
export class ManagementSviPlane {
  private readonly plane: Router;
  private svi: ManagementSviInterface | undefined;
  private gateway: Ipv4 | undefined;

  constructor(
    private readonly owner: Device,
    /** True while an active switchport still carries the management VLAN. */
    private readonly hasActivePort: (vlanId: number) => boolean,
    private readonly transmitInVlan: (frame: EthernetFrame, vlanId: number) => void,
  ) {
    this.plane = new Router(owner.id, owner.name);
    // A management SVI terminates traffic; it must never route between VLANs.
    this.plane.setForwardingEnabled(false);
  }

  /** Keep the composed plane attached to the live engine before every use. */
  attach(engine: Router["engine"]): void {
    this.plane.engine = engine;
  }

  rename(name: string): void {
    this.plane.rename(name);
  }

  get vlanId(): number | undefined {
    return this.svi?.vlanId;
  }

  get configured(): boolean {
    return this.svi !== undefined;
  }

  get transport(): HostTransportStack {
    return this.plane.management;
  }

  get defaultGateway(): Ipv4 | undefined {
    return this.gateway;
  }

  get arpTable(): Router["arpTable"] {
    return this.plane.arpTable;
  }

  get pingResults(): Router["pingResults"] {
    return this.plane.pingResults;
  }

  define(vlanId: number): void {
    if (this.svi?.vlanId === vlanId) return;
    this.remove();
    const name = `Vlan${vlanId}`;
    const svi = new ManagementSviInterface(
      this.owner,
      name,
      managementSviMac(this.owner.id, vlanId),
      vlanId,
      () => this.hasActivePort(vlanId),
      (frame) => this.transmitInVlan(frame, vlanId),
    );
    this.svi = svi;
    this.plane.interfaces.set(name, svi);
    this.plane.getOrCreateInterface(name);
  }

  remove(): void {
    const current = this.svi;
    if (!current) return;
    this.plane.removeInterface(current.name);
    this.plane.interfaces.delete(current.name);
    this.plane.management.reset();
    this.svi = undefined;
  }

  setIp(vlanId: number, ip: Ipv4, mask: Ipv4 | number): void {
    this.define(vlanId);
    this.plane.setInterfaceIp(`Vlan${vlanId}`, ip, mask);
    // Sockets were bound against the previous address; drop them so the
    // management services re-arm deterministically on the new one.
    this.plane.management.reset();
  }

  clearIp(vlanId: number): void {
    this.plane.clearInterfaceIp(`Vlan${vlanId}`);
    this.plane.management.reset();
  }

  setAdminState(vlanId: number, adminUp: boolean): void {
    this.define(vlanId);
    if (adminUp) this.svi!.noShutdown();
    else this.svi!.shutdown();
  }

  setDescription(vlanId: number, description: string): void {
    this.define(vlanId);
    this.svi!.setDescription(description);
  }

  /**
   * `ip default-gateway`: an off-subnet management reply leaves through this
   * next hop. It is a host default route, not an entry in a routing table the
   * switch would use for transit traffic.
   */
  setDefaultGateway(gateway: Ipv4 | undefined): void {
    this.gateway = gateway;
    this.plane.clearStaticRoutes();
    if (gateway !== undefined) this.plane.addStaticRoute("0.0.0.0", 0, gateway);
  }

  summary(): ManagementSviRow | undefined {
    const svi = this.svi;
    if (!svi) return undefined;
    const row = this.plane.interfaceSummaries().find((entry) => entry.name === svi.name);
    return {
      vlanId: svi.vlanId,
      name: svi.name,
      ip: row?.ip,
      maskInt: row?.maskInt ?? 0,
      adminUp: svi.adminUp,
      operUp: svi.operationalUp,
      description: svi.description,
    };
  }

  managementAddresses(): IpAddress[] {
    return this.plane.managementAddresses();
  }

  ping(target: Ipv4, sequence = 0): void {
    this.plane.ping(target, sequence);
  }

  onInterfaceStateChanged(): void {
    if (this.svi) this.plane.onInterfaceStateChanged(this.svi);
  }

  /**
   * Deliver a frame that arrived in the management VLAN. Returns true when the
   * frame was addressed to this switch, so the caller stops forwarding it.
   */
  receive(frame: EthernetFrame, vlan: number): boolean {
    const svi = this.svi;
    if (!svi || svi.vlanId !== vlan || !svi.operationalUp) return false;
    const destination = normalizeMac(frame.dst);
    const local = destination === normalizeMac(svi.mac);
    const broadcast = destination === "ff:ff:ff:ff:ff:ff";
    const ipv6Group = frame.payload.kind === "ipv6" && isIpv6Multicast(frame.payload.dst);
    if (local || broadcast || ipv6Group) this.plane.onReceive({ ...frame, vlan: undefined }, svi);
    return local;
  }
}

/** Stable, deterministic locally-administered MAC for a management SVI. */
function managementSviMac(deviceId: string, vlanId: number): Mac {
  let hash = 2166136261;
  for (const char of `${deviceId}:mgmt:${vlanId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const octets = [0x02, 0x4d, (hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
  return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
}
