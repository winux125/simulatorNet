import type {
  WirelessAccessPointConfiguration,
  WirelessAssociationStatus,
  WirelessBand,
  WirelessInterfaceConfiguration,
  WirelessNetworkSummary,
  WirelessSecurityMode,
  WirelessStationState,
} from "@sim/contracts";
import type { SimulationEngine } from "../engine/simulation-engine";
import {
  frameTraversalBudget,
  nextFrameTraversal,
  type EthernetFrame,
} from "../packets/ethernet";
import { FrameTraversalLimitError } from "../net/interface";
import { isBroadcastMac, isMulticastMac, normalizeMac, type Mac } from "../util/mac";
import {
  DEFAULT_WIRELESS_LIMITS,
  WirelessLimitError,
  type WirelessLimits,
} from "./limits";
import type { WirelessManagementMessage } from "./messages";

export type WirelessAssociationFailureReason =
  | "wireless-interface-disabled"
  | "no-access-point"
  | "incompatible-band-or-channel"
  | "access-point-client-limit"
  | "authentication-failed";

export interface WirelessRuntimeSecurity {
  readonly mode: WirelessSecurityMode;
  /** Opaque material prepared outside the deterministic event loop. */
  readonly credentialFingerprint?: string;
}

export interface WirelessAccessPointRadioConfiguration
  extends Omit<WirelessAccessPointConfiguration, "security"> {
  readonly security: WirelessRuntimeSecurity;
}

export interface WirelessAccessPointRegistration {
  readonly deviceId: string;
  readonly interfaceId: string;
  readonly macAddress: Mac;
  readonly configuration: WirelessAccessPointRadioConfiguration;
  readonly receive: (frame: EthernetFrame) => void;
}

export interface WirelessStationRegistration {
  readonly deviceId: string;
  readonly interface: WirelessInterfaceConfiguration;
  readonly receive: (frame: EthernetFrame) => void;
  readonly preferredSsid?: string;
  readonly preferredBssid?: Mac;
}

export interface WirelessConnectRequest {
  readonly ssid?: string;
  readonly preferredBssid?: Mac;
}

export interface WirelessAssociatedClient {
  readonly deviceId: string;
  readonly interfaceId: string;
  readonly macAddress: Mac;
  readonly associatedAtNs: number;
}

interface AccessPointRuntime extends WirelessAccessPointRegistration {
  readonly key: string;
  readonly bssid: Mac;
  configuration: WirelessAccessPointRadioConfiguration;
}

interface StationRuntime extends WirelessStationRegistration {
  readonly key: string;
  readonly macAddress: Mac;
  state: WirelessStationState;
  scanResults: WirelessNetworkSummary[];
  associatedAccessPointKey?: string;
  associatedAtNs?: number;
  failureReason?: WirelessAssociationFailureReason;
  connectionGeneration: number;
}

const BROADCAST_MANAGEMENT_MAC = "ff:ff:ff:ff:ff:ff" as Mac;

/**
 * Deterministic educational wireless LAN medium.
 *
 * Radio reachability is selected exclusively by structured radio-domain,
 * band, channel and SSID configuration. Canvas coordinates never enter this
 * module. Management and data delivery share the engine's virtual clock and
 * bounded event queue, so browser-worker and verifier executions are identical.
 */
export class WirelessMedium {
  private readonly accessPoints = new Map<string, AccessPointRuntime>();
  private readonly stations = new Map<string, StationRuntime>();
  private pendingWirelessFrames = 0;

  constructor(
    private readonly engine: SimulationEngine,
    readonly limits: WirelessLimits = DEFAULT_WIRELESS_LIMITS,
  ) {}

  registerAccessPoint(registration: WirelessAccessPointRegistration): void {
    validateAccessPointConfiguration(registration.configuration);
    const key = radioKey(registration.deviceId, registration.interfaceId);
    if (this.accessPoints.has(key)) throw new Error(`Wireless access point '${key}' is already registered.`);
    const bssid = normalizeMac(registration.macAddress);
    if ([...this.accessPoints.values()].some((entry) => entry.bssid === bssid)) {
      throw new Error(`Wireless BSSID '${bssid}' is already registered.`);
    }
    const domainCount = [...this.accessPoints.values()].filter(
      (entry) => entry.configuration.radioDomainId === registration.configuration.radioDomainId,
    ).length + 1;
    if (domainCount > this.limits.maximumAccessPointsPerRadioDomain) {
      throw new WirelessLimitError(
        "access-points-per-radio-domain",
        domainCount,
        this.limits.maximumAccessPointsPerRadioDomain,
        registration.configuration.radioDomainId,
      );
    }
    this.accessPoints.set(key, {
      ...registration,
      key,
      bssid,
      macAddress: bssid,
      configuration: cloneAccessPointConfiguration(registration.configuration),
    });
  }

  registerStation(registration: WirelessStationRegistration): void {
    validateInterfaceConfiguration(registration.interface);
    const key = radioKey(registration.deviceId, registration.interface.id);
    if (this.stations.has(key)) throw new Error(`Wireless station '${key}' is already registered.`);
    const macAddress = normalizeMac(registration.interface.macAddress);
    if ([...this.stations.values()].some((entry) => entry.macAddress === macAddress)) {
      throw new Error(`Wireless station MAC '${macAddress}' is already registered.`);
    }
    this.stations.set(key, {
      ...registration,
      key,
      macAddress,
      preferredBssid: registration.preferredBssid
        ? normalizeMac(registration.preferredBssid)
        : undefined,
      state: registration.interface.enabled ? "disconnected" : "disabled",
      scanResults: [],
      connectionGeneration: 0,
    });
  }

  updateAccessPoint(
    deviceId: string,
    interfaceId: string,
    configuration: WirelessAccessPointRadioConfiguration,
  ): void {
    validateAccessPointConfiguration(configuration);
    const accessPoint = this.requireAccessPoint(deviceId, interfaceId);
    const associationChanged = associationSignature(accessPoint.configuration)
      !== associationSignature(configuration);
    const domainCount = [...this.accessPoints.values()].filter(
      (entry) =>
        entry.key !== accessPoint.key
        && entry.configuration.radioDomainId === configuration.radioDomainId,
    ).length + 1;
    if (domainCount > this.limits.maximumAccessPointsPerRadioDomain) {
      throw new WirelessLimitError(
        "access-points-per-radio-domain",
        domainCount,
        this.limits.maximumAccessPointsPerRadioDomain,
        configuration.radioDomainId,
      );
    }
    accessPoint.configuration = cloneAccessPointConfiguration(configuration);
    if (!configuration.enabled || associationChanged) {
      this.disconnectAccessPointClients(
        accessPoint,
        configuration.enabled ? "access-point-configuration-changed" : "access-point-disabled",
      );
    }
  }

  removeAccessPoint(deviceId: string, interfaceId: string, reason = "access-point-removed"): void {
    const key = radioKey(deviceId, interfaceId);
    const accessPoint = this.accessPoints.get(key);
    if (!accessPoint) return;
    this.disconnectAccessPointClients(accessPoint, reason);
    this.accessPoints.delete(key);
  }

  removeStation(deviceId: string, interfaceId: string): void {
    const key = radioKey(deviceId, interfaceId);
    const station = this.stations.get(key);
    if (!station) return;
    station.connectionGeneration++;
    this.stations.delete(key);
  }

  scan(deviceId: string, interfaceId: string, explicitSsid?: string): void {
    const station = this.requireStation(deviceId, interfaceId);
    station.connectionGeneration++;
    const generation = station.connectionGeneration;
    station.scanResults = [];
    station.failureReason = undefined;
    if (!station.interface.enabled) {
      station.state = "disabled";
      return;
    }
    station.state = "scanning";
    this.traceManagement(station.deviceId, {
      kind: "wireless-management",
      type: "probe-request",
      sourceMac: station.macAddress,
      destinationMac: BROADCAST_MANAGEMENT_MAC,
      radioDomainId: station.interface.radioDomainId,
      band: station.interface.band,
      channel: 0,
      ssid: explicitSsid,
    });
    const candidates = this.scanCandidates(station, explicitSsid)
      .slice(0, this.limits.maximumScanResults);
    candidates.forEach((accessPoint, index) => {
      this.scheduleManagement((index + 1) * this.limits.managementFrameDelayNs, station.key, generation, () => {
        station.scanResults.push(networkSummary(accessPoint));
        this.traceManagement(accessPoint.deviceId, {
          kind: "wireless-management",
          type: "probe-response",
          sourceMac: accessPoint.bssid,
          destinationMac: station.macAddress,
          radioDomainId: accessPoint.configuration.radioDomainId,
          band: accessPoint.configuration.band,
          channel: accessPoint.configuration.channel,
          ssid: accessPoint.configuration.ssid,
          bssid: accessPoint.bssid,
        });
      });
    });
    this.scheduleManagement(
      (candidates.length + 1) * this.limits.managementFrameDelayNs,
      station.key,
      generation,
      () => {
        station.state = "disconnected";
      },
    );
  }

  announceBeacon(deviceId: string, interfaceId: string): void {
    const accessPoint = this.requireAccessPoint(deviceId, interfaceId);
    if (!accessPoint.configuration.enabled) return;
    this.scheduleManagement(this.limits.managementFrameDelayNs, undefined, undefined, () => {
      this.traceManagement(accessPoint.deviceId, {
        kind: "wireless-management",
        type: "beacon",
        sourceMac: accessPoint.bssid,
        destinationMac: BROADCAST_MANAGEMENT_MAC,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        ssid: accessPoint.configuration.broadcastSsid ? accessPoint.configuration.ssid : undefined,
        bssid: accessPoint.bssid,
      });
    });
  }

  connect(deviceId: string, interfaceId: string, request: WirelessConnectRequest = {}): void {
    const station = this.requireStation(deviceId, interfaceId);
    station.connectionGeneration++;
    const generation = station.connectionGeneration;
    station.scanResults = [];
    station.failureReason = undefined;
    if (!station.interface.enabled) {
      this.fail(station, "wireless-interface-disabled");
      return;
    }
    this.engine.controlProtocolBudget.consume("wirelessAssociationAttempts", station.key);
    station.state = "scanning";
    const requestedSsid = request.ssid ?? station.preferredSsid;
    this.traceManagement(station.deviceId, {
      kind: "wireless-management",
      type: "probe-request",
      sourceMac: station.macAddress,
      destinationMac: BROADCAST_MANAGEMENT_MAC,
      radioDomainId: station.interface.radioDomainId,
      band: station.interface.band,
      channel: 0,
      ssid: requestedSsid,
    });
    this.scheduleManagement(this.limits.managementFrameDelayNs, station.key, generation, () => {
      const compatible = this.compatibleAccessPoints(station);
      const candidates = compatible.filter(
        (entry) => requestedSsid === undefined || entry.configuration.ssid === requestedSsid,
      );
      const preferredBssid = request.preferredBssid
        ? normalizeMac(request.preferredBssid)
        : station.preferredBssid;
      const accessPoint = selectAccessPoint(candidates, preferredBssid);
      if (!accessPoint) {
        const anyInDomain = [...this.accessPoints.values()].some(
          (entry) =>
            entry.configuration.enabled
            && entry.configuration.radioDomainId === station.interface.radioDomainId,
        );
        this.fail(
          station,
          compatible.length === 0 && anyInDomain
            ? "incompatible-band-or-channel"
            : "no-access-point",
        );
        return;
      }
      station.scanResults = [networkSummary(accessPoint)];
      this.traceManagement(accessPoint.deviceId, {
        kind: "wireless-management",
        type: "probe-response",
        sourceMac: accessPoint.bssid,
        destinationMac: station.macAddress,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        ssid: accessPoint.configuration.ssid,
        bssid: accessPoint.bssid,
      });
      this.startAuthentication(station, accessPoint, generation);
    });
  }

  disconnect(deviceId: string, interfaceId: string, reason = "user-disconnect"): void {
    const station = this.requireStation(deviceId, interfaceId);
    station.connectionGeneration++;
    const accessPoint = station.associatedAccessPointKey
      ? this.accessPoints.get(station.associatedAccessPointKey)
      : undefined;
    if (accessPoint) {
      this.traceManagement(station.deviceId, {
        kind: "wireless-management",
        type: "disassociation",
        sourceMac: station.macAddress,
        destinationMac: accessPoint.bssid,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        bssid: accessPoint.bssid,
        reason,
      });
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-disassociated",
        device: station.deviceId,
        detail: { accessPointDeviceId: accessPoint.deviceId, bssid: accessPoint.bssid, reason },
      });
    }
    this.clearAssociation(station);
    station.state = station.interface.enabled ? "disconnected" : "disabled";
  }

  disconnectClient(
    accessPointDeviceId: string,
    accessPointInterfaceId: string,
    stationDeviceId: string,
    reason = "access-point-disconnect",
  ): boolean {
    const accessPoint = this.requireAccessPoint(accessPointDeviceId, accessPointInterfaceId);
    const station = this.associatedStations(accessPoint)
      .find((entry) => entry.deviceId === stationDeviceId);
    if (!station) return false;
    station.connectionGeneration++;
    this.traceManagement(accessPoint.deviceId, {
      kind: "wireless-management",
      type: "deauthentication",
      sourceMac: accessPoint.bssid,
      destinationMac: station.macAddress,
      radioDomainId: accessPoint.configuration.radioDomainId,
      band: accessPoint.configuration.band,
      channel: accessPoint.configuration.channel,
      bssid: accessPoint.bssid,
      reason,
    });
    this.clearAssociation(station);
    station.state = station.interface.enabled ? "disconnected" : "disabled";
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-deauthenticated",
      device: station.deviceId,
      detail: { accessPointDeviceId: accessPoint.deviceId, reason },
    });
    return true;
  }

  status(deviceId: string, interfaceId: string): WirelessAssociationStatus {
    const station = this.requireStation(deviceId, interfaceId);
    const accessPoint = station.associatedAccessPointKey
      ? this.accessPoints.get(station.associatedAccessPointKey)
      : undefined;
    return {
      state: station.state,
      stationDeviceId: station.deviceId,
      interfaceId: station.interface.id,
      ssid: accessPoint?.configuration.ssid,
      bssid: accessPoint?.bssid,
      accessPointDeviceId: accessPoint?.deviceId,
      associatedAtNs: station.associatedAtNs,
      failureReason: station.failureReason,
    };
  }

  scanResults(deviceId: string, interfaceId: string): WirelessNetworkSummary[] {
    return this.requireStation(deviceId, interfaceId).scanResults.map((entry) => ({ ...entry }));
  }

  associatedClients(deviceId: string, interfaceId: string): WirelessAssociatedClient[] {
    const accessPoint = this.requireAccessPoint(deviceId, interfaceId);
    return this.associatedStations(accessPoint)
      .map((station) => ({
        deviceId: station.deviceId,
        interfaceId: station.interface.id,
        macAddress: station.macAddress,
        associatedAtNs: station.associatedAtNs!,
      }));
  }

  isOperational(deviceId: string, interfaceId: string): boolean {
    const station = this.stations.get(radioKey(deviceId, interfaceId));
    if (station) return station.state === "associated";
    const accessPoint = this.accessPoints.get(radioKey(deviceId, interfaceId));
    return accessPoint?.configuration.enabled === true;
  }

  transmit(deviceId: string, interfaceId: string, frame: EthernetFrame): void {
    const station = this.stations.get(radioKey(deviceId, interfaceId));
    if (station) {
      this.transmitFromStation(station, frame);
      return;
    }
    const accessPoint = this.accessPoints.get(radioKey(deviceId, interfaceId));
    if (accessPoint) {
      this.transmitFromAccessPoint(accessPoint, frame);
      return;
    }
    throw new Error(`Unknown wireless interface '${deviceId}/${interfaceId}'.`);
  }

  private startAuthentication(
    station: StationRuntime,
    accessPoint: AccessPointRuntime,
    generation: number,
  ): void {
    station.state = "authenticating";
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-authentication-started",
      device: station.deviceId,
      detail: { accessPointDeviceId: accessPoint.deviceId, bssid: accessPoint.bssid },
    });
    this.traceManagement(station.deviceId, {
      kind: "wireless-management",
      type: "authentication-request",
      sourceMac: station.macAddress,
      destinationMac: accessPoint.bssid,
      radioDomainId: accessPoint.configuration.radioDomainId,
      band: accessPoint.configuration.band,
      channel: accessPoint.configuration.channel,
      bssid: accessPoint.bssid,
    });
    this.scheduleManagement(this.limits.managementFrameDelayNs, station.key, generation, () => {
      // M10.6a implements open-system authentication. WPA2 credential
      // verification is added as a separate milestone slice before it enters
      // this deterministic decision point.
      const accepted = accessPoint.configuration.security.mode === "open";
      this.traceManagement(accessPoint.deviceId, {
        kind: "wireless-management",
        type: "authentication-response",
        sourceMac: accessPoint.bssid,
        destinationMac: station.macAddress,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        bssid: accessPoint.bssid,
        accepted,
        reason: accepted ? undefined : "incorrect-security-key",
      });
      if (!accepted) {
        this.fail(station, "authentication-failed");
        this.engine.trace({
          time: this.engine.now(),
          type: "wireless-authentication-failed",
          device: station.deviceId,
          detail: { accessPointDeviceId: accessPoint.deviceId, reason: "incorrect-security-key" },
        });
        return;
      }
      this.startAssociation(station, accessPoint, generation);
    });
  }

  private startAssociation(
    station: StationRuntime,
    accessPoint: AccessPointRuntime,
    generation: number,
  ): void {
    station.state = "associating";
    this.traceManagement(station.deviceId, {
      kind: "wireless-management",
      type: "association-request",
      sourceMac: station.macAddress,
      destinationMac: accessPoint.bssid,
      radioDomainId: accessPoint.configuration.radioDomainId,
      band: accessPoint.configuration.band,
      channel: accessPoint.configuration.channel,
      bssid: accessPoint.bssid,
      ssid: accessPoint.configuration.ssid,
    });
    this.scheduleManagement(this.limits.managementFrameDelayNs, station.key, generation, () => {
      const clients = this.associatedStations(accessPoint).length;
      const maximum = Math.min(
        accessPoint.configuration.maximumClients,
        this.limits.maximumStationsPerAccessPoint,
      );
      const accepted = accessPoint.configuration.enabled && clients < maximum;
      this.traceManagement(accessPoint.deviceId, {
        kind: "wireless-management",
        type: "association-response",
        sourceMac: accessPoint.bssid,
        destinationMac: station.macAddress,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        bssid: accessPoint.bssid,
        ssid: accessPoint.configuration.ssid,
        accepted,
        reason: accepted ? undefined : "client-limit",
      });
      if (!accepted) {
        this.fail(station, "access-point-client-limit");
        return;
      }
      station.state = "associated";
      station.associatedAccessPointKey = accessPoint.key;
      station.associatedAtNs = this.engine.now();
      station.failureReason = undefined;
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-associated",
        device: station.deviceId,
        detail: {
          accessPointDeviceId: accessPoint.deviceId,
          ssid: accessPoint.configuration.ssid,
          bssid: accessPoint.bssid,
        },
      });
    });
  }

  private transmitFromStation(station: StationRuntime, frame: EthernetFrame): void {
    const accessPoint = station.associatedAccessPointKey
      ? this.accessPoints.get(station.associatedAccessPointKey)
      : undefined;
    if (station.state !== "associated" || !accessPoint?.configuration.enabled) {
      this.traceDrop(station.deviceId, "station-not-associated", frame);
      return;
    }
    const traversed = this.nextTraversal(frame, station.deviceId, station.interface.id);
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-data-sent",
      device: station.deviceId,
      detail: { accessPointDeviceId: accessPoint.deviceId, dst: normalizeMac(frame.dst) },
    });
    this.scheduleData(() => {
      accessPoint.receive(traversed);
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-data-received",
        device: accessPoint.deviceId,
        detail: { stationDeviceId: station.deviceId, src: normalizeMac(frame.src) },
      });
    });

    const peers = this.associatedStations(accessPoint).filter((peer) => peer.key !== station.key);
    if (accessPoint.configuration.clientIsolation) {
      if (isBroadcastOrMulticast(frame.dst) || peers.some((peer) => peer.macAddress === normalizeMac(frame.dst))) {
        this.traceDrop(station.deviceId, "client-isolation", frame);
      }
      return;
    }
    const destinations = isBroadcastOrMulticast(frame.dst)
      ? peers
      : peers.filter((peer) => peer.macAddress === normalizeMac(frame.dst));
    for (const peer of destinations) this.deliverToStation(accessPoint, peer, traversed);
  }

  private transmitFromAccessPoint(accessPoint: AccessPointRuntime, frame: EthernetFrame): void {
    if (!accessPoint.configuration.enabled) {
      this.traceDrop(accessPoint.deviceId, "access-point-disabled", frame);
      return;
    }
    const traversed = this.nextTraversal(frame, accessPoint.deviceId, accessPoint.interfaceId);
    const associated = this.associatedStations(accessPoint);
    const destinations = isBroadcastOrMulticast(frame.dst)
      ? associated
      : associated.filter((station) => station.macAddress === normalizeMac(frame.dst));
    if (destinations.length === 0) {
      this.traceDrop(accessPoint.deviceId, "wireless-destination-not-associated", frame);
      return;
    }
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-data-sent",
      device: accessPoint.deviceId,
      detail: { dst: normalizeMac(frame.dst), stationCount: destinations.length },
    });
    for (const station of destinations) this.deliverToStation(accessPoint, station, traversed);
  }

  private deliverToStation(
    accessPoint: AccessPointRuntime,
    station: StationRuntime,
    frame: EthernetFrame,
  ): void {
    this.scheduleData(() => {
      station.receive(frame);
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-data-received",
        device: station.deviceId,
        detail: { accessPointDeviceId: accessPoint.deviceId, src: normalizeMac(frame.src) },
      });
    });
  }

  private nextTraversal(frame: EthernetFrame, deviceId: string, interfaceId: string): EthernetFrame {
    const traversed = nextFrameTraversal(frame);
    if (traversed) return traversed;
    this.engine.trace({
      time: this.engine.now(),
      type: "frame-traversal-limit",
      device: deviceId,
      detail: { interface: interfaceId, remaining: frameTraversalBudget(frame) },
    });
    throw new FrameTraversalLimitError(deviceId, interfaceId);
  }

  private scheduleData(deliver: () => void): void {
    const pending = this.pendingWirelessFrames + 1;
    if (pending > this.limits.maximumPendingWirelessFrames) {
      throw new WirelessLimitError(
        "pending-wireless-frames",
        pending,
        this.limits.maximumPendingWirelessFrames,
      );
    }
    this.engine.controlProtocolBudget.consume("wirelessFrames");
    this.pendingWirelessFrames = pending;
    this.engine.scheduleIn(this.limits.dataFrameDelayNs, () => {
      this.pendingWirelessFrames--;
      deliver();
    });
  }

  private scheduleManagement(
    delayNs: number,
    stationKey: string | undefined,
    generation: number | undefined,
    run: () => void,
  ): void {
    this.engine.controlProtocolBudget.consume("wirelessManagementEvents");
    this.engine.scheduleIn(delayNs, () => {
      if (stationKey !== undefined) {
        const station = this.stations.get(stationKey);
        if (!station || station.connectionGeneration !== generation) return;
      }
      run();
    });
  }

  private traceManagement(deviceId: string, message: WirelessManagementMessage): void {
    this.engine.trace({
      time: this.engine.now(),
      type: wirelessTraceType(message.type),
      device: deviceId,
      detail: managementTraceDetail(message),
    });
  }

  private traceDrop(deviceId: string, reason: string, frame: EthernetFrame): void {
    this.engine.trace({
      time: this.engine.now(),
      type: "wireless-frame-dropped",
      device: deviceId,
      detail: { reason, src: normalizeMac(frame.src), dst: normalizeMac(frame.dst) },
    });
  }

  private fail(station: StationRuntime, reason: WirelessAssociationFailureReason): void {
    this.clearAssociation(station);
    station.state = "failed";
    station.failureReason = reason;
  }

  private clearAssociation(station: StationRuntime): void {
    station.associatedAccessPointKey = undefined;
    station.associatedAtNs = undefined;
  }

  private disconnectAccessPointClients(accessPoint: AccessPointRuntime, reason: string): void {
    for (const station of this.associatedStations(accessPoint)) {
      station.connectionGeneration++;
      this.traceManagement(accessPoint.deviceId, {
        kind: "wireless-management",
        type: "deauthentication",
        sourceMac: accessPoint.bssid,
        destinationMac: station.macAddress,
        radioDomainId: accessPoint.configuration.radioDomainId,
        band: accessPoint.configuration.band,
        channel: accessPoint.configuration.channel,
        bssid: accessPoint.bssid,
        reason,
      });
      this.clearAssociation(station);
      station.state = station.interface.enabled ? "disconnected" : "disabled";
      this.engine.trace({
        time: this.engine.now(),
        type: "wireless-deauthenticated",
        device: station.deviceId,
        detail: { accessPointDeviceId: accessPoint.deviceId, reason },
      });
    }
  }

  private compatibleAccessPoints(station: StationRuntime): AccessPointRuntime[] {
    return [...this.accessPoints.values()]
      .filter((entry) =>
        entry.configuration.enabled
        && entry.configuration.radioDomainId === station.interface.radioDomainId
        && entry.configuration.band === station.interface.band
        && station.interface.supportedChannels.includes(entry.configuration.channel),
      )
      .sort(compareAccessPoints);
  }

  private scanCandidates(station: StationRuntime, explicitSsid?: string): AccessPointRuntime[] {
    return this.compatibleAccessPoints(station)
      .filter((entry) =>
        explicitSsid !== undefined
          ? entry.configuration.ssid === explicitSsid
          : entry.configuration.broadcastSsid,
      );
  }

  private associatedStations(accessPoint: AccessPointRuntime): StationRuntime[] {
    return [...this.stations.values()]
      .filter((station) =>
        station.state === "associated"
        && station.associatedAccessPointKey === accessPoint.key,
      )
      .sort((a, b) => a.macAddress.localeCompare(b.macAddress) || a.key.localeCompare(b.key));
  }

  private requireAccessPoint(deviceId: string, interfaceId: string): AccessPointRuntime {
    const accessPoint = this.accessPoints.get(radioKey(deviceId, interfaceId));
    if (!accessPoint) throw new Error(`Unknown wireless access point '${deviceId}/${interfaceId}'.`);
    return accessPoint;
  }

  private requireStation(deviceId: string, interfaceId: string): StationRuntime {
    const station = this.stations.get(radioKey(deviceId, interfaceId));
    if (!station) throw new Error(`Unknown wireless station '${deviceId}/${interfaceId}'.`);
    return station;
  }
}

function radioKey(deviceId: string, interfaceId: string): string {
  return `${deviceId}\u0000${interfaceId}`;
}

function selectAccessPoint(
  candidates: readonly AccessPointRuntime[],
  preferredBssid?: Mac,
): AccessPointRuntime | undefined {
  return [...candidates].sort((a, b) => {
    const aPreferred = preferredBssid !== undefined && a.bssid === preferredBssid;
    const bPreferred = preferredBssid !== undefined && b.bssid === preferredBssid;
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    return compareAccessPoints(a, b);
  })[0];
}

function compareAccessPoints(a: AccessPointRuntime, b: AccessPointRuntime): number {
  return b.configuration.priority - a.configuration.priority
    || a.bssid.localeCompare(b.bssid)
    || a.key.localeCompare(b.key);
}

function networkSummary(accessPoint: AccessPointRuntime): WirelessNetworkSummary {
  return {
    ssid: accessPoint.configuration.ssid,
    bssid: accessPoint.bssid,
    security: accessPoint.configuration.security.mode,
    band: accessPoint.configuration.band,
    channel: accessPoint.configuration.channel,
    radioDomainId: accessPoint.configuration.radioDomainId,
    priority: accessPoint.configuration.priority,
  };
}

function validateInterfaceConfiguration(configuration: WirelessInterfaceConfiguration): void {
  if (configuration.supportedChannels.length === 0) {
    throw new Error("Wireless interface must support at least one channel.");
  }
  const unique = new Set(configuration.supportedChannels);
  if (unique.size !== configuration.supportedChannels.length) {
    throw new Error("Wireless interface channels must be unique.");
  }
  for (const channel of unique) validateChannel(configuration.band, channel);
}

function validateAccessPointConfiguration(configuration: WirelessAccessPointRadioConfiguration): void {
  if (!configuration.ssid || configuration.ssid.length > 32) {
    throw new Error("Wireless SSID must contain between 1 and 32 characters.");
  }
  validateChannel(configuration.band, configuration.channel);
  if (
    !Number.isInteger(configuration.maximumClients)
    || configuration.maximumClients < 1
    || configuration.maximumClients > DEFAULT_WIRELESS_LIMITS.maximumStationsPerAccessPoint
  ) {
    throw new Error(
      `Wireless maximum clients must be between 1 and ${DEFAULT_WIRELESS_LIMITS.maximumStationsPerAccessPoint}.`,
    );
  }
}

function validateChannel(band: WirelessBand, channel: number): void {
  const valid = band === "2.4ghz"
    ? Number.isInteger(channel) && channel >= 1 && channel <= 14
    : Number.isInteger(channel) && channel >= 32 && channel <= 177;
  if (!valid) throw new Error(`Channel ${channel} is not valid for ${band}.`);
}

function cloneAccessPointConfiguration(
  configuration: WirelessAccessPointRadioConfiguration,
): WirelessAccessPointRadioConfiguration {
  return {
    ...configuration,
    security: { ...configuration.security },
  };
}

function securitySignature(security: WirelessRuntimeSecurity): string {
  return `${security.mode}:${security.credentialFingerprint ?? ""}`;
}

function associationSignature(configuration: WirelessAccessPointRadioConfiguration): string {
  return [
    configuration.enabled ? "enabled" : "disabled",
    configuration.ssid,
    configuration.radioDomainId,
    configuration.band,
    configuration.channel,
    securitySignature(configuration.security),
  ].join(":");
}

function isBroadcastOrMulticast(mac: Mac): boolean {
  const normalized = normalizeMac(mac);
  return isBroadcastMac(normalized) || isMulticastMac(normalized);
}

function wirelessTraceType(type: WirelessManagementMessage["type"]): string {
  switch (type) {
    case "beacon": return "wireless-beacon-sent";
    case "probe-request": return "wireless-probe-request";
    case "probe-response": return "wireless-probe-response";
    case "authentication-request": return "wireless-authentication-request";
    case "authentication-response": return type;
    case "association-request": return type;
    case "association-response": return type;
    case "disassociation": return "wireless-disassociated";
    case "deauthentication": return "wireless-deauthenticated";
  }
}

function managementTraceDetail(message: WirelessManagementMessage): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    frame: message.type,
    sourceMac: message.sourceMac,
    destinationMac: message.destinationMac,
    radioDomainId: message.radioDomainId,
    band: message.band,
    channel: message.channel,
  };
  if ("ssid" in message) detail.ssid = message.ssid;
  if ("bssid" in message) detail.bssid = message.bssid;
  if ("accepted" in message) detail.accepted = message.accepted;
  if ("reason" in message) detail.reason = message.reason;
  return detail;
}
