import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import { EthernetInterface } from "../net/interface";
import { estimateVxlanOuterSizeBytes } from "../net/packet-size";
import {
  VXLAN_UDP_PORT,
  vxlanSourcePort,
  type VxlanPacket,
} from "../packets/vxlan";
import { DEFAULT_CONTROL_PROTOCOL_LIMITS } from "../protocols/limits";
import {
  VxlanEngine,
  type EvpnVniConfiguration,
  type NveInterfaceConfiguration,
  type NveOperationalState,
  type RemoteMacEntry,
  type VniOperationalState,
  type VxlanPeerSummary,
} from "../overlay/vxlan";
import { ipToInt, type Ipv4 } from "../util/ipv4";
import type { Ipv6 } from "../util/ipv6";
import { isIpv6Multicast } from "../util/ipv6";
import type { IpAddress } from "../util/ip-address";
import type { Dhcpv6PoolConfig } from "../protocols/dhcpv6";
import type { Mac } from "../util/mac";
import { normalizeMac } from "../util/mac";
import type {
  AclBinding,
  AclCounter,
  AclDirection,
  Ipv4Acl,
  Ipv6Acl,
} from "../policy/packet-policy-engine";
import type {
  QosClassCounter,
  QosClassMap,
  QosDirection,
  QosPolicyMap,
  QosProblem,
  QosServicePolicyBinding,
} from "../qos";
import {
  compareEvpnPaths,
  evpnOriginatingVtep,
  type EvpnRoute,
} from "../protocols/bgp";
import {
  Router,
  type Ipv6RouteRow,
  type Ipv6RouterInterfaceRow,
  type RouterAdvertisementConfig,
  type RouterInterfaceRow,
  type RouteRow,
} from "./router";
import { L2Switch, type FrameOrigin } from "./switch";

/**
 * The underlay MTU a VXLAN outer packet has to fit into.
 *
 * This is an educational constant, not a hardware claim: it exists so a lab can
 * observe that encapsulation costs bytes and that an oversized overlay frame is
 * dropped and reported rather than fragmented.
 */
export const VXLAN_UNDERLAY_MTU_BYTES = 1_500;

/** One row of `show nve interfaces`. */
export interface NveInterfaceRow extends NveOperationalState {
  readonly id: string;
  readonly sourceInterfaceId: string;
  readonly adminUp: boolean;
  readonly vniCount: number;
}

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
  /**
   * The VXLAN tunnel endpoint. An L3 Switch is the only device that may be a
   * VTEP: a Router stays an underlay router (and may reflect EVPN routes) and a
   * plain L2 Switch stays an access/aggregation switch.
   */
  readonly vxlan = new VxlanEngine();
  private readonly routingPlane: Router;
  private readonly routedPorts = new Set<string>();
  private readonly svis = new Map<number, SviInterface>();
  private vxlanListening = false;
  /** Bounded, deduplicated overlay diagnostics; runtime only. */
  private readonly vxlanFaults = new Map<string, string>();
  private readonly evpnFaults = new Map<string, string>();
  /** Last originated EVPN route set, so a MAC learn only re-advertises once. */
  private evpnExportSignature = "";

  constructor(id: string, name: string) {
    super(id, name);
    this.routingPlane = new Router(id, name);
    this.routingPlane.setForwardingEnabled(false);
    // The overlay never reaches into the switch: it asks these five questions
    // and derives its operational state from the answers alone.
    // BGP owns no overlay of its own: it asks this seam what to originate and
    // hands back what it selected. A Router never installs one.
    this.routingPlane.useEvpnOverlayProvider({
      exports: () => this.evpnExports(),
      onImported: (routes) => this.programEvpnRoutes(routes),
    });
    this.vxlan.useHooks({
      interfaceAddress: (name) => {
        const row = this.routingPlane.interfaceSummaries().find((entry) => entry.name === name);
        return row?.operUp ? row.ip : undefined;
      },
      interfaceExists: (name) => this.routingPlane.interfaceSummaries().some((entry) => entry.name === name),
      isLoopback: (name) => this.routingPlane.isLoopback(name),
      hasVlan: (vlanId) => this.hasVlan(vlanId),
      underlayReachable: (address) => {
        this.syncRoutingPlane();
        return this.routingPlane.overlayUnderlayReachable(address);
      },
    });
  }

  override onAddedToEngine(): void {
    this.syncRoutingPlane();
    this.ensureVxlanListener();
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

  setIpv6Routing(enabled: boolean): void {
    this.syncRoutingPlane();
    this.routingPlane.setIpv6ForwardingEnabled(enabled);
  }

  get ipv6UnicastRoutingEnabled(): boolean {
    return this.routingPlane.ipv6UnicastRoutingEnabled;
  }

  get ipRoutingEnabled(): boolean {
    return this.routingPlane.ipRoutingEnabled;
  }

  get bgp(): Router["bgp"] {
    this.syncRoutingPlane();
    return this.routingPlane.bgp;
  }

  /**
   * A BGP peering is a real path, so reachability and the exact-route rule are
   * answered by the routed plane rather than re-derived by a caller.
   */
  bgpRouteReachable(address: IpAddress): boolean {
    this.syncRoutingPlane();
    return this.routingPlane.bgpRouteReachable(address);
  }

  bgpExactRouteExists(
    network: IpAddress,
    prefixLength: number,
    family: "ipv4-unicast" | "ipv6-unicast" = "ipv4-unicast",
  ): boolean {
    this.syncRoutingPlane();
    return this.routingPlane.bgpExactRouteExists(network, prefixLength, family);
  }

  addStaticRoute(network: Ipv4, mask: Ipv4 | number, nextHop: Ipv4): void {
    this.syncRoutingPlane();
    this.routingPlane.addStaticRoute(network, mask, nextHop);
  }

  addIpv6StaticRoute(network: Ipv6, prefixLength: number, nextHop: Ipv6): void {
    this.syncRoutingPlane();
    this.routingPlane.addIpv6StaticRoute(network, prefixLength, nextHop);
  }

  setInterfaceIpv6(name: string, address: Ipv6, prefixLength: number): void {
    this.syncRoutingPlane();
    this.routingPlane.setInterfaceIpv6(name, address, prefixLength);
  }

  enableInterfaceIpv6(name: string): Ipv6 {
    this.syncRoutingPlane();
    return this.routingPlane.enableInterfaceIpv6(name);
  }

  setSviIpv6(vlanId: number, address: Ipv6, prefixLength: number): void {
    this.defineSvi(vlanId);
    this.routingPlane.setInterfaceIpv6(`Vlan${vlanId}`, address, prefixLength);
  }

  configureRouterAdvertisement(interfaceName: string, config: RouterAdvertisementConfig): void {
    this.syncRoutingPlane();
    this.routingPlane.configureRouterAdvertisement(interfaceName, config);
  }

  routerAdvertisementConfigurations(): ReturnType<Router["routerAdvertisementConfigurations"]> {
    return this.routingPlane.routerAdvertisementConfigurations();
  }

  addDhcpv6Pool(config: Dhcpv6PoolConfig): void {
    this.syncRoutingPlane();
    this.routingPlane.addDhcpv6Pool(config);
  }

  dhcpv6PoolConfigurations(): Dhcpv6PoolConfig[] {
    return this.routingPlane.dhcpv6.configurations();
  }

  /** The composed routing plane owns OSPF, exactly as it owns ACLs and routes. */
  get ospf(): Router["ospf"] {
    this.syncRoutingPlane();
    return this.routingPlane.ospf;
  }

  get ospfv3(): Router["ospfv3"] {
    this.syncRoutingPlane();
    return this.routingPlane.ospfv3;
  }

  get ipv6Problems(): readonly string[] {
    return this.routingPlane.ipv6Problems;
  }

  getOrCreateLoopback(index: number): ReturnType<Router["getOrCreateLoopback"]> {
    this.syncRoutingPlane();
    return this.routingPlane.getOrCreateLoopback(index);
  }

  removeLoopback(index: number): void {
    this.routingPlane.removeLoopback(index);
  }

  loopbackNumbers(): number[] {
    return this.routingPlane.loopbackNumbers();
  }

  loopbackSummaries(): RouterInterfaceRow[] {
    return this.routingPlane.loopbackSummaries();
  }

  /** Address a routed port, an SVI or a loopback by its logical name. */
  setInterfaceIp(name: string, ip: Ipv4, mask: Ipv4 | number): void {
    this.syncRoutingPlane();
    this.routingPlane.setInterfaceIp(name, ip, mask);
  }

  isLoopback(name: string): boolean {
    return this.routingPlane.isLoopback(name);
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

  defineIpv6Acl(acl: Ipv6Acl): void {
    this.syncRoutingPlane();
    this.routingPlane.defineIpv6Acl(acl);
  }

  removeIpv6Acl(aclId: string): void {
    this.routingPlane.removeIpv6Acl(aclId);
  }

  applyIpv6Acl(interfaceName: string, direction: AclDirection, aclId: string): void {
    this.syncRoutingPlane();
    this.routingPlane.applyIpv6Acl(interfaceName, direction, aclId);
  }

  removeIpv6AclBinding(interfaceName: string, direction: AclDirection): void {
    this.routingPlane.removeIpv6AclBinding(interfaceName, direction);
  }

  ipv6AclConfigurations(): Ipv6Acl[] {
    return this.routingPlane.ipv6AclConfigurations();
  }

  ipv6AclBindings(): AclBinding[] {
    return this.routingPlane.ipv6AclBindings();
  }

  // --- VXLAN tunnel endpoint ----------------------------------------------

  /** `interface nve1`: configure the one logical overlay interface. */
  configureNve(configuration: NveInterfaceConfiguration): void {
    this.syncRoutingPlane();
    this.vxlan.configure(configuration);
    this.vxlanFaults.clear();
    this.evpnFaults.clear();
    this.evpnExportSignature = "";
    this.ensureVxlanListener();
  }

  removeNve(): void {
    this.vxlan.remove();
    this.vxlanFaults.clear();
    if (this.vxlanListening) {
      this.routingPlane.management.udp.unbind(VXLAN_UDP_PORT);
      this.vxlanListening = false;
    }
  }

  nveConfiguration(): NveInterfaceConfiguration | undefined {
    return this.vxlan.configurationSnapshot();
  }

  defineEvpnVni(configuration: EvpnVniConfiguration): void {
    this.vxlan.defineEvpnVni(configuration);
  }

  removeEvpnVni(vni: number): void {
    this.vxlan.removeEvpnVni(vni);
  }

  evpnVniConfigurations(): EvpnVniConfiguration[] {
    return this.vxlan.evpnVniConfigurations();
  }

  /** `show nve interfaces`: the NVE and why it is or is not operational. */
  nveSummaries(): NveInterfaceRow[] {
    const configuration = this.vxlan.configurationSnapshot();
    if (!configuration) return [];
    this.syncRoutingPlane();
    const state = this.vxlan.state();
    return [{
      id: configuration.id,
      sourceInterfaceId: configuration.sourceInterfaceId,
      adminUp: configuration.adminUp,
      vniCount: configuration.members.length,
      up: state.up,
      sourceAddress: state.sourceAddress,
      reason: state.reason,
    }];
  }

  /** `show nve vni`: every VLAN-to-VNI mapping with its derived state. */
  vniSummaries(): VniOperationalState[] {
    this.syncRoutingPlane();
    return this.vxlan.vniStates();
  }

  /** `show nve peers`: the remote VTEPs head-end replication will reach. */
  vxlanPeerSummaries(): VxlanPeerSummary[] {
    this.syncRoutingPlane();
    return this.vxlan.peerSummaries();
  }

  /** `show mac address-table remote`: MACs learned behind a remote VTEP. */
  remoteMacEntries(): RemoteMacEntry[] {
    return this.vxlan.remoteMacEntries();
  }

  /** Bounded overlay diagnostics for Problems; never a credential or a packet. */
  vxlanProblems(): string[] {
    const problems = [...this.vxlanFaults.values(), ...this.evpnFaults.values()];
    const configuration = this.vxlan.configurationSnapshot();
    if (configuration) {
      const evpnActive = this.evpnAddressFamilyActive();
      const usesEvpn = configuration.members.some((member) => member.replication.type === "bgp-evpn");
      if (usesEvpn && !evpnActive) {
        problems.push(`${this.name} uses BGP EVPN ingress replication but no neighbor activates 'address-family l2vpn evpn'.`);
      }
      if (evpnActive) {
        for (const neighbor of this.routingPlane.bgp.configurationSnapshot()?.neighbors ?? []) {
          if (neighbor.evpnActivated && !neighbor.sendCommunityExtended) {
            problems.push(`${this.name} neighbor ${neighbor.address} activates EVPN without 'send-community extended', so no route target is advertised.`);
          }
        }
        for (const member of configuration.members) {
          if (this.vxlan.evpnVni(member.vni) === undefined) {
            problems.push(`${this.name} VNI ${member.vni} has no 'evpn vni ${member.vni} l2' block, so it advertises no RD or route target.`);
          }
        }
      }
      this.syncRoutingPlane();
      const state = this.vxlan.state();
      if (!state.up && state.reason !== "administratively-down") {
        problems.push(`${this.name} ${configuration.id} source ${configuration.sourceInterfaceId} is unavailable (${state.reason}).`);
      }
      for (const vni of this.vxlan.vniStates()) {
        if (vni.reason === "vlan-missing") {
          problems.push(`${this.name} VNI ${vni.vni} maps VLAN ${vni.vlanId}, which is not in the VLAN database.`);
        }
        if (!vni.up) continue;
        if (this.vxlan.peersForVni(vni.vni).length === 0) {
          problems.push(`${this.name} VNI ${vni.vni} has no remote VTEP: configure a static peer or BGP EVPN ingress replication.`);
        }
        for (const peer of this.vxlan.peersForVni(vni.vni)) {
          if (!this.routingPlane.overlayUnderlayReachable(peer)) {
            problems.push(`${this.name} has no underlay route to VTEP ${peer} for VNI ${vni.vni}.`);
          }
        }
      }
    }
    return [...new Set(problems)].sort();
  }

  /** Drop every learned overlay table; configuration is untouched. */
  resetVxlanRuntime(): void {
    this.vxlan.resetRuntime();
    this.vxlanFaults.clear();
    this.evpnFaults.clear();
    this.evpnExportSignature = "";
  }

  /** `shutdown`/`no shutdown` on nve1, as one bounded restart. */
  restartNve(): void {
    const configuration = this.vxlan.configurationSnapshot();
    if (!configuration) return;
    this.vxlan.configure(configuration);
    this.vxlanFaults.clear();
  }

  /**
   * A VXLAN datagram arrived on one of this VTEP's own addresses. The outer
   * IPv4/UDP header has already been through routing, ACLs and QoS, so what
   * remains is: match the local VNI, decapsulate, learn the remote MAC and hand
   * the inner frame to ordinary local switching.
   */
  private onVxlanDatagram(datagram: { sourceAddress: string; destinationAddress: string; payload: unknown }): void {
    const payload = datagram.payload as { kind?: string };
    if (payload.kind !== "vxlan") return;
    const packet = payload as VxlanPacket;
    this.engine.controlProtocolBudget.consume("vxlanEvents", this.id);
    const source = datagram.sourceAddress as Ipv4;
    this.traceVxlan("vxlan-packet-received", {
      vni: packet.vni,
      sourceVtep: source,
      destinationVtep: datagram.destinationAddress,
      innerSource: packet.innerFrame.src,
      innerDestination: packet.innerFrame.dst,
    });
    const member = this.vxlan.memberForVni(packet.vni);
    const state = member ? this.vxlan.vniState(packet.vni) : undefined;
    if (!member || !state?.up) {
      this.traceVxlan("vxlan-vni-not-found", { vni: packet.vni, sourceVtep: source, reason: state?.reason ?? "not-mapped" });
      this.recordVxlanFault(`vni-${packet.vni}-missing`, `${this.name} received VNI ${packet.vni} from ${source} but has no operational local mapping.`);
      return;
    }
    this.traceVxlan("vxlan-decapsulated", {
      vni: packet.vni,
      vlan: member.vlanId,
      sourceVtep: source,
      innerSource: packet.innerFrame.src,
      innerDestination: packet.innerFrame.dst,
    });
    // A VNI that runs BGP EVPN has a control plane: its remote MAC table is
    // owned by Type 2 routes, so data-plane learning would leave an entry that
    // no withdrawal could ever remove. A static VNI has no control plane and
    // therefore learns from the overlay exactly as a bridge does.
    if (member.replication.type === "static"
      && this.vxlan.learnRemoteMac(packet.vni, packet.innerFrame.src, source, this.engine.now(), "data-plane")) {
      this.traceVxlan("vxlan-mac-learned-remote", {
        vni: packet.vni,
        mac: normalizeMac(packet.innerFrame.src),
        remoteVtep: source,
        source: "data-plane",
      });
    }
    const origin: FrameOrigin = { kind: "remote-vtep", peer: source, vni: packet.vni };
    this.switchIntoVlan(packet.innerFrame, member.vlanId, origin);
  }

  protected override forwardToOverlay(
    frame: EthernetFrame,
    vlan: number,
    destination: Mac,
    origin: FrameOrigin,
  ): boolean {
    const member = this.vxlan.memberForVlan(vlan);
    if (!member) return false;
    const entry = this.vxlan.remoteMac(member.vni, destination);
    if (!entry) return false;
    if (origin.kind === "remote-vtep") {
      // A frame decapsulated from one VTEP is never re-encapsulated towards
      // another: that is exactly the overlay loop split horizon exists to stop.
      this.traceVxlan("vxlan-split-horizon-dropped", {
        vni: member.vni,
        peer: origin.peer,
        mac: normalizeMac(destination),
        reason: "unicast-from-overlay",
      });
      return true;
    }
    return this.sendVxlan(member.vni, entry.remoteVtep, frame, "unicast");
  }

  protected override replicateToOverlay(frame: EthernetFrame, vlan: number, origin: FrameOrigin): void {
    const member = this.vxlan.memberForVlan(vlan);
    if (!member) return;
    if (origin.kind === "remote-vtep") {
      this.traceVxlan("vxlan-split-horizon-dropped", {
        vni: member.vni,
        peer: origin.peer,
        reason: "bum-from-overlay",
      });
      return;
    }
    const state = this.vxlan.vniState(member.vni);
    if (!state?.up) return;
    const peers = this.vxlan.peersForVni(member.vni);
    let replicas = 0;
    for (const peer of peers) {
      // Head-end replication is bounded per operation, so a broadcast storm can
      // never make Auto execution unbounded.
      if (!this.engine.controlProtocolBudget.tryConsume("bumReplicas", this.id)) break;
      if (this.sendVxlan(member.vni, peer, frame, "bum")) replicas++;
    }
    this.traceVxlan("vxlan-bum-replicated", {
      vni: member.vni,
      vlan: member.vlanId,
      replicas,
      peers: peers.length,
      replication: member.replication.type,
    });
    if (peers.length === 0) {
      this.recordVxlanFault(
        `vni-${member.vni}-no-peer`,
        `${this.name} VNI ${member.vni} flooded locally only: no remote VTEP is known.`,
      );
    }
  }

  /**
   * Encapsulate one frame and hand the outer packet to the ordinary underlay
   * path, so interface state, ACLs, the firewall, QoS and packet loss all apply
   * to it exactly as they do to any other IPv4/UDP traffic.
   */
  private sendVxlan(vni: number, destination: Ipv4, frame: EthernetFrame, kind: "unicast" | "bum"): boolean {
    this.syncRoutingPlane();
    const state = this.vxlan.vniState(vni);
    if (!state?.up || state.sourceAddress === undefined) return false;
    this.engine.controlProtocolBudget.consume("vxlanEvents", this.id);
    // The VNI carries the segment identity, so the inner frame travels
    // untagged and its 802.1p priority goes with the tag it no longer has.
    const innerFrame: EthernetFrame = frame.vlan === undefined && frame.pcp === undefined
      ? frame
      : { ...frame, vlan: undefined, pcp: undefined };
    this.traceVxlan("vxlan-encapsulation-started", {
      vni,
      kind,
      sourceVtep: state.sourceAddress,
      destinationVtep: destination,
      innerSource: normalizeMac(innerFrame.src),
      innerDestination: normalizeMac(innerFrame.dst),
    });
    const bytes = estimateVxlanOuterSizeBytes(innerFrame);
    if (bytes > VXLAN_UNDERLAY_MTU_BYTES) {
      this.traceVxlan("vxlan-mtu-exceeded", { vni, bytes, mtu: VXLAN_UNDERLAY_MTU_BYTES, destinationVtep: destination });
      this.recordVxlanFault(
        `vni-${vni}-mtu`,
        `${this.name} dropped a VNI ${vni} frame: ${bytes} bytes exceeds the ${VXLAN_UNDERLAY_MTU_BYTES}-byte underlay MTU.`,
      );
      return false;
    }
    if (!this.routingPlane.overlayUnderlayReachable(destination)) {
      this.traceVxlan("vxlan-underlay-unreachable", { vni, destinationVtep: destination });
      this.recordVxlanFault(
        `vtep-${destination}-unreachable`,
        `${this.name} has no underlay route to VTEP ${destination}.`,
      );
      return false;
    }
    const packet: VxlanPacket = {
      kind: "vxlan",
      vni,
      innerFrame,
      sourceVtep: state.sourceAddress,
      destinationVtep: destination,
    };
    this.routingPlane.management.udp.send({
      destinationAddress: destination,
      destinationPort: VXLAN_UDP_PORT,
      sourcePort: vxlanSourcePort(vni, innerFrame),
      sourceAddress: state.sourceAddress,
      payload: packet,
    });
    this.traceVxlan("vxlan-packet-sent", {
      vni,
      kind,
      sourceVtep: state.sourceAddress,
      destinationVtep: destination,
      bytes,
    });
    return true;
  }

  protected override onLocalMacLearned(vlan: number, mac: Mac, port: string): void {
    const member = this.vxlan.memberForVlan(vlan);
    if (!member) return;
    // A local attachment always wins over a remote one: the station moved here,
    // so the stale remote entry is dropped and the overlay is told about it.
    const remote = this.vxlan.remoteMac(member.vni, mac);
    if (remote) {
      this.vxlan.forgetRemoteMac(member.vni, mac);
      this.traceVxlan("vxlan-mac-moved-local", {
        vni: member.vni,
        mac: normalizeMac(mac),
        port,
        previousVtep: remote.remoteVtep,
      });
    }
    this.traceVxlan("vxlan-mac-learned-local", { vni: member.vni, vlan, mac: normalizeMac(mac), port });
    this.onOverlayMacTableChanged();
  }

  // --- BGP EVPN control plane ----------------------------------------------

  /** `true` once at least one neighbor has `l2vpn evpn` activated. */
  evpnAddressFamilyActive(): boolean {
    return (this.routingPlane.bgp.configurationSnapshot()?.neighbors ?? [])
      .some((neighbor) => neighbor.evpnActivated === true);
  }

  /** Every EVPN route this VTEP knows, locally originated and learned. */
  evpnRoutes(): ReturnType<Router["bgp"]["evpnRoutes"]> {
    this.syncRoutingPlane();
    return this.routingPlane.bgp.evpnRoutes();
  }

  /**
   * The routes this VTEP originates.
   *
   * A Type 3 exists for every operational VNI that has an EVPN block, so the
   * remote leaves know to replicate BUM traffic here. A Type 2 exists for every
   * MAC this VTEP learned locally on a mapped VLAN — never for a MAC it learned
   * from another VTEP.
   */
  private evpnExports(): EvpnRoute[] {
    if (!this.evpnAddressFamilyActive()) return [];
    const state = this.vxlan.state();
    if (!state.up || state.sourceAddress === undefined) return [];
    const localAs = this.routingPlane.bgp.localAs ?? 0;
    const routerId = this.routingPlane.bgp.configurationSnapshot()?.routerId ?? state.sourceAddress;
    const localMacs = new Map<number, Array<{ mac: Mac; vlan: number }>>();
    for (const row of this.macAddressTable()) {
      const member = this.vxlan.memberForVlan(row.vlan);
      if (!member) continue;
      const list = localMacs.get(member.vni) ?? [];
      if (list.length < DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumEvpnMacRoutesPerVni) {
        list.push({ mac: normalizeMac(row.mac), vlan: row.vlan });
      }
      localMacs.set(member.vni, list);
    }
    const routes: EvpnRoute[] = [];
    for (const vni of this.vxlan.vniStates()) {
      if (!vni.up) continue;
      const evpn = this.vxlan.evpnVni(vni.vni);
      if (!evpn) continue;
      const shared = {
        routeDistinguisher: evpn.routeDistinguisher,
        ethernetTag: 0,
        vni: vni.vni,
        routeTargets: [...evpn.exportRouteTargets],
        nextHop: state.sourceAddress,
        pathAttributes: {
          origin: "igp" as const,
          asPath: [] as readonly number[],
          nextHop: state.sourceAddress,
          localPreference: 100,
          med: 0,
        },
        ...this.localEvpnPathState(routerId),
      };
      routes.push({
        ...shared,
        type: 3,
        originatingVtep: state.sourceAddress,
        routeId: `local:evpn:3:${evpn.routeDistinguisher}:${vni.vni}`,
      });
      if (evpn.exportRouteTargets.length === 0) continue;
      for (const entry of localMacs.get(vni.vni) ?? []) {
        routes.push({
          ...shared,
          type: 2,
          macAddress: entry.mac,
          // The VNI is the delivery label in a VXLAN fabric.
          label: vni.vni,
          routeId: `local:evpn:2:${evpn.routeDistinguisher}:${vni.vni}:${entry.mac}`,
        });
      }
    }
    void localAs;
    return routes.sort((a, b) => a.type - b.type || a.vni - b.vni || a.routeId.localeCompare(b.routeId));
  }

  /** The path state a locally originated EVPN route carries. */
  private localEvpnPathState(routerId: Ipv4) {
    return {
      source: "local" as const,
      neighborRouterId: routerId,
      learnedAtNs: 0,
      localPreference: 100,
      med: 0,
      weight: 32_768,
      igpMetric: 0,
      communities: [] as readonly string[],
      clusterList: [] as readonly string[],
    };
  }

  /**
   * Program the selected remote EVPN routes into the overlay.
   *
   * A route is imported only when its route targets intersect a local VNI's
   * import list; otherwise it stays in the EVPN RIB and programs nothing. That
   * intersection — not the VNI number — is what makes RT the control point.
   */
  private programEvpnRoutes(routes: readonly EvpnRoute[]): void {
    this.vxlan.forgetRemoteMacsFrom("bgp-evpn");
    this.evpnFaults.clear();
    const membership = new Map<number, Ipv4[]>();
    const macCandidates = new Map<string, EvpnRoute[]>();
    for (const route of routes) {
      const vni = this.importVniFor(route.routeTargets);
      if (vni === undefined) {
        this.traceVxlan("evpn-rt-rejected", {
          addressFamily: "l2vpn-evpn",
          routeType: route.type,
          rd: route.routeDistinguisher,
          vni: route.vni,
          routeTargets: route.routeTargets,
        });
        this.recordEvpnFault(
          `rt-${route.routeDistinguisher}-${route.vni}`,
          `${this.name} did not import EVPN route ${route.routeDistinguisher} (VNI ${route.vni}): no local import route target matches.`,
        );
        continue;
      }
      if (route.type === 3) {
        const peers = membership.get(vni) ?? [];
        const vtep = evpnOriginatingVtep(route);
        if (!peers.includes(vtep)) peers.push(vtep);
        membership.set(vni, peers);
        continue;
      }
      const key = `${vni} ${normalizeMac(route.macAddress)}`;
      macCandidates.set(key, [...(macCandidates.get(key) ?? []), route]);
    }
    for (const [key, candidates] of macCandidates) {
      const [vniText, mac] = key.split(" ") as [string, Mac];
      const vni = Number(vniText);
      // A duplicate MAC resolves through the one best-path comparator, so the
      // same winner is chosen no matter which UPDATE arrived first.
      const ordered = [...candidates].sort(compareEvpnPaths);
      const winner = ordered[0]!;
      if (ordered.length > 1) {
        this.traceVxlan("evpn-duplicate-mac-detected", {
          vni,
          mac,
          vteps: ordered.map((route) => evpnOriginatingVtep(route)),
          selected: evpnOriginatingVtep(winner),
        });
        this.recordEvpnFault(
          `duplicate-${vni}-${mac}`,
          `${this.name} received MAC ${mac} in VNI ${vni} from ${ordered.length} VTEPs; ${evpnOriginatingVtep(winner)} was selected.`,
        );
      }
      if (this.vxlan.learnRemoteMac(vni, mac, evpnOriginatingVtep(winner), this.engine.now(), "bgp-evpn")) {
        this.traceVxlan("vxlan-mac-learned-remote", {
          vni,
          mac,
          remoteVtep: evpnOriginatingVtep(winner),
          source: "bgp-evpn",
        });
      }
    }
    for (const member of this.vxlan.members()) {
      if (member.replication.type !== "bgp-evpn") continue;
      const peers = membership.get(member.vni) ?? [];
      if (this.vxlan.replaceEvpnPeers(member.vni, peers)) {
        this.traceVxlan("evpn-imet-membership-changed", {
          vni: member.vni,
          peers: [...peers].sort(),
        });
      }
    }
  }

  /** The local VNI whose import route targets intersect an advertised set. */
  private importVniFor(routeTargets: readonly string[]): number | undefined {
    const targets = new Set(routeTargets);
    return this.vxlan.evpnVniConfigurations()
      .filter((entry) => entry.importRouteTargets.some((target) => targets.has(target)))
      .map((entry) => entry.vni)
      .find((vni) => this.vxlan.memberForVni(vni) !== undefined);
  }

  /** The EVPN control plane reacts to a local MAC change. */
  private onOverlayMacTableChanged(): void {
    if (!this.evpnAddressFamilyActive()) return;
    const signature = this.evpnExports().map((route) => route.routeId).join("\n");
    if (signature === this.evpnExportSignature) return;
    this.evpnExportSignature = signature;
    this.traceVxlan("evpn-mac-route-originated", {
      addressFamily: "l2vpn-evpn",
      routeType: 2,
      routes: this.evpnExports().filter((route) => route.type === 2).length,
    });
    this.routingPlane.bgp.refreshRoutes();
  }

  private recordEvpnFault(key: string, message: string): void {
    if (this.evpnFaults.size >= 64 && !this.evpnFaults.has(key)) return;
    this.evpnFaults.set(key, message);
  }

  private ensureVxlanListener(): void {
    if (this.vxlanListening) return;
    this.routingPlane.management.udp.bind(
      VXLAN_UDP_PORT,
      (datagram) => this.onVxlanDatagram(datagram),
      "vxlan",
    );
    this.vxlanListening = true;
  }

  private recordVxlanFault(key: string, message: string): void {
    if (this.vxlanFaults.size >= 64 && !this.vxlanFaults.has(key)) return;
    this.vxlanFaults.set(key, message);
  }

  protected traceVxlan(type: string, detail: Readonly<Record<string, unknown>>): void {
    this.engine.trace({ time: this.engine.now(), type, device: this.id, detail });
  }

  // --- quality of service (delegated to the composed routing plane) --------

  get qos(): Router["qos"] {
    this.syncRoutingPlane();
    return this.routingPlane.qos;
  }

  defineQosClassMap(map: QosClassMap): void {
    this.syncRoutingPlane();
    this.routingPlane.defineQosClassMap(map);
  }

  removeQosClassMap(id: string): void {
    this.routingPlane.removeQosClassMap(id);
  }

  qosClassMapConfigurations(): QosClassMap[] {
    return this.routingPlane.qosClassMapConfigurations();
  }

  defineQosPolicyMap(map: QosPolicyMap): void {
    this.syncRoutingPlane();
    this.routingPlane.defineQosPolicyMap(map);
  }

  removeQosPolicyMap(id: string): void {
    this.routingPlane.removeQosPolicyMap(id);
  }

  qosPolicyMapConfigurations(): QosPolicyMap[] {
    return this.routingPlane.qosPolicyMapConfigurations();
  }

  applyServicePolicy(interfaceName: string, direction: QosDirection, policyMapId: string): void {
    this.syncRoutingPlane();
    this.routingPlane.applyServicePolicy(interfaceName, direction, policyMapId);
  }

  removeServicePolicy(interfaceName: string, direction: QosDirection): void {
    this.routingPlane.removeServicePolicy(interfaceName, direction);
  }

  qosServicePolicies(): QosServicePolicyBinding[] {
    return this.routingPlane.qosServicePolicies();
  }

  qosCounters(): QosClassCounter[] {
    return this.routingPlane.qosCounters();
  }

  resetQosRuntime(): void {
    this.routingPlane.resetQosRuntime();
  }

  qosProblems(): QosProblem[] {
    return this.routingPlane.qosProblems();
  }

  refreshEgressQueues(): void {
    this.routingPlane.refreshEgressQueues();
  }

  staticRouteConfigurations(): ReturnType<Router["staticRouteConfigurations"]> {
    return this.routingPlane.staticRouteConfigurations();
  }

  ipv6StaticRouteConfigurations(): ReturnType<Router["ipv6StaticRouteConfigurations"]> {
    return this.routingPlane.ipv6StaticRouteConfigurations();
  }

  routingTable(): RouteRow[] {
    return this.routingPlane.routingTable();
  }

  ipv6RoutingTable(): Ipv6RouteRow[] {
    return this.routingPlane.ipv6RoutingTable();
  }

  ipv6InterfaceSummaries(): Ipv6RouterInterfaceRow[] {
    return this.routingPlane.ipv6InterfaceSummaries();
  }

  ipv6NeighborEntries(): ReturnType<Router["ipv6NeighborEntries"]> {
    return this.routingPlane.ipv6NeighborEntries();
  }

  routedInterfaceSummaries(): RouterInterfaceRow[] {
    return this.routingPlane.interfaceSummaries()
      .filter((row) => !row.name.startsWith("Vlan") && !this.routingPlane.isLoopback(row.name));
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

  get ipv6PingResults(): Router["ipv6PingResults"] {
    return this.routingPlane.ipv6PingResults;
  }

  ping6(target: Ipv6, sequence = 0): void {
    this.syncRoutingPlane();
    this.routingPlane.ping6(target, sequence);
  }

  override onReceive(frame: EthernetFrame, ingress: EthernetInterface): void {
    this.syncRoutingPlane();
    // Link-local control frames belong to this switch's own control plane, on
    // routed ports just as much as on switchports.
    if (this.routedPorts.has(ingress.name) && !isControlPayload(frame.payload)) {
      this.routingPlane.onReceive(frame, ingress);
      return;
    }
    super.onReceive(frame, ingress);
  }

  override onInterfaceStateChanged(iface: EthernetInterface): void {
    super.onInterfaceStateChanged(iface);
    this.syncRoutingPlane();
    this.routingPlane.onInterfaceStateChanged(iface);
    for (const svi of this.svis.values()) this.routingPlane.onInterfaceStateChanged(svi);
  }

  /** Management address for discovery: the lowest SVI or routed-port address. */
  override discoveryManagementAddress(): Ipv4 | undefined {
    let lowest: Ipv4 | undefined;
    for (const row of this.routingPlane.interfaceSummaries()) {
      if (row.ip === undefined) continue;
      if (lowest === undefined || ipToInt(row.ip) < ipToInt(lowest)) lowest = row.ip;
    }
    return lowest;
  }

  /** An L3 switch addresses VLANs with routed SVIs, not a management-only SVI. */
  protected override supportsManagementSvi(): boolean {
    return false;
  }

  /** Management traffic terminates on the routing plane's own SVI addresses. */
  override managementTransport(): ReturnType<L2Switch["managementTransport"]> {
    this.syncRoutingPlane();
    return this.routingPlane.management;
  }

  override managementAddresses(): ReturnType<L2Switch["managementAddresses"]> {
    this.syncRoutingPlane();
    return this.routingPlane.managementAddresses();
  }

  protected override switchingEnabledOnPort(port: string): boolean {
    return !this.routedPorts.has(port) && super.switchingEnabledOnPort(port);
  }

  protected override receiveLocal(frame: EthernetFrame, _ingress: EthernetInterface | undefined, vlan: number): boolean {
    const svi = this.svis.get(vlan);
    if (!svi?.operationalUp) return false;
    const destination = normalizeMac(frame.dst);
    const local = destination === normalizeMac(svi.mac);
    const broadcast = destination === "ff:ff:ff:ff:ff:ff";
    const ipv6Group = frame.payload.kind === "ipv6" && isIpv6Multicast(frame.payload.dst);
    if (local || broadcast || ipv6Group) this.routingPlane.onReceive({ ...frame, vlan: undefined }, svi);
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
    this.routingPlane.qos.useOperationBudget(this.engine.qosBudget);
  }

  private sviMac(vlanId: number): Mac {
    let hash = 2166136261;
    for (const char of `${this.id}:${vlanId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const octets = [0x02, 0x53, (hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
    return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
  }
}
