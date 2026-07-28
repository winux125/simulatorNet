import { SIMULATORNET_ENTERPRISE_OID, type DeviceType } from "@sim/contracts";
import type { Device } from "../devices/device";
import type { SnmpInterfaceRow, SnmpMibSource } from "./snmp-mib";

/**
 * Adapts a simulated device to the built-in MIB.
 *
 * It reports *only* what the engine models. Interface counters come from the
 * device's own packet counters; there is no invented CPU, memory or
 * temperature reading, because a deterministic protocol simulator has no
 * honest value for those.
 */
export interface SnmpCapableDevice extends Device {
  snmpInterfaceRows?(): readonly SnmpInterfaceRow[];
  snmpIpv4Addresses?(): readonly string[];
  snmpIpv6Addresses?(): readonly string[];
  snmpRouteCount?(): number;
  snmpNeighborCount?(): number;
  snmpSpanningTree?(): { readonly rootId: string; readonly portStates: string } | undefined;
  snmpOspfNeighborCount?(): number;
  snmpOspfv3NeighborCount?(): number;
  snmpEtherChannelCount?(): number;
  snmpWirelessClientCount?(): number;
  snmpFirewallSessionCount?(): number;
  snmpNatTranslationCount?(): number;
}

/** One stable enterprise OID per device type: `sysObjectID`. */
const DEVICE_TYPE_OID: Partial<Record<DeviceType, number>> = {
  router: 1,
  "l2-switch": 2,
  "l3-switch": 3,
  firewall: 4,
  "access-point": 5,
  "wireless-router": 6,
  server: 7,
};

export function deviceObjectId(deviceType: DeviceType): string {
  return `${SIMULATORNET_ENTERPRISE_OID}.2.${DEVICE_TYPE_OID[deviceType] ?? 99}`;
}

export function deviceMibSource(
  device: SnmpCapableDevice,
  agent: { readonly location: string | undefined; readonly contact: string | undefined },
): SnmpMibSource {
  return {
    deviceId: device.id,
    description: () =>
      `SimulatorNet ${device.profile.displayName} — deterministic educational simulation (not real hardware)`,
    objectId: () => deviceObjectId(device.deviceType),
    hostname: () => device.name,
    upTimeNs: () => device.engine.now(),
    location: () => agent.location,
    contact: () => agent.contact,
    interfaces: () => device.snmpInterfaceRows?.() ?? defaultInterfaceRows(device),
    ipv4Addresses: () => device.snmpIpv4Addresses?.() ?? [],
    ipv6Addresses: () => device.snmpIpv6Addresses?.() ?? [],
    routeCount: () => device.snmpRouteCount?.() ?? 0,
    neighborCount: () => device.snmpNeighborCount?.() ?? 0,
    spanningTree: device.snmpSpanningTree ? () => device.snmpSpanningTree!() : undefined,
    ospfNeighborCount: device.snmpOspfNeighborCount ? () => device.snmpOspfNeighborCount!() : undefined,
    ospfv3NeighborCount: device.snmpOspfv3NeighborCount ? () => device.snmpOspfv3NeighborCount!() : undefined,
    etherChannelCount: device.snmpEtherChannelCount ? () => device.snmpEtherChannelCount!() : undefined,
    wirelessClientCount: device.snmpWirelessClientCount ? () => device.snmpWirelessClientCount!() : undefined,
    firewallSessionCount: device.snmpFirewallSessionCount ? () => device.snmpFirewallSessionCount!() : undefined,
    natTranslationCount: device.snmpNatTranslationCount ? () => device.snmpNatTranslationCount!() : undefined,
  };
}

/** Physical ports in canonical name order when a device adds nothing extra. */
function defaultInterfaceRows(device: Device): SnmpInterfaceRow[] {
  return [...device.interfaces.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((iface, index) => ({
      index: index + 1,
      name: iface.name,
      ifType: ifTypeOf(device, iface.name),
      adminUp: iface.adminUp,
      operationalUp: iface.operationalUp,
      inUnicastPackets: 0,
      outUnicastPackets: 0,
      inDiscards: 0,
      outDiscards: 0,
    }));
}

/** 6 ethernetCsmacd, 71 ieee80211, 53 propVirtual (SVI/loopback). */
export function ifTypeOf(device: Device, interfaceName: string): number {
  const template = device.profile.interfaceTemplates.find((entry) => entry.id === interfaceName);
  if (template?.media === "wireless") return 71;
  if (/^(?:vlan|loopback|port-channel)/iu.test(interfaceName)) return 53;
  return 6;
}
