import type { WirelessBand } from "@sim/contracts";
import type { Mac } from "../util/mac";

interface WirelessManagementMessageBase {
  readonly kind: "wireless-management";
  readonly sourceMac: Mac;
  readonly destinationMac?: Mac;
  readonly radioDomainId: string;
  readonly band: WirelessBand;
  readonly channel: number;
}

export interface WirelessBeacon extends WirelessManagementMessageBase {
  readonly type: "beacon";
  readonly ssid?: string;
  readonly bssid: Mac;
}

export interface WirelessProbeRequest extends WirelessManagementMessageBase {
  readonly type: "probe-request";
  readonly ssid?: string;
}

export interface WirelessProbeResponse extends WirelessManagementMessageBase {
  readonly type: "probe-response";
  readonly ssid: string;
  readonly bssid: Mac;
}

export interface WirelessAuthenticationRequest extends WirelessManagementMessageBase {
  readonly type: "authentication-request";
  readonly bssid: Mac;
}

export interface WirelessAuthenticationResponse extends WirelessManagementMessageBase {
  readonly type: "authentication-response";
  readonly bssid: Mac;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface WirelessAssociationRequest extends WirelessManagementMessageBase {
  readonly type: "association-request";
  readonly bssid: Mac;
  readonly ssid: string;
}

export interface WirelessAssociationResponse extends WirelessManagementMessageBase {
  readonly type: "association-response";
  readonly bssid: Mac;
  readonly ssid: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface WirelessDisassociation extends WirelessManagementMessageBase {
  readonly type: "disassociation";
  readonly bssid: Mac;
  readonly reason: string;
}

export interface WirelessDeauthentication extends WirelessManagementMessageBase {
  readonly type: "deauthentication";
  readonly bssid: Mac;
  readonly reason: string;
}

export type WirelessManagementMessage =
  | WirelessBeacon
  | WirelessProbeRequest
  | WirelessProbeResponse
  | WirelessAuthenticationRequest
  | WirelessAuthenticationResponse
  | WirelessAssociationRequest
  | WirelessAssociationResponse
  | WirelessDisassociation
  | WirelessDeauthentication;
