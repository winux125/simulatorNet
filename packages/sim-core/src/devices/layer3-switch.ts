import { type EthernetFrame, isControlPayload } from "../packets/ethernet";
import { EthernetInterface } from "../net/interface";
import { estimateVxlanOuterSizeBytes } from "../net/packet-size";
import {
  VXLAN_UDP_PORT,
  vxlanInnerPayload,
  vxlanSourcePort,
  type VxlanInnerPayload,
  type VxlanPacket,
} from "../packets/vxlan";
import { ArpOp } from "@sim/contracts";
import type { ArpPacket } from "../packets/arp";
import type { Ipv4Packet } from "../packets/ipv4";
import { ControlProtocolConfigurationError, DEFAULT_CONTROL_PROTOCOL_LIMITS } from "../protocols/limits";
import { parsePortChannelName } from "../protocols/etherchannel";
import {
  NVE_INTERFACE_ID,
  VxlanEngine,
  type EvpnFabricConfiguration,
  type EvpnVniConfiguration,
  type L3VniOperationalState,
  type NveInterfaceConfiguration,
  type NveOperationalState,
  type RemoteMacEntry,
  type VniOperationalState,
  type VxlanPeerSummary,
} from "../overlay/vxlan";
import {
  ESI_ZERO,
  EthernetSegmentEngine,
  electDesignatedForwarder,
  type Esi,
  type EvpnAliasingPathSet,
  type EvpnDfState,
  type EvpnEsPeer,
  type EvpnEthernetSegmentConfiguration,
  type EvpnEthernetSegmentState,
  type EvpnRedundancyMode,
} from "../overlay/ethernet-segment";
import type { EvpnDfAlgorithm } from "../overlay/df-election";
import type { ImportedEvpnPrefixRoute, VrfConfiguration, VrfRoute } from "../routing/vrf";
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
import { evpnRouteVni } from "../packets/bgp";
import { enforceStructuralLimit } from "../protocols/limits";
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

/**
 * Where a remote MAC behind an Ethernet Segment is reachable.
 *
 * The two redundancy modes answer genuinely different questions, so both shapes
 * live in one structure rather than All-Active borrowing Single-Active's words:
 *
 * - **Single-Active** fills `primary` (the segment's Designated Forwarder) and
 *   `backups`, which are never forwarded over — they exist so a failover is a
 *   selection rather than a relearn.
 * - **All-Active** fills `aliases` with every live path and sets `primary` to
 *   the flow-independent default the tables display; a real flow picks its own
 *   member of `aliases`.
 */
interface MultihomingPath {
  readonly primary: Ipv4;
  readonly backups: readonly Ipv4[];
  readonly aliases: readonly Ipv4[];
  readonly ethernetSegmentId?: Esi;
  readonly redundancyMode?: EvpnRedundancyMode;
}

/**
 * What this VTEP advertises for an address it currently owns locally.
 *
 * `location` is what a move is measured against: the Ethernet Segment an
 * attachment belongs to, or the port itself when it is single-homed. Two leaves
 * of one All-Active segment share a location, which is exactly why a frame
 * appearing on the second of them is not a move.
 */
interface LocalMacMobility {
  readonly sequence: number;
  readonly location: string;
}

/** The highest sequence a peer advertised for an address, and from where. */
interface ObservedMacMobility {
  readonly sequence: number;
  readonly vtep: Ipv4;
  readonly esi: Esi | undefined;
}

/**
 * One address's MAC Mobility state, for inspection.
 *
 * Runtime only: a sequence number describes where an address has been during
 * this run, so it is never serialized into a `LabDocument` and the browser
 * worker and the verifier each rebuild it by replaying the same learns and the
 * same BGP UPDATEs.
 */
export interface EvpnMacMobilityState {
  readonly vni: number;
  readonly macAddress: Mac;
  readonly sequence: number;
  /** `local` when this VTEP owns the address, otherwise the owning VTEP. */
  readonly owner: Ipv4 | "local";
  /** The Ethernet Segment or port the address currently lives behind. */
  readonly location: string;
  readonly previousOwner: Ipv4 | undefined;
  /**
   * `stable` — never moved; `moved` — this leaf holds the current location;
   * `superseded` — this leaf still has a local copy, but the fabric holds the
   * address somewhere newer and this copy loses.
   */
  readonly state: "stable" | "moved" | "superseded";
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
  /**
   * EVPN multihoming, Single-Active and All-Active. The segments are
   * configuration; the peers, the elected Designated Forwarder, every A-D route
   * and each aliasing set are runtime.
   */
  readonly ethernetSegments = new EthernetSegmentEngine();
  private readonly routingPlane: Router;
  private readonly routedPorts = new Set<string>();
  private readonly svis = new Map<number, SviInterface>();
  private vxlanListening = false;
  /** Bounded, deduplicated overlay diagnostics; runtime only. */
  private readonly vxlanFaults = new Map<string, string>();
  private readonly evpnFaults = new Map<string, string>();
  /** Last originated EVPN route set, so a MAC learn only re-advertises once. */
  private evpnExportSignature = "";
  /** Last DF election result, so an unchanged election emits no trace at all. */
  private dfSignature = "";
  /** Last originated Ethernet Segment set, so origination is traced once. */
  private esExportSignature = "";
  /** `<vni>|<mac>` → the VTEP last selected, so a failover is reported once. */
  private readonly multihomingPrimaries = new Map<string, Ipv4>();
  /** `<vni>|<mac>` → the Ethernet Segment a remote MAC is bound to. Runtime. */
  private readonly segmentMacs = new Map<string, Esi>();
  /**
   * `<vni>|<mac>` → the VTEP whose Type 2 route announced the address.
   *
   * With aliasing the advertiser and the forwarder are genuinely different
   * questions, so the answer to the first is kept rather than inferred from the
   * second. Runtime only.
   */
  private readonly multihomingAdvertisers = new Map<string, Ipv4>();
  /**
   * `<vni>|<mac>` → this VTEP's MAC Mobility state for an address it owns.
   *
   * Runtime only, and never persisted: a sequence number describes where an
   * address has been during *this* run, so rebuilding the lab starts it over —
   * which is exactly what the verifier does too.
   */
  private readonly macMobility = new Map<string, LocalMacMobility>();
  /** `<vni>|<mac>` → the highest sequence any peer advertised. Runtime only. */
  private readonly observedMacMobility = new Map<string, ObservedMacMobility>();
  /** The last sequence reported for an address, so a move is announced once. */
  private readonly observedMacSequences = new Map<string, number>();
  /**
   * `<vni>|<mac>` → the sequence this leaf has already conceded the address to.
   *
   * It is what stops two leaves that both genuinely see one address from
   * counting each other upwards for ever. Having lost at sequence N, this leaf
   * will not bid again until somebody moves the address past N — so a contested
   * address settles on one owner instead of oscillating. Full duplicate-MAC
   * dampening is deliberately out of scope; this only guarantees the loop ends.
   */
  private readonly concededMacMobility = new Map<string, number>();
  /** `<esi>|<vtep>` pairs backed by a per-ES A-D route, to spot a withdrawal. */
  private readonly lastEsReachability = new Set<string>();
  /** SVIs configured with `fabric forwarding mode anycast-gateway`. */
  private readonly anycastGatewayVlans = new Set<number>();

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
      hasVrf: (vrfId) => this.routingPlane.vrfs.configuration(vrfId) !== undefined,
    });
    // Symmetric IRB reaches the wire through the one VXLAN send path below, so
    // the routed plane never learns how to encapsulate and the overlay never
    // learns how to route.
    this.routingPlane.useEvpnRoutedOverlay({
      encapsulate: (input) => this.sendRoutedVxlan(input),
    });
    // An Ethernet Segment is an attachment property. The segment engine asks
    // these five questions and never reaches into the switch, exactly as the
    // overlay engine does.
    this.ethernetSegments.useHooks({
      interfaceExists: (name) => this.attachmentExists(name),
      interfaceEligible: (name) => this.attachmentEligible(name),
      interfaceOperationalUp: (name) => this.logicalPortOperationalUp(name),
      overlayVlansOf: (name) => this.overlayVlansOf(name),
      localVtep: () => this.vxlan.state().sourceAddress,
      // An alias is only usable if the packet can actually get there, so
      // underlay reachability is part of eligibility rather than something the
      // forwarding path discovers by failing.
      underlayReachable: (vtep) => this.routingPlane.overlayUnderlayReachable(vtep),
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

  // --- tenant VRFs ---------------------------------------------------------

  /**
   * Tenant VRFs on a VTEP.
   *
   * These delegate to the composed routing plane, so an L3 Switch gets exactly
   * the routing contexts a Router already has — an EVPN tenant is not a second
   * kind of VRF. MPLS/LDP stays Router-only; what an L3 Switch gains here is the
   * VRF as the isolation boundary a VXLAN L3VNI transports.
   */
  defineVrf(configuration: VrfConfiguration): void {
    this.syncRoutingPlane();
    this.routingPlane.defineVrf(configuration);
  }

  removeVrf(vrfId: string): void {
    this.routingPlane.vrfs.remove(vrfId);
  }

  vrfConfigurations(): readonly VrfConfiguration[] {
    return this.routingPlane.vrfConfigurations();
  }

  assignInterfaceVrf(interfaceName: string, vrfId: string | undefined): void {
    this.syncRoutingPlane();
    this.routingPlane.assignInterfaceVrf(interfaceName, vrfId);
  }

  /** `interface Vlan<n>` → `vrf forwarding <name>`. */
  setSviVrf(vlanId: number, vrfId: string | undefined): void {
    this.defineSvi(vlanId);
    this.routingPlane.assignInterfaceVrf(`Vlan${vlanId}`, vrfId);
  }

  interfaceVrf(interfaceName: string): string | undefined {
    return this.routingPlane.interfaceVrf(interfaceName);
  }

  addVrfStaticRoute(vrfId: string, network: Ipv4, prefixLength: number, nextHop: Ipv4): void {
    this.syncRoutingPlane();
    this.routingPlane.addVrfStaticRoute(vrfId, network, prefixLength, nextHop);
  }

  vrfStaticRouteConfigurations(vrfId: string): readonly VrfRoute[] {
    return this.routingPlane.vrfStaticRouteConfigurations(vrfId);
  }

  /** `show ip route vrf <name>`: connected, static and imported Type 5 prefixes. */
  vrfRoutingTable(vrfId: string): readonly VrfRoute[] {
    this.syncRoutingPlane();
    this.routingPlane.bgp.refreshSessionState();
    return this.routingPlane.vrfRoutingTable(vrfId);
  }

  /**
   * Install the EVPN Type 5 prefixes the control plane selected. Route targets
   * decide which VRF each one lands in, so this is the single point where an
   * overlay prefix becomes tenant forwarding state. Runtime only.
   */
  replaceImportedEvpnRoutes(routes: readonly ImportedEvpnPrefixRoute[]): void {
    this.routingPlane.vrfs.replaceImportedEvpn(routes);
  }

  /** The Type 5 prefixes one VRF installed, for `show` and grading. */
  importedEvpnRoutes(vrfId: string): readonly VrfRoute[] {
    this.syncRoutingPlane();
    this.routingPlane.bgp.refreshSessionState();
    return this.routingPlane.vrfs.importedEvpnRouteConfigurations(vrfId);
  }

  // --- distributed anycast gateway -----------------------------------------

  /** `fabric forwarding anycast-gateway-mac <mac>`. */
  setFabricAnycastGatewayMac(mac: Mac | undefined): void {
    this.vxlan.configureFabric({ anycastGatewayMac: mac });
    this.refreshAnycastGatewayMacs();
  }

  fabricConfiguration(): EvpnFabricConfiguration {
    return this.vxlan.fabricConfiguration();
  }

  /**
   * `interface Vlan<n>` → `fabric forwarding mode anycast-gateway`.
   *
   * The SVI keeps its own IPv4 address but answers with the fabric-wide anycast
   * MAC, so every leaf that carries this tenant VLAN presents the *same* gateway
   * IP and MAC. A host therefore always talks to its own local leaf and its ARP
   * cache stays valid if it moves — which is the whole point of a distributed
   * gateway, and why this is never a duplicate-address conflict.
   */
  setSviAnycastGateway(vlanId: number, enabled: boolean): void {
    this.defineSvi(vlanId);
    if (enabled) this.anycastGatewayVlans.add(vlanId);
    else this.anycastGatewayVlans.delete(vlanId);
    this.refreshAnycastGatewayMacs();
  }

  isAnycastGateway(vlanId: number): boolean {
    return this.anycastGatewayVlans.has(vlanId);
  }

  anycastGatewayVlanIds(): number[] {
    return [...this.anycastGatewayVlans].sort((a, b) => a - b);
  }

  /** Re-stamp every anycast SVI, so the fabric MAC has exactly one owner. */
  private refreshAnycastGatewayMacs(): void {
    const anycast = this.vxlan.anycastGatewayMac;
    for (const [vlanId, svi] of this.svis) {
      const wanted = this.anycastGatewayVlans.has(vlanId) && anycast !== undefined
        ? anycast
        : this.sviMac(vlanId);
      if (normalizeMac(svi.mac) !== normalizeMac(wanted)) svi.mac = wanted;
    }
  }

  /** The IPv4 addresses this VTEP answers as a distributed gateway. */
  private anycastGatewayAddresses(): Set<Ipv4> {
    const addresses = new Set<Ipv4>();
    if (this.vxlan.anycastGatewayMac === undefined) return addresses;
    const rows = new Map(this.routingPlane.interfaceSummaries().map((row) => [row.name, row]));
    for (const vlanId of this.anycastGatewayVlans) {
      const ip = rows.get(`Vlan${vlanId}`)?.ip;
      if (ip !== undefined) addresses.add(ip);
    }
    return addresses;
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

  /** True for an ARP request whose target is one of this leaf's gateway IPs. */
  private isAnycastGatewayArpRequest(frame: EthernetFrame): boolean {
    const payload = frame.payload;
    if (payload.kind !== "arp") return false;
    const arp = payload as ArpPacket;
    if (arp.op !== ArpOp.Request) return false;
    this.syncRoutingPlane();
    return this.anycastGatewayAddresses().has(arp.targetIp);
  }

  /** `show nve vni`: the L3VNIs and the VRFs they transport. */
  l3VniSummaries(): L3VniOperationalState[] {
    this.syncRoutingPlane();
    return this.vxlan.l3VniStates();
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
    problems.push(...this.routedEvpnProblems());
    problems.push(...this.ethernetSegmentProblems());
    return [...new Set(problems)].sort();
  }

  /**
   * Routed-EVPN diagnostics: the distributed gateway, the L3VNI and the tenant
   * VRF that carries it.
   *
   * Only an *incomplete* configuration is reported. A leaf sharing one gateway
   * IP and MAC with every other leaf is the whole point of a distributed
   * gateway, so it is never a conflict, and a VRF that deliberately keeps its
   * prefixes local is never a warning either.
   */
  private routedEvpnProblems(): string[] {
    const problems: string[] = [];
    const anycastVlans = this.anycastGatewayVlanIds();
    const fabricMac = this.vxlan.anycastGatewayMac;
    if (anycastVlans.length > 0 && fabricMac === undefined) {
      problems.push(`${this.name} has SVIs in anycast-gateway mode but no 'fabric forwarding anycast-gateway-mac' is configured.`);
    }
    const svis = new Map(this.sviSummaries().map((row) => [row.vlanId, row]));
    for (const vlanId of anycastVlans) {
      const svi = svis.get(vlanId);
      if (svi === undefined) continue;
      if (svi.ip === undefined) {
        problems.push(`${this.name} Vlan${vlanId} is an anycast gateway but has no IPv4 address, so it can answer no host.`);
      }
    }
    const configuration = this.vxlan.configurationSnapshot();
    const vrfs = this.routingPlane.vrfConfigurations();
    const evpnActive = this.evpnAddressFamilyActive();
    for (const state of this.vxlan.l3VniStates()) {
      if (state.reason === "vrf-missing") {
        problems.push(`${this.name} L3VNI ${state.vni} names VRF ${state.vrfId}, which is not defined.`);
        continue;
      }
      if (!state.up && configuration !== undefined) {
        problems.push(`${this.name} L3VNI ${state.vni} for VRF ${state.vrfId} is not operational (${state.reason}).`);
      }
    }
    for (const vrf of vrfs) {
      const l3Vni = this.vxlan.l3VniForVrf(vrf.id);
      if (vrf.advertiseEvpn === true) {
        if (l3Vni === undefined) {
          problems.push(`${this.name} VRF ${vrf.id} advertises into EVPN but has no 'member vni <n> associate-vrf ${vrf.id}' L3VNI.`);
        }
        if (vrf.exportRouteTargets.length === 0) {
          problems.push(`${this.name} VRF ${vrf.id} advertises into EVPN but exports no route target, so no remote VTEP can import it.`);
        }
        if (!evpnActive) {
          problems.push(`${this.name} VRF ${vrf.id} advertises into EVPN but no neighbor activates 'address-family l2vpn evpn'.`);
        }
        continue;
      }
      // Everything is in place for a tenant to be advertised except the one
      // explicit statement that starts it — that is an unfinished tenant, not a
      // deliberate choice, so it is worth explaining.
      if (l3Vni !== undefined && evpnActive && vrf.exportRouteTargets.length > 0) {
        problems.push(`${this.name} VRF ${vrf.id} has L3VNI ${l3Vni} and an export route target but no 'advertise l2vpn evpn', so it originates no Type 5 prefix.`);
      }
    }
    // A Type 5 route whose targets match no local VRF stays in the EVPN RIB and
    // installs nothing; that rejection is what keeps two tenants isolated, so it
    // is reported as an explanation rather than left as silence.
    for (const route of this.routingPlane.bgp.evpnRoutes()) {
      if (route.type !== 5 || route.source === "local") continue;
      if (this.importVrfFor(route.routeTargets)) continue;
      problems.push(`${this.name} did not import EVPN Type 5 prefix ${route.network}/${route.prefixLength}: no VRF import route target matches.`);
    }
    return problems;
  }

  /**
   * Drop every routed-overlay table this VTEP learned; configuration is
   * untouched. The imported Type 5 prefixes are relearned from the EVPN RIB on
   * the next convergence, exactly as the verifier rebuilds them.
   */
  resetRoutedEvpnRuntime(): void {
    this.routingPlane.vrfs.replaceImportedEvpn([]);
    this.evpnFaults.clear();
    this.evpnExportSignature = "";
  }

  /**
   * `shutdown`/`no shutdown` on one L3VNI, as a bounded restart: the tenant's
   * imported prefixes are dropped and re-derived, and nothing else on the NVE
   * is disturbed.
   */
  restartL3Vni(vni: number): boolean {
    const vrfId = this.vxlan.vrfForL3Vni(vni);
    if (vrfId === undefined) return false;
    this.resetRoutedEvpnRuntime();
    this.routingPlane.bgp.refreshRoutes();
    return true;
  }

  /** Drop every learned overlay table; configuration is untouched. */
  resetVxlanRuntime(): void {
    this.vxlan.resetRuntime();
    this.ethernetSegments.resetRuntime();
    this.vxlanFaults.clear();
    this.evpnFaults.clear();
    this.evpnExportSignature = "";
    this.dfSignature = "";
    this.esExportSignature = "";
    this.multihomingPrimaries.clear();
    this.multihomingAdvertisers.clear();
    this.segmentMacs.clear();
    this.lastEsReachability.clear();
    // A sequence number describes where an address has been during this run, so
    // clearing the overlay's runtime starts mobility over — exactly as
    // rebuilding the lab in the verifier does.
    this.macMobility.clear();
    this.observedMacMobility.clear();
    this.observedMacSequences.clear();
    this.concededMacMobility.clear();
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
    const inner = vxlanInnerPayload(packet);
    this.traceVxlan("vxlan-packet-received", {
      vni: packet.vni,
      payloadKind: packet.payloadKind,
      sourceVtep: source,
      destinationVtep: datagram.destinationAddress,
      innerSource: inner.src,
      innerDestination: inner.dst,
    });
    if (packet.payloadKind === "l3") {
      this.receiveRoutedVxlan(packet, source);
      return;
    }
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
    const origin: FrameOrigin = {
      kind: "remote-vtep",
      peer: source,
      vni: packet.vni,
      esi: packet.sourceEsi,
    };
    this.switchIntoVlan(packet.innerFrame, member.vlanId, origin);
  }

  /**
   * The egress half of symmetric IRB: the VNI names the VRF, the VRF repeats
   * the IPv4 lookup, and the packet leaves on an ordinary local interface with
   * ordinary local ARP. There is no fallback to the global table — an L3VNI
   * whose VRF is gone drops the packet rather than leaking a tenant into it.
   */
  private receiveRoutedVxlan(packet: Extract<VxlanPacket, { payloadKind: "l3" }>, source: Ipv4): void {
    const vrfId = this.vxlan.vrfForL3Vni(packet.vni);
    const state = vrfId === undefined ? undefined : this.vxlan.l3VniState(packet.vni);
    if (vrfId === undefined || !state?.up) {
      this.traceVxlan("evpn-tenant-isolation-drop", {
        reason: vrfId === undefined ? "l3vni-not-mapped" : state?.reason ?? "l3vni-down",
        l3Vni: packet.vni,
        sourceVtep: source,
        destination: packet.innerPacket.dst,
      });
      this.recordEvpnFault(
        `l3vni-${packet.vni}-inbound`,
        `${this.name} received L3VNI ${packet.vni} from ${source} but has no operational VRF association.`,
      );
      return;
    }
    this.engine.controlProtocolBudget.consume("routedVxlanPackets", this.id);
    this.traceVxlan("evpn-l3vni-decapsulated", {
      l3Vni: packet.vni,
      vrfId,
      sourceVtep: source,
      source: packet.innerPacket.src,
      destination: packet.innerPacket.dst,
    });
    this.syncRoutingPlane();
    const outcome = this.routingPlane.receiveEvpnRoutedPacket(packet.innerPacket, vrfId);
    if (outcome === "dropped") {
      this.traceVxlan("evpn-tenant-isolation-drop", {
        reason: "no-egress-vrf-route",
        vrfId,
        l3Vni: packet.vni,
        destination: packet.innerPacket.dst,
      });
      this.recordEvpnFault(
        `l3vni-${packet.vni}-egress-${packet.innerPacket.dst}`,
        `${this.name} has no VRF ${vrfId} route to ${packet.innerPacket.dst} for traffic arriving on L3VNI ${packet.vni}.`,
      );
    }
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
    const target = this.selectRemoteMacPath(entry, frame);
    return this.sendVxlan(member.vni, target, frame, "unicast", this.frameSourceEsi(origin));
  }

  /**
   * Which VTEP one known-unicast frame is actually sent to.
   *
   * A single-homed or Single-Active address has exactly one answer, so this is
   * the entry's own VTEP. An **All-Active** address has several equally usable
   * ones, and the choice is made per *flow* rather than per address: every frame
   * of one conversation takes the same leaf, so nothing is ever reordered, and
   * one frame is never duplicated to every alias.
   */
  private selectRemoteMacPath(entry: RemoteMacEntry, frame: EthernetFrame): Ipv4 {
    if (entry.redundancyMode !== "all-active" || entry.aliasVteps.length < 2) return entry.remoteVtep;
    const esi = entry.ethernetSegmentId ?? "";
    const selected = this.ethernetSegments.selectAliasingVtep(
      entry.aliasVteps,
      this.aliasingFlowKey(esi, entry.vni, frame),
    ) ?? entry.remoteVtep;
    this.traceVxlan("evpn-aliasing-path-selected", {
      vni: entry.vni,
      mac: entry.mac,
      esi,
      eligible: [...entry.aliasVteps],
      selected,
    });
    return selected;
  }

  /**
   * The stable flow key an All-Active selection is made from.
   *
   * Only fields the engine actually models take part, and they are read in one
   * fixed order, so the same conversation always reaches the same leaf in the
   * browser worker and in the verifier. The segment and the VNI are part of the
   * key so two EVIs of one segment spread independently.
   */
  private aliasingFlowKey(esi: Esi, vni: number, frame: EthernetFrame): string {
    const parts: string[] = [esi, String(vni), normalizeMac(frame.src), normalizeMac(frame.dst)];
    const payload = frame.payload;
    if (payload.kind === "ipv4") {
      parts.push(payload.src, payload.dst, String(payload.protocol));
      const inner = payload.payload;
      if (inner.kind === "udp" || inner.kind === "tcp") {
        parts.push(String(inner.srcPort), String(inner.dstPort));
      }
    } else if (payload.kind === "ipv6") {
      parts.push(payload.src, payload.dst, String(payload.nextHeader));
      const inner = payload.payload;
      if (inner.kind === "udp" || inner.kind === "tcp") {
        parts.push(String(inner.srcPort), String(inner.dstPort));
      }
    }
    return parts.join("|");
  }

  /**
   * The Ethernet Segment a frame entered the fabric on, if any.
   *
   * It travels beside the packet as simulator metadata, never inside an
   * Ethernet or VXLAN header: it exists so another leaf attached to the same
   * segment can refuse to hand the frame back to the CE it came from.
   */
  private frameSourceEsi(origin: FrameOrigin): Esi | undefined {
    if (origin.kind !== "local-port") return undefined;
    return this.ethernetSegments.esiForInterface(this.logicalPortOf(origin.port));
  }

  protected override replicateToOverlay(frame: EthernetFrame, vlan: number, origin: FrameOrigin): void {
    const member = this.vxlan.memberForVlan(vlan);
    if (!member) return;
    // A host always uses its own local leaf as the default gateway, so an ARP
    // request for a distributed gateway address is answered here and never
    // replicated across the fabric. This is gateway-only: an ordinary remote
    // host is still resolved through the overlay, because ARP suppression for
    // tenant hosts is deliberately not modelled.
    if (this.isAnycastGatewayArpRequest(frame)) {
      this.traceVxlan("evpn-anycast-gateway-replied", {
        vlan,
        vni: member.vni,
        gateway: (frame.payload as ArpPacket).targetIp,
        gatewayMac: this.vxlan.anycastGatewayMac,
      });
      return;
    }
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
      if (this.sendVxlan(member.vni, peer, frame, "bum", this.frameSourceEsi(origin))) replicas++;
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
  private sendVxlan(
    vni: number,
    destination: Ipv4,
    frame: EthernetFrame,
    kind: "unicast" | "bum",
    sourceEsi?: Esi,
  ): boolean {
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
      sourceEsi,
    });
    return this.transmitVxlan(
      {
        kind: "vxlan",
        payloadKind: "l2",
        vni,
        innerFrame,
        sourceVtep: state.sourceAddress,
        destinationVtep: destination,
        sourceEsi,
      },
      kind,
    );
  }

  /**
   * Symmetric IRB egress: this VTEP has already routed the packet in the tenant
   * VRF, so what is encapsulated is a routed IPv4 packet inside the **L3VNI**,
   * not the destination's L2VNI. The remote VTEP will repeat the VRF lookup, so
   * neither side ever needs the other's bridging table.
   */
  private sendRoutedVxlan(input: {
    vrfId: string;
    l3Vni: number;
    remoteVtep: Ipv4;
    packet: Ipv4Packet;
  }): boolean {
    this.syncRoutingPlane();
    const state = this.vxlan.l3VniState(input.l3Vni);
    if (!state?.up || state.sourceAddress === undefined) {
      this.traceVxlan("evpn-tenant-isolation-drop", {
        reason: state === undefined ? "l3vni-not-configured" : state.reason ?? "l3vni-down",
        vrfId: input.vrfId,
        l3Vni: input.l3Vni,
        destination: input.packet.dst,
      });
      this.recordEvpnFault(
        `l3vni-${input.l3Vni}-down`,
        `${this.name} cannot route VRF ${input.vrfId} over L3VNI ${input.l3Vni}: the VNI is not operational.`,
      );
      return false;
    }
    this.engine.controlProtocolBudget.consume("routedVxlanPackets", this.id);
    this.traceVxlan("evpn-irb-routed", {
      vrfId: input.vrfId,
      l3Vni: input.l3Vni,
      source: input.packet.src,
      destination: input.packet.dst,
      remoteVtep: input.remoteVtep,
    });
    const sent = this.transmitVxlan(
      {
        kind: "vxlan",
        payloadKind: "l3",
        vni: input.l3Vni,
        innerPacket: input.packet,
        innerSourceMac: this.overlayRouterMac(),
        sourceVtep: state.sourceAddress,
        destinationVtep: input.remoteVtep,
      },
      "routed",
    );
    if (sent) {
      this.traceVxlan("evpn-l3vni-encapsulated", {
        vrfId: input.vrfId,
        l3Vni: input.l3Vni,
        sourceVtep: state.sourceAddress,
        destinationVtep: input.remoteVtep,
        destination: input.packet.dst,
      });
    }
    return sent;
  }

  /**
   * The one place a VXLAN packet reaches the wire, bridged or routed. The outer
   * IPv4/UDP datagram then travels the ordinary underlay path, so interface
   * state, ACLs, the firewall, QoS and packet loss all apply to it exactly as
   * they do to any other traffic.
   */
  private transmitVxlan(packet: VxlanPacket, kind: "unicast" | "bum" | "routed"): boolean {
    const { vni, destinationVtep, sourceVtep } = packet;
    const inner: VxlanInnerPayload = vxlanInnerPayload(packet);
    const bytes = estimateVxlanOuterSizeBytes(inner);
    if (bytes > VXLAN_UNDERLAY_MTU_BYTES) {
      this.traceVxlan("vxlan-mtu-exceeded", { vni, bytes, mtu: VXLAN_UNDERLAY_MTU_BYTES, destinationVtep, kind });
      this.recordVxlanFault(
        `vni-${vni}-mtu`,
        `${this.name} dropped a VNI ${vni} packet: ${bytes} bytes exceeds the ${VXLAN_UNDERLAY_MTU_BYTES}-byte underlay MTU.`,
      );
      return false;
    }
    if (!this.routingPlane.overlayUnderlayReachable(destinationVtep)) {
      this.traceVxlan("vxlan-underlay-unreachable", { vni, destinationVtep, kind });
      this.recordVxlanFault(
        `vtep-${destinationVtep}-unreachable`,
        `${this.name} has no underlay route to VTEP ${destinationVtep}.`,
      );
      return false;
    }
    this.routingPlane.management.udp.send({
      destinationAddress: destinationVtep,
      destinationPort: VXLAN_UDP_PORT,
      sourcePort: vxlanSourcePort(vni, inner),
      sourceAddress: sourceVtep,
      payload: packet,
    });
    this.traceVxlan("vxlan-packet-sent", { vni, kind, sourceVtep, destinationVtep, bytes });
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
    this.updateLocalMacMobility(member.vni, normalizeMac(mac), port);
    this.traceVxlan("vxlan-mac-learned-local", { vni: member.vni, vlan, mac: normalizeMac(mac), port });
    this.onOverlayMacTableChanged();
  }

  /**
   * The one place a MAC Mobility sequence number is decided.
   *
   * A sequence increments only when *ownership genuinely changes location*. It
   * deliberately does not increment because a BGP session reset, an NVE restart,
   * a re-rendered Type 2 route or a relearn on the same attachment happened —
   * none of those is a move, and treating them as one would make two leaves
   * chase each other upwards for ever.
   *
   * Two leaves of one All-Active Ethernet Segment share a **location**, so a
   * frame appearing on the second of them is aliasing rather than mobility. That
   * distinction lives here, once, instead of as an `if (esi)` in every path that
   * observes an address.
   */
  private updateLocalMacMobility(vni: number, mac: Mac, port: string): void {
    const key = `${vni}|${mac}`;
    const location = this.macLocationOf(port);
    const current = this.macMobility.get(key);
    // The same attachment — or another member of the same Ethernet Segment —
    // relearning the address is not a move at all.
    if (current?.location === location) return;
    const observed = this.observedMacMobility.get(key);
    const observedLocation = observed === undefined
      ? undefined
      : observed.esi ?? `vtep:${observed.vtep}`;
    if (observed === undefined || observedLocation === location) {
      // First local advertisement, or the fabric already believes the address
      // lives right here: sequence 0 unless this device already owns a higher
      // one from an earlier move of its own.
      if (this.macMobility.size < DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteMacsPerVtep) {
        this.macMobility.set(key, { sequence: current?.sequence ?? 0, location });
      }
      return;
    }
    // Having already lost this address at that sequence, this leaf does not bid
    // again: two leaves that both genuinely see one address would otherwise
    // count each other upwards for ever. It keeps the address locally at its own
    // sequence and simply loses the comparison, which is the stable answer.
    const conceded = this.concededMacMobility.get(key);
    if (conceded !== undefined && observed.sequence <= conceded) {
      this.macMobility.set(key, { sequence: current?.sequence ?? 0, location });
      this.traceVxlan("evpn-duplicate-mac-detected", {
        vni,
        mac,
        sequence: observed.sequence,
        owner: observed.vtep,
        location,
        reason: "already-conceded",
      });
      this.recordEvpnFault(
        `duplicate-${vni}-${mac}`,
        `${this.name} sees MAC ${mac} in VNI ${vni} locally, but the fabric holds it at ${observed.vtep}`
        + ` with sequence ${observed.sequence}; the local copy is not re-advertised as a move.`,
      );
      return;
    }
    // A genuine move: the address was somewhere else and is now here.
    const sequence = Math.max(observed.sequence, current?.sequence ?? 0) + 1;
    this.traceVxlan("evpn-mac-mobility-detected", {
      vni,
      mac,
      from: observedLocation,
      to: location,
      previousSequence: observed.sequence,
    });
    if (this.macMobility.size >= DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteMacsPerVtep
      && !this.macMobility.has(key)) return;
    this.macMobility.set(key, { sequence, location });
    this.traceVxlan("evpn-mac-mobility-sequence-incremented", {
      vni,
      mac,
      sequence,
      previousSequence: observed.sequence,
      location,
    });
  }

  /**
   * Where an address lives, for mobility purposes.
   *
   * An Ethernet Segment *is* the location when there is one, because every leaf
   * attached to it is the same place as far as the fabric is concerned. Only a
   * single-homed port is a location of its own.
   */
  private macLocationOf(port: string): string {
    const esi = this.ethernetSegments.esiForInterface(this.logicalPortOf(port));
    return esi ?? `local:${this.logicalPortOf(port)}`;
  }

  /** The mobility sequence this VTEP advertises for one address it owns. */
  macMobilitySequence(vni: number, mac: Mac): number {
    return this.macMobility.get(`${vni}|${normalizeMac(mac)}`)?.sequence ?? 0;
  }

  /**
   * Every address whose mobility this VTEP tracks, local and observed.
   *
   * Runtime only: the browser worker and the verifier rebuild all of it by
   * replaying the same learns and the same BGP UPDATEs.
   */
  macMobilityStates(): EvpnMacMobilityState[] {
    this.syncRoutingPlane();
    const keys = new Set([...this.macMobility.keys(), ...this.observedMacMobility.keys()]);
    return [...keys]
      .map((key): EvpnMacMobilityState => {
        const [vniText, mac] = key.split("|") as [string, Mac];
        const owned = this.macMobility.get(key);
        const observed = this.observedMacMobility.get(key);
        // Whichever sequence is higher is where the fabric agrees the address
        // is, and this leaf's own copy is no exception to that rule.
        const localWins = owned !== undefined && owned.sequence >= (observed?.sequence ?? -1);
        const sequence = Math.max(owned?.sequence ?? 0, observed?.sequence ?? 0);
        return {
          vni: Number(vniText),
          macAddress: mac,
          sequence,
          owner: localWins ? "local" : observed!.vtep,
          location: localWins
            ? owned!.location
            : observed!.esi ?? `vtep:${observed!.vtep}`,
          previousOwner: localWins ? observed?.vtep : undefined,
          state: owned !== undefined && observed !== undefined && observed.sequence > owned.sequence
            ? "superseded"
            : sequence === 0 ? "stable" : "moved",
        };
      })
      .sort((a, b) => a.vni - b.vni || a.macAddress.localeCompare(b.macAddress));
  }

  // --- EVPN Ethernet Segments (Single-Active multihoming) -------------------

  /** Whether a name is a switchport or a Port-channel that exists here. */
  private attachmentExists(name: string): boolean {
    if (this.interfaces.has(name)) return true;
    const channelId = parsePortChannelName(name);
    return channelId !== undefined && this.etherChannel.hasChannel(channelId);
  }

  /**
   * Whether an attachment may carry an Ethernet Segment.
   *
   * A segment names the port a CE hangs off, so it is a switchport — never a
   * Loopback, an SVI, `nve1` or a routed core port. Nor is a *bundled member*
   * accepted: the bundle is the attachment, and accepting both would give one
   * CE two segments.
   *
   * A bare physical port stays the access port M10.16 defined. A Port-channel
   * may also be a trunk, because a CE-facing bundle is normally VLAN-aware and
   * the election is already per `<ESI, VLAN>` — it became bindable in M10.17,
   * once the logical bundle survived a configuration round-trip.
   */
  private attachmentEligible(name: string): boolean {
    if (name === NVE_INTERFACE_ID || /^(Loopback|Vlan)/iu.test(name)) return false;
    if (!this.attachmentExists(name)) return false;
    if (this.routedPorts.has(name)) return false;
    if (this.etherChannel.channelOf(name) !== undefined) return false;
    const mode = this.portConfigOf(name).mode;
    return mode === "access" || (mode === "trunk" && parsePortChannelName(name) !== undefined);
  }

  /** The VLANs one attachment carries that are actually mapped to an L2VNI. */
  private overlayVlansOf(name: string): number[] {
    if (!this.attachmentExists(name)) return [];
    return this.vlansCarriedBy(this.logicalPortOf(name))
      .filter((vlanId) => this.vxlan.memberForVlan(vlanId) !== undefined);
  }

  /** `evpn ethernet-segment <name>`: define or replace one segment atomically. */
  configureEthernetSegment(configuration: EvpnEthernetSegmentConfiguration): void {
    this.ethernetSegments.configure(configuration);
    this.onEthernetSegmentChanged("configured");
  }

  removeEthernetSegment(id: string): void {
    if (this.ethernetSegments.remove(id)) this.onEthernetSegmentChanged("removed");
  }

  /** `interface <port>` → `ethernet-segment <name>`: attach one interface. */
  attachEthernetSegment(port: string, id: string): void {
    const current = this.ethernetSegments.configuration(id);
    if (!current) {
      throw new ControlProtocolConfigurationError(`Ethernet Segment '${id}' is not defined`, "id");
    }
    this.ethernetSegments.configure({ ...current, interfaces: [...current.interfaces, port] });
    this.onEthernetSegmentChanged("attached");
  }

  detachEthernetSegment(port: string): void {
    if (this.ethernetSegments.detachInterface(port)) this.onEthernetSegmentChanged("detached");
  }

  ethernetSegmentConfigurations(): EvpnEthernetSegmentConfiguration[] {
    return this.ethernetSegments.configurations();
  }

  ethernetSegmentStates(): EvpnEthernetSegmentState[] {
    this.syncRoutingPlane();
    return this.ethernetSegments.states();
  }

  ethernetSegmentPeers(): EvpnEsPeer[] {
    this.syncRoutingPlane();
    return this.ethernetSegments.peers();
  }

  /** Every `<ESI, VLAN>` Designated Forwarder result this leaf computed. */
  designatedForwarderStates(): EvpnDfState[] {
    this.syncRoutingPlane();
    return this.ethernetSegments.dfStates();
  }

  /** The ESI an attachment belongs to, or `undefined` when it is single-homed. */
  ethernetSegmentIdOf(port: string): Esi | undefined {
    return this.ethernetSegments.esiForInterface(this.logicalPortOf(port));
  }

  /**
   * A segment's operational state changed: re-run the election and let BGP
   * re-advertise. A segment that just went down withdraws its Type 4 in the same
   * pass, which is what a remote leaf sees as the segment disappearing.
   */
  private onEthernetSegmentChanged(cause: string): void {
    this.traceVxlan("evpn-es-state-changed", {
      cause,
      segments: this.ethernetSegments.states().map((state) => ({
        esi: state.esi,
        up: state.up,
        reason: state.reason,
      })),
    });
    this.runDesignatedForwarderElection(cause);
    this.traceEthernetSegmentOrigination();
    if (this.evpnAddressFamilyActive()) {
      this.evpnExportSignature = "";
      this.routingPlane.bgp.refreshRoutes();
    }
  }

  /**
   * Report the Type 4 routes that started or stopped existing.
   *
   * A segment losing its last attachment is exactly a withdrawal, so the two
   * events are derived from one signature rather than reported by two separate
   * code paths that could disagree.
   */
  private traceEthernetSegmentOrigination(): void {
    const sourceAddress = this.vxlan.state().sourceAddress;
    const active = this.evpnAddressFamilyActive() && sourceAddress !== undefined
      ? this.ethernetSegments.states()
        .filter((state) => state.up && this.esRouteTargetsFor(state.vlanIds).length > 0)
        .map((state) => state.esi)
      : [];
    const signature = [...active].sort().join(",");
    if (signature === this.esExportSignature) return;
    const before = new Set(this.esExportSignature.split(",").filter(Boolean));
    const after = new Set(active);
    this.esExportSignature = signature;
    for (const esi of [...after].filter((entry) => !before.has(entry)).sort()) {
      this.traceVxlan("evpn-es-route-originated", {
        addressFamily: "l2vpn-evpn",
        routeType: 4,
        esi,
        vtep: sourceAddress,
      });
      // The segment route and its Ethernet A-D routes appear together: one says
      // the segment exists, the other that this VTEP can still serve it.
      this.traceVxlan("evpn-ad-route-originated", {
        addressFamily: "l2vpn-evpn",
        routeType: 1,
        esi,
        vtep: sourceAddress,
      });
    }
    for (const esi of [...before].filter((entry) => !after.has(entry)).sort()) {
      this.traceVxlan("evpn-es-route-withdrawn", {
        addressFamily: "l2vpn-evpn",
        routeType: 4,
        esi,
        vtep: sourceAddress,
      });
      this.traceVxlan("evpn-ad-route-withdrawn", {
        addressFamily: "l2vpn-evpn",
        routeType: 1,
        esi,
        vtep: sourceAddress,
      });
    }
  }

  /**
   * Re-run every `<ESI, VLAN>` election and report only what actually moved.
   *
   * Each participating leaf runs this independently over the same canonically
   * ordered candidate list, so they all reach the same answer without one of
   * them ever telling another what it decided.
   */
  private runDesignatedForwarderElection(cause: string): void {
    const states = this.ethernetSegments.dfStates();
    const signature = states
      .map((state) => [
        state.esi,
        state.vlanId,
        state.designatedForwarder ?? "",
        state.localRole,
        // A silent switch between algorithms would change the winner without a
        // single trace line, so the effective one is part of the signature.
        state.effectiveAlgorithm,
        state.backupDesignatedForwarder ?? "",
      ].join("|"))
      .join("\n");
    if (signature === this.dfSignature) return;
    const previous = new Map(this.dfSignature.split("\n").filter(Boolean).map((line) => {
      const [esi, vlanId, df, role] = line.split("|");
      return [`${esi}|${vlanId}`, { df, role }] as const;
    }));
    this.dfSignature = signature;
    if (states.length > 0) {
      this.engine.controlProtocolBudget.consume("dfElections", this.id);
      this.traceVxlan("evpn-df-election-started", {
        cause,
        segments: [...new Set(states.map((state) => state.esi))],
      });
    }
    for (const state of states) {
      const before = previous.get(`${state.esi}|${state.vlanId}`);
      this.traceVxlan("evpn-df-elected", {
        esi: state.esi,
        vlan: state.vlanId,
        candidates: state.candidates,
        designatedForwarder: state.designatedForwarder,
        backupDesignatedForwarder: state.backupDesignatedForwarder,
        localRole: state.localRole,
        requestedAlgorithm: state.requestedAlgorithm,
        effectiveAlgorithm: state.effectiveAlgorithm,
        weights: state.candidateWeights,
      });
      // Falling back is informational: the segment still elects one forwarder,
      // it simply does it the way every participant can.
      if (state.fallbackReason !== undefined) {
        this.traceVxlan("evpn-df-algorithm-fallback", {
          esi: state.esi,
          vlan: state.vlanId,
          requestedAlgorithm: state.requestedAlgorithm,
          effectiveAlgorithm: state.effectiveAlgorithm,
          reason: state.fallbackReason,
        });
      }
      if (before && before.role !== state.localRole) {
        this.traceVxlan("evpn-df-role-changed", {
          esi: state.esi,
          vlan: state.vlanId,
          from: before.role,
          to: state.localRole,
          designatedForwarder: state.designatedForwarder,
        });
        // Losing the role means this attachment no longer reaches those hosts,
        // so what it learned there has to go — and only that. Every other port's
        // entries in the same VLAN stay exactly where they were.
        if (state.localRole === "non-df") {
          for (const port of this.ethernetSegments.segmentForEsi(state.esi)?.interfaces ?? []) {
            this.flushForwardingOnPort(this.logicalPortOf(port), state.vlanId);
          }
        }
      }
    }
  }

  /**
   * Which advertisement of one `<VNI, MAC>` wins, and why.
   *
   * MAC Mobility is applied **before** the best-path comparator, exactly as
   * RFC 7432 §15 describes: the highest sequence number identifies where the
   * address actually is now, and every lower one is a stale memory of where it
   * used to be. Only the survivors are then compared, so there is still exactly
   * one comparator and no EVPN-specific fork of it.
   *
   * Two advertisements that share one non-zero ESI are not a conflict at all:
   * they are two leaves of the same Ethernet Segment describing the same place,
   * which is what All-Active aliasing looks like from here.
   */
  private selectMacRoute(vni: number, mac: Mac, candidates: readonly EvpnRoute[]): EvpnRoute | undefined {
    const sequenceOf = (route: EvpnRoute): number =>
      route.type === 2 ? route.mobility?.sequence ?? 0 : 0;
    const highest = Math.max(...candidates.map(sequenceOf));
    const current = candidates.filter((route) => sequenceOf(route) === highest);
    for (const stale of candidates.filter((route) => sequenceOf(route) !== highest)) {
      this.traceVxlan("evpn-stale-mac-route-rejected", {
        vni,
        mac,
        vtep: evpnOriginatingVtep(stale),
        sequence: sequenceOf(stale),
        currentSequence: highest,
      });
    }
    const ordered = [...current].sort(compareEvpnPaths);
    const winner = ordered[0];
    if (winner === undefined) return undefined;
    this.observedMacMobility.set(`${vni}|${mac}`, {
      sequence: highest,
      vtep: evpnOriginatingVtep(winner),
      esi: winner.type === 2 && winner.ethernetSegmentId !== undefined && winner.ethernetSegmentId !== ESI_ZERO
        ? winner.ethernetSegmentId
        : undefined,
    });
    const previous = this.observedMacSequences.get(`${vni}|${mac}`);
    if (previous !== undefined && highest > previous) {
      this.traceVxlan("evpn-mac-route-superseded", {
        vni,
        mac,
        previousSequence: previous,
        sequence: highest,
        owner: evpnOriginatingVtep(winner),
      });
    }
    this.observedMacSequences.set(`${vni}|${mac}`, highest);
    if (ordered.length < 2) return winner;
    // Same address, same highest sequence, genuinely different places. Full
    // duplicate-MAC dampening is out of scope, so a deterministic temporary
    // winner is chosen and the conflict is named rather than left to oscillate.
    const locations = new Set(ordered.map((route) => {
      const esi = route.type === 2 ? route.ethernetSegmentId : undefined;
      return esi !== undefined && esi !== ESI_ZERO ? esi : `vtep:${evpnOriginatingVtep(route)}`;
    }));
    if (locations.size < 2) return winner;
    this.traceVxlan("evpn-duplicate-mac-detected", {
      vni,
      mac,
      sequence: highest,
      vteps: ordered.map((route) => evpnOriginatingVtep(route)),
      selected: evpnOriginatingVtep(winner),
    });
    this.recordEvpnFault(
      `duplicate-${vni}-${mac}`,
      `${this.name} received MAC ${mac} in VNI ${vni} from ${ordered.length} locations at sequence ${highest};`
      + ` ${evpnOriginatingVtep(winner)} was selected.`,
    );
    return winner;
  }

  /**
   * Give up an address this leaf still claims but the fabric has moved on from.
   *
   * A station that walked away leaves its old leaf holding a stale local entry
   * with a *lower* sequence number. Keeping it would make the leaf go on
   * advertising a location that no longer exists, so the entry is forgotten —
   * that address only, never the whole port — and the withdrawal follows on the
   * next export. Returns `true` when the address stays local for now, so the
   * caller does not install a remote entry pointing back at this device.
   */
  private releaseSupersededLocalMac(vni: number, mac: Mac, winner: EvpnRoute): boolean {
    const key = `${vni}|${mac}`;
    const owned = this.macMobility.get(key);
    if (owned === undefined) return false;
    const sequence = winner.type === 2 ? winner.mobility?.sequence ?? 0 : 0;
    // A route from somewhere this leaf already *is* — the other member of one
    // All-Active segment — is not a competing location at all.
    const winnerEsi = winner.type === 2 ? winner.ethernetSegmentId : undefined;
    if (winnerEsi !== undefined && winnerEsi !== ESI_ZERO && winnerEsi === owned.location) return true;
    if (sequence <= owned.sequence) return true;
    const vlanId = this.vxlan.memberForVni(vni)?.vlanId;
    // The same event from both sides: a newer route replaced this leaf's, and
    // this leaf's is the stale one being refused.
    this.traceVxlan("evpn-mac-route-superseded", {
      vni,
      mac,
      previousSequence: owned.sequence,
      sequence,
      owner: evpnOriginatingVtep(winner),
    });
    this.traceVxlan("evpn-stale-mac-route-rejected", {
      vni,
      mac,
      vtep: this.vxlan.state().sourceAddress,
      sequence: owned.sequence,
      currentSequence: sequence,
      owner: evpnOriginatingVtep(winner),
    });
    this.macMobility.delete(key);
    // Having lost at this sequence, this leaf will not bid again until somebody
    // moves the address past it. That is what keeps a contested address from
    // making two leaves count each other upwards for ever.
    this.concededMacMobility.set(key, sequence);
    if (vlanId !== undefined) this.forgetLocalMac(vlanId, mac);
    // The stale Type 2 has to be withdrawn, and the signature is what decides
    // whether anything is re-advertised at all.
    this.evpnExportSignature = "";
    return false;
  }

  /**
   * The one place a remote MAC's forwarding VTEP is decided.
   *
   * A single-homed MAC is forwarded to the VTEP that advertised it, exactly as
   * before M10.16. A MAC behind a multihomed segment is forwarded to the
   * segment's *current Designated Forwarder* instead — which is why a mass
   * withdrawal moves traffic without any MAC being relearned, and why this
   * dependency lives in one function rather than as an `if (esi)` scattered
   * through the forwarding paths.
   */
  private resolveMultihomingPath(
    vni: number,
    mac: Mac,
    esi: Esi | undefined,
    advertised: Ipv4,
  ): MultihomingPath | undefined {
    if (esi === undefined || esi === ESI_ZERO) return { primary: advertised, backups: [], aliases: [] };
    const mode = this.ethernetSegments.segmentForEsi(esi)?.redundancyMode
      ?? this.ethernetSegments.redundancyModeOf(esi, advertised)
      ?? "single-active";
    if (mode === "all-active") return this.resolveAliasingPath(vni, mac, esi, advertised);
    const vlanId = this.vxlan.memberForVni(vni)?.vlanId;
    const eligible = this.ethernetSegments.dfCandidates(esi)
      .filter((vtep) => this.ethernetSegments.hasEsReachability(esi, vtep));
    if (eligible.length === 0) {
      // Every Type 1 per-ES route for this segment is gone, so nothing behind it
      // is reachable — the MAC is deliberately not installed rather than being
      // pointed at a VTEP that has already told us it cannot deliver.
      this.traceVxlan("evpn-es-unreachable", { vni, mac, esi, advertisedBy: advertised });
      this.recordEvpnFault(
        `es-${esi}-unreachable`,
        `${this.name} holds MAC ${mac} behind Ethernet Segment ${esi} but no VTEP advertises Ethernet A-D reachability for it.`,
      );
      return undefined;
    }
    const primary = (vlanId === undefined ? undefined : electDesignatedForwarder(eligible, vlanId)) ?? eligible[0]!;
    // This device is now the segment's own forwarder, so the address is behind
    // a local attachment rather than the overlay: it must not become a remote
    // MAC pointing at ourselves. Ordinary flooding and learning find it.
    if (primary === this.vxlan.state().sourceAddress) return undefined;
    const backups = eligible
      .filter((vtep) => vtep !== primary && this.ethernetSegments.hasEviReachability(esi, vni, vtep));
    if (backups.length === 0 && eligible.length > 1) {
      this.recordEvpnFault(
        `es-${esi}-no-backup`,
        `${this.name} has no Ethernet A-D per-EVI backup for Ethernet Segment ${esi} in VNI ${vni}.`,
      );
    }
    return { primary, backups, aliases: [], ethernetSegmentId: esi, redundancyMode: "single-active" };
  }

  /**
   * All-Active: every eligible VTEP is a live path, not a standby.
   *
   * The Designated Forwarder does **not** own known-unicast forwarding here, so
   * the address resolves to the whole eligible set and one member of it is
   * chosen per flow at forwarding time. Eligibility itself is decided in one
   * place — `EthernetSegmentEngine.aliasingCandidates` — so no forwarding branch
   * has to repeat the Type 1/Type 4/underlay/mode tests for itself.
   *
   * The address does *not* have to be advertised by every leaf. A Type 2 route
   * from one leaf plus a per-EVI Type 1 from another is exactly what makes the
   * second leaf usable, which is the whole point of aliasing.
   */
  private resolveAliasingPath(
    vni: number,
    mac: Mac,
    esi: Esi,
    /** Only reported: an alias set outlives the route that first announced it. */
    advertised: Ipv4 | undefined,
  ): MultihomingPath | undefined {
    const eligible = this.ethernetSegments.aliasingCandidates(esi, vni);
    if (eligible.length === 0) {
      this.traceVxlan("evpn-aliasing-no-path", { vni, mac, esi, advertisedBy: advertised });
      this.recordEvpnFault(
        `es-${esi}-no-alias`,
        `${this.name} holds MAC ${mac} behind All-Active Ethernet Segment ${esi} but no VTEP offers a usable aliasing path in VNI ${vni}.`,
      );
      return undefined;
    }
    // The default programmed path is the flow-independent one, so a table row, a
    // `show` line and a grading check all agree before any packet is sent.
    const selected = this.ethernetSegments.selectAliasingVtep(eligible, `${esi}|${vni}|${mac}`) ?? eligible[0]!;
    this.traceVxlan("evpn-aliasing-path-resolved", {
      vni,
      mac,
      esi,
      advertisedBy: advertised,
      eligible,
      selected,
      redundancyMode: "all-active",
    });
    return {
      primary: selected,
      backups: [],
      aliases: eligible,
      ethernetSegmentId: esi,
      redundancyMode: "all-active",
    };
  }

  /**
   * Every All-Active alias set this leaf currently holds, for inspection.
   *
   * Runtime only: the eligible set and the selection are rebuilt from the
   * Ethernet Segment configuration and the imported routes, identically in the
   * browser worker and in the verifier.
   */
  aliasingPathSets(): EvpnAliasingPathSet[] {
    this.syncRoutingPlane();
    return this.vxlan.remoteMacEntries()
      .flatMap((row): EvpnAliasingPathSet[] => {
        const esi = row.ethernetSegmentId;
        if (esi === undefined || row.redundancyMode !== "all-active") return [];
        return [{
          esi,
          vni: row.vni,
          macAddress: row.mac,
          advertisingVtep: this.multihomingAdvertisers.get(`${row.vni}|${row.mac}`) ?? row.remoteVtep,
          eligibleVteps: [...row.aliasVteps],
          selectedVtep: row.remoteVtep,
          redundancyMode: "all-active",
          reason: row.aliasVteps.length === 0 ? "no-usable-path" : "all-active-aliasing",
        }];
      });
  }

  /** Program one resolved remote MAC and report what moved, once. */
  private installMultihomedRemoteMac(
    vni: number,
    mac: Mac,
    path: MultihomingPath,
    advertisedBy: Ipv4,
  ): void {
    const key = `${vni}|${mac}`;
    if (path.ethernetSegmentId === undefined) {
      this.segmentMacs.delete(key);
      this.multihomingAdvertisers.delete(key);
    } else if (this.segmentMacs.size < DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumRemoteMacsPerVtep) {
      this.segmentMacs.set(key, path.ethernetSegmentId);
      this.multihomingAdvertisers.set(key, advertisedBy);
    }
    if (!this.vxlan.learnRemoteMac(vni, mac, path.primary, this.engine.now(), "bgp-evpn", {
      ethernetSegmentId: path.ethernetSegmentId,
      backupVteps: path.backups,
      aliasVteps: path.aliases,
      redundancyMode: path.redundancyMode,
    })) return;
    this.traceVxlan("vxlan-mac-learned-remote", {
      vni,
      mac,
      remoteVtep: path.primary,
      esi: path.ethernetSegmentId,
      backups: path.backups,
      aliases: path.aliases,
      source: "bgp-evpn",
    });
    if (path.ethernetSegmentId === undefined) return;
    if (path.redundancyMode === "all-active") {
      // All-Active has no primary in the Single-Active sense: every eligible
      // VTEP is live, and which one a flow takes is decided per flow.
      this.traceVxlan("evpn-aliasing-path-installed", {
        vni,
        mac,
        esi: path.ethernetSegmentId,
        eligible: path.aliases,
        selected: path.primary,
        advertisedBy,
      });
    } else {
      this.traceVxlan("evpn-multihoming-primary-selected", {
        vni,
        mac,
        esi: path.ethernetSegmentId,
        primary: path.primary,
        advertisedBy,
      });
      for (const backup of path.backups) {
        this.traceVxlan("evpn-multihoming-backup-selected", {
          vni, mac, esi: path.ethernetSegmentId, backup,
        });
      }
    }
    const previous = this.multihomingPrimaries.get(key);
    if (previous !== undefined && previous !== path.primary) {
      this.traceVxlan("evpn-multihoming-failover", {
        vni, mac, esi: path.ethernetSegmentId, from: previous, to: path.primary,
      });
    }
    this.multihomingPrimaries.set(key, path.primary);
  }

  /**
   * Keep a MAC reachable through its Ethernet Segment after its MAC route is
   * gone.
   *
   * This is what makes a mass withdrawal *fast*: the failed leaf's Type 2
   * routes disappear with its attachment, but the segment is still reachable
   * through another leaf's Ethernet A-D per-EVI route, so the address is
   * redirected to that leaf instead of having to be learned all over again. The
   * association is dropped the moment no VTEP advertises the segment for this
   * EVI any more, so nothing is kept alive that cannot actually deliver.
   */
  private retainSegmentBoundMacs(advertised: ReadonlyMap<string, EvpnRoute[]>): void {
    const stillAdvertised = new Set([...advertised.keys()].map((key) => key.replace(" ", "|")));
    for (const [key, esi] of [...this.segmentMacs].sort(([a], [b]) => a.localeCompare(b))) {
      if (stillAdvertised.has(key)) continue;
      const [vniText, mac] = key.split("|") as [string, Mac];
      const vni = Number(vniText);
      const path = this.resolveSegmentBackupPath(vni, mac, esi);
      if (!path) {
        this.segmentMacs.delete(key);
        this.multihomingPrimaries.delete(key);
        this.multihomingAdvertisers.delete(key);
        this.vxlan.forgetRemoteMac(vni, mac);
        continue;
      }
        this.installMultihomedRemoteMac(vni, mac, path, this.multihomingAdvertisers.get(key) ?? path.primary);
    }
  }

  /**
   * The VTEP that now serves one segment in one EVI after its MAC route is gone.
   *
   * Single-Active resolves to the Designated Forwarder with the remaining VTEPs
   * as backups; All-Active resolves to the whole eligible alias set, so losing
   * one path is a narrowing of that set rather than a relearn.
   */
  private resolveSegmentBackupPath(vni: number, mac: Mac, esi: Esi): MultihomingPath | undefined {
    if (this.ethernetSegments.segmentForEsi(esi)?.redundancyMode === "all-active"
      || this.ethernetSegments.peersForEsi(esi).some((peer) => peer.redundancyMode === "all-active")) {
      return this.resolveAliasingPath(vni, mac, esi, this.multihomingAdvertisers.get(`${vni}|${mac}`));
    }
    const vlanId = this.vxlan.memberForVni(vni)?.vlanId;
    const eligible = this.ethernetSegments.dfCandidates(esi)
      .filter((vtep) => this.ethernetSegments.hasEsReachability(esi, vtep)
        && this.ethernetSegments.hasEviReachability(esi, vni, vtep));
    if (eligible.length === 0) return undefined;
    const primary = (vlanId === undefined ? undefined : electDesignatedForwarder(eligible, vlanId)) ?? eligible[0]!;
    if (primary === this.vxlan.state().sourceAddress) return undefined;
    return {
      primary,
      backups: eligible.filter((vtep) => vtep !== primary),
      aliases: [],
      ethernetSegmentId: esi,
      redundancyMode: "single-active",
    };
  }

  /** Report every per-ES Ethernet A-D route that stopped existing. */
  private traceMassWithdrawal(current: readonly { esi: Esi; vtep: Ipv4 }[]): void {
    const next = new Set(current.map((entry) => `${entry.esi}|${entry.vtep}`));
    for (const key of [...this.lastEsReachability].sort()) {
      if (next.has(key)) continue;
      const [esi, vtep] = key.split("|") as [Esi, Ipv4];
      this.traceVxlan("evpn-es-mass-withdraw", {
        addressFamily: "l2vpn-evpn",
        routeType: 1,
        scope: "per-es",
        esi,
        vtep,
      });
    }
    this.lastEsReachability.clear();
    for (const key of next) this.lastEsReachability.add(key);
  }

  // --- Single-Active forwarding -------------------------------------------

  /**
   * Whether a frame may leave through one logical port.
   *
   * Split horizon is checked **first and independently of the DF role**: a frame
   * that entered the fabric on this very Ethernet Segment must never be handed
   * back to it, or a CE attached to two leaves would see its own frame return.
   * That is a property of where the frame came from, not of who is forwarding,
   * so it holds in All-Active exactly as it does in Single-Active.
   *
   * Only then does the redundancy rule apply. Single-Active keeps the standby
   * attachment silent; All-Active lets every operational attachment carry known
   * unicast and narrows the DF role to overlay BUM delivery alone.
   */
  protected override egressAllowedByOverlay(
    port: string,
    vlan: number,
    origin: FrameOrigin,
    delivery: "unicast" | "bum",
  ): boolean {
    const esi = this.ethernetSegments.esiForInterface(port);
    if (esi === undefined) return true;
    if (origin.kind === "remote-vtep" && origin.esi === esi) {
      this.traceVxlan("evpn-es-split-horizon-drop", {
        esi,
        vni: origin.vni,
        peer: origin.peer,
        port,
        vlan,
        delivery,
      });
      return false;
    }
    if (this.ethernetSegments.attachmentForwards(port, vlan, delivery)) return true;
    this.traceVxlan("evpn-non-df-egress-drop", {
      esi,
      vlan,
      port,
      delivery,
      redundancyMode: this.ethernetSegments.segmentForEsi(esi)?.redundancyMode,
      designatedForwarder: this.ethernetSegments.dfState(esi, vlan)?.designatedForwarder,
    });
    return false;
  }

  /**
   * Whether a frame arriving on one logical port may be relayed.
   *
   * In Single-Active the standby attachment carries no tenant data in either
   * direction, so a non-DF refuses the frame before it is learned. That is what
   * keeps a dual-attached CE from making both leaves advertise the same MAC. An
   * All-Active attachment is always live, so CE-originated traffic — including
   * BUM — may enter through any of them.
   */
  protected override ingressAllowedByOverlay(port: string, vlan: number): boolean {
    const esi = this.ethernetSegments.esiForInterface(port);
    if (esi === undefined) return true;
    if (this.ethernetSegments.attachmentAcceptsIngress(port, vlan)) return true;
    this.traceVxlan("evpn-non-df-ingress-drop", {
      esi,
      vlan,
      port,
      designatedForwarder: this.ethernetSegments.dfState(esi, vlan)?.designatedForwarder,
    });
    return false;
  }

  /** Diagnostics for the multihoming half of the overlay. */
  private ethernetSegmentProblems(): string[] {
    const problems: string[] = [];
    const evpnActive = this.evpnAddressFamilyActive();
    for (const state of this.ethernetSegmentStates()) {
      if (!state.up) {
        problems.push(`${this.name} Ethernet Segment ${state.id} (${state.esi}) is down: ${state.reason ?? "unknown"}.`);
        continue;
      }
      if (!evpnActive) {
        problems.push(`${this.name} Ethernet Segment ${state.id} needs 'address-family l2vpn evpn' before it can be discovered.`);
        continue;
      }
      if (this.esRouteTargetsFor(state.vlanIds).length === 0) {
        problems.push(`${this.name} Ethernet Segment ${state.id} exports no route target: add an 'evpn vni <n> l2' block for its VLAN.`);
      }
      if (state.vlanIds.length === 0) {
        problems.push(`${this.name} Ethernet Segment ${state.id} carries no VLAN that maps to a VNI.`);
      }
      const peers = this.ethernetSegments.peersForEsi(state.esi).filter((peer) => !peer.local);
      if (peers.length === 0) {
        problems.push(`${this.name} Ethernet Segment ${state.id} has no remote peer: no other VTEP advertises ESI ${state.esi}.`);
      }
      // Two leaves that disagree about who may forward would duplicate or
      // black-hole traffic, so a mode mismatch is named rather than left to
      // show up as intermittent loss.
      for (const peer of this.ethernetSegments.disagreeingPeers(state.esi)) {
        problems.push(`${this.name} Ethernet Segment ${state.id} is ${state.redundancyMode} but ${peer.vtep} advertises ${peer.redundancyMode}; the segment is not aliased to it.`);
      }
      for (const df of this.ethernetSegments.dfStates().filter((entry) => entry.esi === state.esi)) {
        if (df.designatedForwarder === undefined) {
          problems.push(`${this.name} has no eligible Designated Forwarder for ESI ${state.esi} VLAN ${df.vlanId}.`);
        } else if (df.localRole === "non-df" && state.redundancyMode === "single-active") {
          problems.push(`${this.name} is non-DF for ESI ${state.esi} VLAN ${df.vlanId}: ${df.designatedForwarder} forwards toward the CE.`);
        }
      }
    }
    // An All-Active address with no usable alias is unreachable, and saying so
    // is more useful than a silent drop at forwarding time.
    for (const row of this.aliasingPathSets()) {
      if (row.eligibleVteps.length > 0) continue;
      problems.push(`${this.name} has no usable aliasing path for MAC ${row.macAddress} behind Ethernet Segment ${row.esi} in VNI ${row.vni}.`);
    }
    return problems;
  }

  /**
   * The route targets an Ethernet Segment route carries.
   *
   * A segment has no route target of its own: it borrows the export targets of
   * the VNIs its attachment actually serves, so an RT mismatch isolates the
   * segment exactly as it isolates every other EVPN route, without a second
   * import rule to keep in step.
   */
  private esRouteTargetsFor(vlanIds: readonly number[]): string[] {
    const targets = new Set<string>();
    for (const vlanId of vlanIds) {
      const member = this.vxlan.memberForVlan(vlanId);
      if (!member) continue;
      for (const target of this.vxlan.evpnVni(member.vni)?.exportRouteTargets ?? []) targets.add(target);
    }
    return [...targets].sort();
  }

  /**
   * The Type 4 and Type 1 routes this VTEP originates for its local segments.
   *
   * Origination needs the segment up, the NVE operational, the EVPN family
   * active and at least one route target — the same four conditions its
   * withdrawal reverses, which is exactly what makes an attachment failure a
   * mass withdrawal rather than a slow trickle of per-MAC withdrawals.
   */
  private evpnMultihomingExports(sourceAddress: Ipv4, routerId: Ipv4): EvpnRoute[] {
    const segmentRoutes: EvpnRoute[] = [];
    const adRoutes: EvpnRoute[] = [];
    for (const state of this.ethernetSegments.states()) {
      if (!state.up) continue;
      const routeTargets = this.esRouteTargetsFor(state.vlanIds);
      if (routeTargets.length === 0) continue;
      const shared = {
        esi: state.esi,
        originatingVtep: sourceAddress,
        routeTargets,
        nextHop: sourceAddress,
        pathAttributes: {
          origin: "igp" as const,
          asPath: [] as readonly number[],
          nextHop: sourceAddress,
          localPreference: 100,
          med: 0,
        },
        ...this.localEvpnPathState(routerId),
      };
      segmentRoutes.push({
        ...shared,
        type: 4,
        routeDistinguisher: `${routerId}:0`,
        // The mode and the election travel with the segment route: a peer that
        // disagrees is reported rather than left to duplicate or black-hole
        // traffic, and HRW runs only once everyone can.
        redundancyMode: state.redundancyMode,
        dfAlgorithm: state.dfAlgorithm,
        routeId: `local:evpn:4:${state.esi}:${sourceAddress}`,
      });
      // Per-ES: "this VTEP still has a working attachment". One withdrawal
      // invalidates every MAC behind the segment at once.
      adRoutes.push({
        ...shared,
        type: 1,
        scope: "per-es",
        routeDistinguisher: `${routerId}:0`,
        routeId: `local:evpn:1:es:${state.esi}:${sourceAddress}`,
      });
      // Per-EVI: "this VTEP can serve the segment in this EVI", which is what
      // makes a deterministic backup selectable before anything has failed.
      for (const vlanId of state.vlanIds) {
        const member = this.vxlan.memberForVlan(vlanId);
        const evpn = member ? this.vxlan.evpnVni(member.vni) : undefined;
        if (!member || !evpn) continue;
        adRoutes.push({
          ...shared,
          type: 1,
          scope: "per-evi",
          routeDistinguisher: evpn.routeDistinguisher,
          ethernetTag: 0,
          vni: member.vni,
          routeTargets: [...evpn.exportRouteTargets],
          routeId: `local:evpn:1:evi:${state.esi}:${member.vni}:${sourceAddress}`,
        });
      }
    }
    enforceStructuralLimit("maximumEvpnEsRoutesPerDevice", segmentRoutes.length);
    enforceStructuralLimit("maximumEvpnAdRoutesPerDevice", adRoutes.length);
    return [...segmentRoutes, ...adRoutes];
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
    const localMacs = new Map<number, Array<{ mac: Mac; vlan: number; esi: Esi | undefined }>>();
    const anycastMac = this.vxlan.anycastGatewayMac;
    for (const row of this.macAddressTable()) {
      const member = this.vxlan.memberForVlan(row.vlan);
      if (!member) continue;
      // Every leaf owns the anycast gateway MAC, so advertising it would make
      // the fabric argue about which VTEP it lives behind. It is deliberately
      // never a Type 2 route.
      if (anycastMac !== undefined && normalizeMac(row.mac) === anycastMac) continue;
      const list = localMacs.get(member.vni) ?? [];
      if (list.length < DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumEvpnMacRoutesPerVni) {
        // A MAC learned behind a multihomed attachment carries its segment, so
        // the receiving leaf resolves it through the segment rather than
        // through this route's next hop.
        list.push({
          mac: normalizeMac(row.mac),
          vlan: row.vlan,
          esi: this.ethernetSegments.esiForInterface(row.port),
        });
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
        const sequence = this.macMobilitySequence(vni.vni, entry.mac);
        routes.push({
          ...shared,
          type: 2,
          macAddress: entry.mac,
          ethernetSegmentId: entry.esi,
          // Sequence 0 is the ordinary first advertisement, so it stays absent
          // and a pre-M10.17 route keeps exactly the bytes it had.
          ...(sequence === 0 ? {} : { mobility: { sequence } }),
          // The VNI is the delivery label in a VXLAN fabric.
          label: vni.vni,
          routeId: `local:evpn:2:${evpn.routeDistinguisher}:${vni.vni}:${entry.mac}`,
        });
      }
    }
    routes.push(...this.evpnMultihomingExports(state.sourceAddress, routerId));
    routes.push(...this.evpnPrefixExports(state.sourceAddress, routerId));
    void localAs;
    return routes.sort((a, b) => a.type - b.type
      || evpnRouteVni(a) - evpnRouteVni(b)
      || a.routeId.localeCompare(b.routeId));
  }

  /**
   * The Type 5 prefixes this VTEP originates.
   *
   * Origination is never implicit: a VRF must have a route distinguisher, an
   * export route target, an operational L3VNI *and* `advertise l2vpn evpn`
   * before any of its prefixes leave. Only connected and static IPv4 routes are
   * eligible — a prefix this VTEP itself imported from EVPN is never re-
   * originated, which is what stops two leaves advertising each other's
   * networks back and forth.
   */
  private evpnPrefixExports(sourceAddress: Ipv4, routerId: Ipv4): EvpnRoute[] {
    const routes: EvpnRoute[] = [];
    for (const vrf of this.routingPlane.vrfConfigurations()) {
      if (vrf.advertiseEvpn !== true) continue;
      if (vrf.exportRouteTargets.length === 0) continue;
      const l3Vni = this.vxlan.l3VniForVrf(vrf.id);
      if (l3Vni === undefined || this.vxlan.l3VniState(l3Vni)?.up !== true) continue;
      const eligible = this.routingPlane.vrfRoutingTable(vrf.id)
        .filter((route) => route.source === "connected" || route.source === "static");
      for (const route of eligible.slice(0, DEFAULT_CONTROL_PROTOCOL_LIMITS.maximumEvpnIpPrefixRoutesPerVrf)) {
        routes.push({
          type: 5,
          routeDistinguisher: vrf.routeDistinguisher,
          ethernetTag: 0,
          network: route.network,
          prefixLength: route.prefixLength,
          routeTargets: [...vrf.exportRouteTargets],
          l3Vni,
          nextHopVtep: sourceAddress,
          nextHop: sourceAddress,
          pathAttributes: {
            origin: "igp" as const,
            asPath: [] as readonly number[],
            nextHop: sourceAddress,
            localPreference: 100,
            med: 0,
          },
          ...this.localEvpnPathState(routerId),
          routeId: `local:evpn:5:${vrf.routeDistinguisher}:${route.network}/${route.prefixLength}`,
        });
      }
    }
    return routes;
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
    // The EVPN family may have come up after the segments were configured, so
    // origination is reported here too rather than only at configuration time.
    this.traceEthernetSegmentOrigination();
    const membership = new Map<number, Ipv4[]>();
    const macCandidates = new Map<string, EvpnRoute[]>();
    const prefixCandidates = new Map<string, Array<EvpnRoute & { type: 5 }>>();
    const esRoutes: Array<{
      esi: Esi;
      vtep: Ipv4;
      routerId?: Ipv4;
      redundancyMode?: EvpnRedundancyMode;
      dfAlgorithm?: EvpnDfAlgorithm;
    }> = [];
    const adPerEs: Array<{ esi: Esi; vtep: Ipv4 }> = [];
    const adPerEvi: Array<{ esi: Esi; vni: number; vtep: Ipv4 }> = [];
    for (const route of routes) {
      if (route.type === 1) {
        if (this.importVniFor(route.routeTargets) === undefined) {
          this.traceVxlan("evpn-rt-rejected", {
            addressFamily: "l2vpn-evpn",
            routeType: 1,
            rd: route.routeDistinguisher,
            esi: route.esi,
            scope: route.scope,
            routeTargets: route.routeTargets,
          });
          continue;
        }
        if (route.scope === "per-es") adPerEs.push({ esi: route.esi, vtep: route.originatingVtep });
        else adPerEvi.push({ esi: route.esi, vni: route.vni, vtep: route.originatingVtep });
        continue;
      }
      if (route.type === 4) {
        // A Type 4 is imported by the same route-target intersection as every
        // other EVPN route, so an RT mismatch isolates a segment exactly as it
        // isolates a MAC — there is no second import rule to keep in step.
        if (this.importVniFor(route.routeTargets) === undefined) {
          this.traceVxlan("evpn-rt-rejected", {
            addressFamily: "l2vpn-evpn",
            routeType: 4,
            rd: route.routeDistinguisher,
            esi: route.esi,
            routeTargets: route.routeTargets,
          });
          this.recordEvpnFault(
            `rt4-${route.esi}-${route.originatingVtep}`,
            `${this.name} did not import Ethernet Segment ${route.esi} from ${route.originatingVtep}: no local import route target matches.`,
          );
          continue;
        }
        esRoutes.push({
          esi: route.esi,
          vtep: route.originatingVtep,
          routerId: route.neighborRouterId,
          redundancyMode: route.redundancyMode,
          dfAlgorithm: route.dfAlgorithm,
        });
        continue;
      }
      if (route.type === 5) {
        // A Type 5 is imported by the *VRF's* route targets, not a VNI's: the
        // prefix belongs to a routing context, never to a broadcast domain.
        if (!this.importVrfFor(route.routeTargets)) {
          this.traceVxlan("evpn-type5-rt-rejected", {
            addressFamily: "l2vpn-evpn",
            routeType: 5,
            rd: route.routeDistinguisher,
            prefix: `${route.network}/${route.prefixLength}`,
            l3Vni: route.l3Vni,
            routeTargets: route.routeTargets,
          });
          this.recordEvpnFault(
            `rt5-${route.routeDistinguisher}-${route.network}`,
            `${this.name} did not import EVPN Type 5 prefix ${route.network}/${route.prefixLength}: no VRF import route target matches.`,
          );
          continue;
        }
        // Type 5 uniqueness is RD *and* prefix: two tenants may legitimately
        // advertise the very same network, and they must stay two routes.
        const key = `${route.routeDistinguisher}|${route.network}/${route.prefixLength}`;
        prefixCandidates.set(key, [...(prefixCandidates.get(key) ?? []), route]);
        continue;
      }
      const vni = this.importVniFor(route.routeTargets);
      if (vni === undefined) {
        this.traceVxlan("evpn-rt-rejected", {
          addressFamily: "l2vpn-evpn",
          routeType: route.type,
          rd: route.routeDistinguisher,
          vni: evpnRouteVni(route),
          routeTargets: route.routeTargets,
        });
        this.recordEvpnFault(
          `rt-${route.routeDistinguisher}-${evpnRouteVni(route)}`,
          `${this.name} did not import EVPN route ${route.routeDistinguisher} (VNI ${evpnRouteVni(route)}): no local import route target matches.`,
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
    // Ethernet Segment discovery runs before any MAC is programmed: a remote MAC
    // that sits behind a segment is only usable once that segment's reachability
    // is known, so the peer table has to exist first.
    const peersChanged = this.ethernetSegments.replaceEsRoutes(esRoutes);
    const reachabilityChanged = this.ethernetSegments.replaceAdRoutes(adPerEs, adPerEvi);
    if (peersChanged) {
      for (const peer of this.ethernetSegments.peers().filter((entry) => !entry.local)) {
        this.traceVxlan("evpn-es-peer-discovered", {
          addressFamily: "l2vpn-evpn",
          routeType: 4,
          esi: peer.esi,
          vtep: peer.vtep,
          routerId: peer.routerId,
        });
      }
    }
    if (reachabilityChanged) this.traceMassWithdrawal(adPerEs);
    if (peersChanged || reachabilityChanged) {
      // The election is re-run here rather than through the configuration path:
      // this is an imported-route change, so it must never re-enter BGP.
      this.runDesignatedForwarderElection("es-peer-changed");
    }
    this.observedMacMobility.clear();
    for (const [key, candidates] of macCandidates) {
      const [vniText, mac] = key.split(" ") as [string, Mac];
      const vni = Number(vniText);
      const winner = this.selectMacRoute(vni, mac, candidates);
      if (winner === undefined) continue;
      // A newer location supersedes whatever this leaf still believes, its own
      // local entry included.
      if (this.releaseSupersededLocalMac(vni, mac, winner)) continue;
      const path = this.resolveMultihomingPath(vni, mac, winner.type === 2 ? winner.ethernetSegmentId : undefined,
        evpnOriginatingVtep(winner));
      if (path === undefined) continue;
      this.installMultihomedRemoteMac(vni, mac, path, evpnOriginatingVtep(winner));
    }
    this.retainSegmentBoundMacs(macCandidates);
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
    this.installEvpnPrefixRoutes(prefixCandidates);
  }

  /**
   * Install the selected Type 5 prefixes into the tenant VRFs.
   *
   * One best path per prefix is chosen with the same deterministic comparator
   * the rest of BGP uses, then the VRF table decides — by route target alone —
   * which tenant may see it. A remote VTEP that lost its underlay route keeps
   * the route in the EVPN RIB but stops forwarding, which is what makes the
   * failure show up as `remote VTEP unreachable` rather than silence.
   */
  private installEvpnPrefixRoutes(candidates: ReadonlyMap<string, Array<EvpnRoute & { type: 5 }>>): void {
    const imported: ImportedEvpnPrefixRoute[] = [];
    for (const [, paths] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
      const best = [...paths].sort(compareEvpnPaths)[0]!;
      imported.push({
        routeDistinguisher: best.routeDistinguisher,
        network: best.network,
        prefixLength: best.prefixLength,
        routeTargets: [...best.routeTargets],
        l3Vni: best.l3Vni,
        nextHopVtep: evpnOriginatingVtep(best),
        metric: best.med,
      });
      this.traceVxlan("evpn-type5-imported", {
        addressFamily: "l2vpn-evpn",
        routeType: 5,
        rd: best.routeDistinguisher,
        prefix: `${best.network}/${best.prefixLength}`,
        l3Vni: best.l3Vni,
        nextHopVtep: evpnOriginatingVtep(best),
      });
      if (!this.routingPlane.overlayUnderlayReachable(evpnOriginatingVtep(best))) {
        this.recordEvpnFault(
          `vtep-${evpnOriginatingVtep(best)}-unreachable`,
          `${this.name} imported ${best.network}/${best.prefixLength} but has no underlay route to VTEP ${evpnOriginatingVtep(best)}.`,
        );
      }
    }
    enforceStructuralLimit("maximumEvpnIpPrefixRoutesPerDevice", imported.length);
    this.routingPlane.vrfs.replaceImportedEvpn(imported);
  }

  /** Whether any local VRF imports at least one of an advertised route's targets. */
  private importVrfFor(routeTargets: readonly string[]): boolean {
    const targets = new Set(routeTargets);
    return this.routingPlane.vrfConfigurations()
      .some((vrf) => vrf.importRouteTargets.some((target) => targets.has(target)));
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
    this.traceEthernetSegmentOrigination();
    // The mobility sequence is part of the signature: a move that keeps the
    // same route id still has to be re-advertised, or the fabric would never
    // hear that the address is now here.
    const signature = this.evpnExports()
      .map((route) => `${route.routeId}|${route.type === 2 ? route.mobility?.sequence ?? 0 : ""}`)
      .join("\n");
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
    // Losing the last attachment of an Ethernet Segment is what triggers the
    // mass withdrawal a remote leaf converges on, so the segment engine has to
    // hear about a port before anything else reads its state.
    const logical = this.logicalPortOf(iface.name);
    if (this.ethernetSegments.esiForInterface(logical) !== undefined) {
      // A failed attachment no longer reaches the hosts behind it, so what it
      // learned is forgotten *before* the re-advertisement runs — otherwise the
      // withdrawal would race a Type 2 route for a MAC we can no longer deliver.
      if (!this.logicalPortOperationalUp(logical)) {
        for (const vlanId of this.overlayVlansOf(logical)) this.flushForwardingOnPort(logical, vlanId);
      }
      this.onEthernetSegmentChanged("attachment-state-changed");
    }
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

  /**
   * The router MAC an L3VNI packet is stamped with. It is trace metadata — a
   * routed overlay packet carries no Ethernet header — so the fabric anycast
   * MAC is used when one exists and a stable per-device value otherwise.
   */
  private overlayRouterMac(): Mac {
    return normalizeMac(this.vxlan.anycastGatewayMac ?? this.sviMac(0));
  }

  private sviMac(vlanId: number): Mac {
    let hash = 2166136261;
    for (const char of `${this.id}:${vlanId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const octets = [0x02, 0x53, (hash >>> 24) & 0xff, (hash >>> 16) & 0xff, (hash >>> 8) & 0xff, hash & 0xff];
    return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
  }
}
