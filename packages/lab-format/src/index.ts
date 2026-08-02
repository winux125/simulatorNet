export {
  LabFormatError,
  LabSemanticError,
  LabValidationError,
  UnsupportedSchemaVersionError,
} from "./errors";
export { migrateLabDocument } from "./version";
export { parseLabDocument } from "./parse";
export { validateLabSemantics } from "./semantic";
export {
  canonicalizeDeviceConfiguration,
  canonicalizeLabDocument,
  stringifyLabDocument,
} from "./canonical";
export {
  buildLabFromDocument,
  createDeviceInstance,
  serializeDeviceConfiguration,
  serializeLabDocument,
  type BuiltLab,
} from "./build";
export {
  deviceConfigurationDrift,
  eraseStartupConfiguration,
  reloadDevice,
  renderDeviceRunningConfiguration,
  renderDeviceStartupConfiguration,
  renderStartupProjection,
  runningConfigurationOf,
  saveRunningConfiguration,
  startupConfigurations,
  startupStateOf,
  type ReloadDeviceOptions,
  type ReloadDeviceResult,
} from "./device-lifecycle";
export {
  findDuplicateHostAddresses,
  hostsShareBroadcastDomain,
  type DuplicateHostAddressWarning,
  type HostAddressRecord,
} from "./host-network";
export { CURRENT_LAB_SCHEMA_VERSION } from "@sim/contracts";
