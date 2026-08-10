/**
 * The IOS-like configuration parser now lives in `@sim/device-config`, so the
 * importer, the device Configuration workspace and a pasted `.cfg` all go
 * through one implementation. This module re-exports it unchanged.
 */
export {
  maskToPrefix,
  normalizeInterfaceName,
  parseIosConfig,
  type ImportedDeviceConfiguration,
  type ImportedIkePeerConfig,
  type ImportedIkeProposalConfig,
  type ImportedInterfaceConfig,
  type ImportedIpsecProfileConfig,
  type ImportedLoopbackConfig,
  type ImportedOspfConfig,
  type ImportedSviConfig,
  type ImportedTunnelConfig,
  type ImportedVpnConfiguration,
} from "@sim/device-config";
