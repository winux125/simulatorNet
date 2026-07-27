import { z } from "zod";
import { PasswordVerifierSchema } from "./console";

export const WIRELESS_BANDS = ["2.4ghz", "5ghz"] as const;
export const WirelessBandSchema = z.enum(WIRELESS_BANDS);
export type WirelessBand = z.infer<typeof WirelessBandSchema>;

export const WIRELESS_SECURITY_MODES = ["open", "wpa2-personal"] as const;
export const WirelessSecurityModeSchema = z.enum(WIRELESS_SECURITY_MODES);
export type WirelessSecurityMode = z.infer<typeof WirelessSecurityModeSchema>;

export const WIRELESS_STATION_STATES = [
  "disabled",
  "disconnected",
  "scanning",
  "authenticating",
  "associating",
  "associated",
  "failed",
] as const;
export const WirelessStationStateSchema = z.enum(WIRELESS_STATION_STATES);
export type WirelessStationState = z.infer<typeof WirelessStationStateSchema>;

export const WirelessInterfaceConfigurationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  macAddress: z.string().min(11).max(32),
  enabled: z.boolean().default(true),
  band: WirelessBandSchema,
  supportedChannels: z.array(z.number().int().min(1).max(196)).min(1).max(64),
  radioDomainId: z.string().min(1).max(128),
}).strict();
export type WirelessInterfaceConfiguration = z.infer<typeof WirelessInterfaceConfigurationSchema>;

export const WirelessSecurityConfigurationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("open") }).strict(),
  z.object({
    mode: z.literal("wpa2-personal"),
    credentialVerifier: PasswordVerifierSchema,
  }).strict(),
]);
export type WirelessSecurityConfiguration = z.infer<typeof WirelessSecurityConfigurationSchema>;

export const WirelessAccessPointConfigurationSchema = z.object({
  ssid: z.string().min(1).max(32),
  broadcastSsid: z.boolean().default(true),
  band: WirelessBandSchema,
  channel: z.number().int().min(1).max(196),
  enabled: z.boolean().default(true),
  radioDomainId: z.string().min(1).max(128),
  priority: z.number().int().min(0).max(65_535).default(100),
  maximumClients: z.number().int().min(1).max(128).default(32),
  clientIsolation: z.boolean().default(false),
  security: WirelessSecurityConfigurationSchema.default({ mode: "open" }),
}).strict();
export type WirelessAccessPointConfiguration = z.infer<typeof WirelessAccessPointConfigurationSchema>;

export const WirelessSavedNetworkProfileSchema = z.object({
  id: z.string().min(1).max(128),
  ssid: z.string().min(1).max(32),
  securityMode: WirelessSecurityModeSchema,
  credentialVerifier: PasswordVerifierSchema.optional(),
  autoConnect: z.boolean().default(true),
  preferredBssid: z.string().min(11).max(32).optional(),
}).strict();
export type WirelessSavedNetworkProfile = z.infer<typeof WirelessSavedNetworkProfileSchema>;

export const WirelessNetworkSummarySchema = z.object({
  ssid: z.string().min(1).max(32),
  bssid: z.string().min(11).max(32),
  security: WirelessSecurityModeSchema,
  band: WirelessBandSchema,
  channel: z.number().int().min(1).max(196),
  radioDomainId: z.string().min(1).max(128),
  priority: z.number().int(),
}).strict();
export type WirelessNetworkSummary = z.infer<typeof WirelessNetworkSummarySchema>;

export const WirelessAssociationStatusSchema = z.object({
  state: WirelessStationStateSchema,
  stationDeviceId: z.string().min(1),
  interfaceId: z.string().min(1),
  ssid: z.string().optional(),
  bssid: z.string().optional(),
  accessPointDeviceId: z.string().optional(),
  associatedAtNs: z.number().int().nonnegative().optional(),
  failureReason: z.string().optional(),
}).strict();
export type WirelessAssociationStatus = z.infer<typeof WirelessAssociationStatusSchema>;
