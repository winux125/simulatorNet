/**
 * The parsed-config → structured `DeviceConfig` mapper now lives in
 * `@sim/device-config` beside the parser, so an import and a pasted `.cfg`
 * produce identical structured configuration. This module re-exports it.
 */
export {
  buildDeviceConfigFromIos,
  parseVpcsConfig,
  type BuiltConfig,
  type VpcsConfig,
} from "@sim/device-config";
