import { getDeviceProfile, type DeviceType } from "@sim/contracts";
import type { DiscoveryCapability } from "../packets/discovery";

/**
 * Shared, documented discovery profile per device kind.
 *
 * | Device      | CDP | LLDP | Advertised capabilities |
 * | ----------- | --- | ---- | ----------------------- |
 * | Router      | yes | yes  | router                  |
 * | L2 Switch   | yes | yes  | switch, bridge          |
 * | L3 Switch   | yes | yes  | switch, router          |
 * | Firewall    | yes | yes  | router                  |
 * | Cloud / ISP | yes | yes  | router                  |
 * | Server      | no  | yes  | station                 |
 * | PC and Hub  | no  | no   | —                       |
 *
 * Both protocols start **disabled** on every device. Enabling them by default
 * would add advertisements to every existing lab and change its deterministic
 * trace, so a lab turns them on with `cdp run` / `lldp run`.
 */
export function discoveryCapabilitiesFor(deviceType: DeviceType): DiscoveryCapability[] {
  if (deviceType === "l3-switch") return ["switch", "router"];
  if (deviceType === "l2-switch") return ["switch", "bridge"];
  if (deviceType === "bridge") return ["bridge"];
  if (deviceType === "router" || deviceType === "firewall" || deviceType === "cloud") return ["router"];
  return ["station"];
}

export function discoveryPlatformFor(deviceType: DeviceType): string {
  return `SimulatorNet ${getDeviceProfile(deviceType).displayName}`;
}

/** True for device kinds that speak the Cisco-like CDP subset. */
export function supportsCdp(deviceType: DeviceType): boolean {
  return deviceType === "router"
    || deviceType === "l2-switch"
    || deviceType === "l3-switch"
    || deviceType === "firewall"
    || deviceType === "cloud";
}
