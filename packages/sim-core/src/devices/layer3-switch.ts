import type { EthernetFrame } from "../packets/ethernet";
import { EthernetInterface } from "../net/interface";
import type { Ipv4 } from "../util/ipv4";
import type { Mac } from "../util/mac";
import { normalizeMac } from "../util/mac";
import type {
  AclBinding,
  AclCounter,
  AclDirection,
  Ipv4Acl,
} from "../policy/packet-policy-engine";
import { Router, type RouterInterfaceRow, type RouteRow } from "./router";
import { L2Switch } from "./switch";

export interface SviRow {
  readonly vlanId: number;
  readonly name: string;
  readonly ip: Ipv4 | undefined;
  readonly maskInt: number;
  readonly adminUp: boolean;
  readonly operUp: boolean;
  readonly description: string | undefined;
}

class SviInterface extends EthernetInterface {
  constructor(
    device: Layer3Switch,
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

/** VLAN switching plus a composed Router control/data plane for SVIs and routed ports. */
export class Layer3Switch extends L2Switch {
  override readonly deviceType = "l3-switch" as const;
  private readonly routingPlane: Router;
  private readonly routedPorts = new Set<string>();
  private readonly svis = new Map<number, SviInterface>();

  constructor(id: string, name: string) {
    super(id, name);
    this.routingPlane = new Router(id, name);
    this.routingPlane.setForwardingEnabled(false);
  }

  override onAddedToEngine(): void {
    this.syncRoutingPlane();
  }

  override rename(name: string): void {
    super.rename(name);
    this.routingPlane.rename(name);
  }

  override addInterface(name: string, mac: Mac): EthernetInterface {
    const iface = super.addInterface(name, mac);
    this.routingPlane.interfaces.set(name, iface);
    return iface;
  }

  setPortRouted(port: string, routed = true): void {
    this.requirePort(port);
    this.syncRoutingPlane();
    if (routed) {
      this.routedPorts.add(port);
      this.routingPlane.getOrCreateInterface(port);
    } else {
      this.routedPorts.delete(port);
      this.routingPlane.removeInterface(port);
    }
  }

  isRoutedPort(port: string): boolean {
    return this.routedPorts.has(port);
  }

  configureRoutedInterface(port: string, ip: Ipv4, mask: Ipv4 | number): void {
    this.setPortRouted(port, true);
    this.routingPlane.setInterfaceIp(port, ip, mask);
  }

  defineSvi(vlanId: number): void {
    this.defineVlan(vlanId);
    this.syncRoutingPlane();
    if (this.svis.has(vlanId)) return;
    const name = `Vlan${vlanId}`;
    const svi = new SviInterface(
      this,
      name,
      this.sviMac(vlanId),
      vlanId,
      () => this.sviHasActivePort(vlanId),
      (frame) => this.transmitFromLocal(frame, vlanId),
    );
    this.svis.set(vlanId, svi);
    this.routingPlane.interfaces.set(name, svi);
    this.routingPlane.getOrCreateInterface(name);
  }

  setSviIp(vlanId: number, ip: Ipv4, mask: Ipv4 | number): void {
    this.defineSvi(vlanId);
    this.routingPlane.setInterfaceIp(`Vlan${vlanId}`, ip, mask);
  }

  setSviAdminState(vlanId: number, adminUp: boolean): void {
    this.defineSvi(vlanId);
    const svi = this.svis.get(vlanId)!;
    if (adminUp) svi.noShutdown();
    else svi.shutdown();
  }

  setSviDescription(vlanId: number, description: string): void {
    this.defineSvi(vlanId);
    this.svis.get(vlanId)!.setDescription(description);
  }

  setIpRouting(enabled: boolean): void {
    this.syncRoutingPlane();
    this.routingPlane.setForwardingEnabled(enabled);
  }

  get ipRoutingEnabled(): boolean {
    return this.routingPlane.ipRoutingEnabled;
  }

  addStaticRoute(network: Ipv4, mask: Ipv4 | number, nextHop: Ipv4): void {
    this.syncRoutingPlane();
    this.routingPlane.addStaticRoute(network, mask, nextHop);
  }

  defineAcl(acl: Ipv4Acl): void {
    this.syncRoutingPlane();
    this.routingPlane.defineAcl(acl);
  }

  removeAcl(aclId: string): void {
    this.routingPlane.removeAcl(aclId);
  }

  applyAcl(interfaceName: string, direction: AclDirection, aclId: string): void {
    this.syncRoutingPlane();
    this.routingPlane.applyAcl(interfaceName, direction, aclId);
  }

  removeAclBinding(interfaceName: string, direction: AclDirection): void {
    this.routingPlane.removeAclBinding(interfaceName, direction);
  }

  aclConfigurations(): Ipv4Acl[] {
    return this.routingPlane.aclConfigurations();
  }

  aclBindings(): AclBinding[] {
    return this.routingPlane.aclBindings();
  }

  aclCounters(): AclCounter[] {
    return this.routingPlane.aclCounters();
  }

  resetAclCounters(): void {
    this.routingPlane.resetAclCounters();
  }

  staticRouteConfigurations(): ReturnType<Router["staticRouteConfigurations"]> {
    return this.routingPlane.staticRouteConfigurations();
  }

  routingTable(): RouteRow[] {
    return this.routingPlane.routingTable();
  }

  routedInterfaceSummaries(): RouterInterfaceRow[] {
    return this.routingPlane.interfaceSummaries().filter((row) => !row.name.startsWith("Vlan"));
  }

  sviSummaries(): SviRow[] {
    const rows = new Map(this.routingPlane.interfaceSummaries().map((row) => [row.name, row]));
    return [...this.svis.values()]
      .map((svi) => {
        const row = rows.get(svi.name)!;
        return {
          vlanId: svi.vlanId,
          name: svi.name,
          ip: row.ip,
          maskInt: row.maskInt,
          adminUp: svi.adminUp,
          operUp: svi.operationalUp,
          description: svi.description,
        };
      })
      .sort((a, b) => a.vlanId - b.vlanId);
  }

  get arpTable(): Router["arpTable"] {
    return this.routingPlane.arpTable;
  }

  get pingResults(): Router["pingResults"] {
    return this.routingPlane.pingResults;
  }

  ping(target: Ipv4, sequence = 0): void {
    this.syncRoutingPlane();
    this.routingPlane.ping(target, sequence);
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    this.syncRoutingPlane();
    if (this.routedPorts.has(ingress.name)) {
      this.routingPlane.onReceive(frame, ingress);
      return;
    }
    super.onReceive(frame, ingress);
  }

  protected override switchingEnabledOnPort(port: string): boolean {
    return !this.routedPorts.has(port);
  }

  protected override receiveLocal(frame: EthernetFrame, _ingress: EthernetInterface, vlan: number): boolean {
    const svi = this.svis.get(vlan);
    if (!svi?.operationalUp) return false;
    const destination = normalizeMac(frame.dst);
    const local = destination === normalizeMac(svi.mac);
    const broadcast = destination === "ff:ff:ff:ff:ff:ff";
    if (local || broadcast) this.routingPlane.onReceive({ ...frame, vlan: undefined }, svi);
    return local;
  }

  private sviHasActivePort(vlanId: number): boolean {
    return this.hasVlan(vlanId) && [...this.interfaces.values()].some((iface) =>
      !this.routedPorts.has(iface.name) && iface.operationalUp && this.portCarriesVlan(iface.name, vlanId));
  }

  private requirePort(port: string): EthernetInterface {
    const iface = this.getInterface(port);
    if (!iface) throw new Error(`Layer-3 switch ${this.id} has no interface ${port}`);
    return iface;
  }

  private syncRoutingPlane(): void {
    this.routingPlane.engine = this.engine;
    this.routingPlane.useAclRuleBudget(this.engine.aclRuleBudget);
  }

  private sviMac(vlanId: number): Mac {
    let hash = 2166136261;
    for (const char of `${this.id}:${vlanId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const octets = [0x02, 0x53, (hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
    return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
  }
}
