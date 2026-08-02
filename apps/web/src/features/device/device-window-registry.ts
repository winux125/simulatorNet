import {
  deviceTypeHasCapability,
  getDeviceProfile,
  type DeviceType,
} from "@sim/contracts";
import { supportsDeviceConfigurationText } from "@sim/device-config";

export type DeviceWindowMainTabId =
  | "physical"
  | "config"
  | "cli"
  | "monitor"
  | "attributes"
  | "desktop"
  | "terminal"
  | "services"
  | "wireless"
  | "apps"
  | "flows"
  | "run"
  | "results";

export type DeviceWindowSectionId =
  | "interfaces-config"
  | "host-ip"
  | "ip-config"
  | "routing-config"
  | "vlans-config"
  | "svis-config"
  | "stp-config"
  | "etherchannel-config"
  | "ospf-config"
  | "acl-config"
  | "nat-config"
  | "zones-config"
  | "policies-config"
  | "qos-config"
  | "vpn-config"
  | "console-config"
  | "configuration-files"
  | "remote-access-config"
  | "aaa-config"
  | "snmp-config"
  | "wireless-config"
  | "services-config"
  | "runtime-overview"
  | "interfaces-runtime"
  | "routes-runtime"
  | "neighbors-runtime"
  | "mac-runtime"
  | "protocols-runtime"
  | "sessions-runtime"
  | "nat-runtime"
  | "firewall-runtime"
  | "qos-runtime"
  | "vpn-runtime"
  | "aaa-runtime"
  | "snmp-runtime";

export interface DeviceWindowTabDefinition {
  id: DeviceWindowMainTabId;
  label: string;
}

export interface DeviceWindowSectionDefinition {
  id: DeviceWindowSectionId;
  label: string;
  group?: string;
}

export interface DeviceWindowDefinition {
  mainTabs: readonly DeviceWindowTabDefinition[];
  configSections: readonly DeviceWindowSectionDefinition[];
  monitorSections: readonly DeviceWindowSectionDefinition[];
}

const MANAGED_TYPES = new Set<DeviceType>(["router", "l2-switch", "l3-switch", "firewall"]);
const QOS_TYPES = new Set<DeviceType>(["router", "l3-switch", "firewall"]);

function mainTabs(type: DeviceType): readonly DeviceWindowTabDefinition[] {
  if (type === "traffic-generator") return [
    { id: "flows", label: "Flows" },
    { id: "run", label: "Run" },
    { id: "results", label: "Results" },
  ];
  if (MANAGED_TYPES.has(type)) return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    { id: "cli", label: "CLI" },
    { id: "monitor", label: "Monitor" },
    { id: "attributes", label: "Attributes" },
  ];
  if (type === "pc" || type === "laptop") return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    { id: "desktop", label: "Desktop" },
    { id: "terminal", label: "Terminal" },
    { id: "attributes", label: "Attributes" },
  ];
  if (type === "server") return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    { id: "services", label: "Services" },
    { id: "desktop", label: "Desktop" },
    { id: "terminal", label: "Terminal" },
    { id: "attributes", label: "Attributes" },
  ];
  if (type === "access-point" || type === "wireless-router") return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    { id: "wireless", label: "Wireless" },
    { id: "monitor", label: "Monitor" },
    { id: "attributes", label: "Attributes" },
  ];
  if (type === "smartphone") return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    { id: "wireless", label: "Wireless" },
    { id: "apps", label: "Apps" },
    { id: "attributes", label: "Attributes" },
  ];
  const profile = getDeviceProfile(type);
  return [
    { id: "physical", label: "Physical" },
    { id: "config", label: "Config" },
    ...(profile.cliProfile ? [{ id: "cli" as const, label: "CLI" }] : []),
    { id: "monitor", label: "Monitor" },
    { id: "attributes", label: "Attributes" },
  ];
}

function configSections(type: DeviceType): DeviceWindowSectionDefinition[] {
  const sections: DeviceWindowSectionDefinition[] = [];
  const profile = getDeviceProfile(type);
  if (["pc", "server", "laptop", "smartphone"].includes(type)) {
    sections.push({ id: "host-ip", label: "IP Configuration" });
  }
  if (profile.interfaceTemplates.length > 0) {
    sections.push({ id: "interfaces-config", label: type === "firewall" ? "Interfaces & Zones" : "Interfaces" });
  }
  if (deviceTypeHasCapability(type, "ipv4-routing")) {
    sections.push({ id: "ip-config", label: "IPv4 & IPv6" });
  }
  if (deviceTypeHasCapability(type, "vlan")) {
    sections.push({ id: "vlans-config", label: type === "l3-switch" ? "VLANs & SVIs" : "VLANs" });
  }
  if (deviceTypeHasCapability(type, "svi")) sections.push({ id: "svis-config", label: "SVIs" });
  if (deviceTypeHasCapability(type, "spanning-tree")) {
    sections.push({ id: "stp-config", label: "Spanning Tree" });
    sections.push({ id: "etherchannel-config", label: "EtherChannel" });
  }
  if (deviceTypeHasCapability(type, "static-routing")) {
    sections.push({ id: "routing-config", label: "Routing" });
  }
  if (type === "router" || type === "l3-switch") {
    sections.push({ id: "ospf-config", label: "OSPF" });
  }
  if (deviceTypeHasCapability(type, "packet-policy")) {
    sections.push({ id: "acl-config", label: "ACL", group: "Security" });
  }
  if (type === "firewall") {
    sections.push({ id: "zones-config", label: "Zones", group: "Security" });
    sections.push({ id: "policies-config", label: "Policies", group: "Security" });
  }
  if (deviceTypeHasCapability(type, "nat")) {
    sections.push({ id: "nat-config", label: "NAT", group: "Security" });
  }
  if (QOS_TYPES.has(type)) sections.push({ id: "qos-config", label: "QoS" });
  if (deviceTypeHasCapability(type, "vpn-tunnel")) sections.push({ id: "vpn-config", label: "VPN" });
  if (type === "access-point" || type === "wireless-router") {
    sections.push({ id: "wireless-config", label: "Wireless" });
  }
  if (type === "server") sections.push({ id: "services-config", label: "Services" });
  if (supportsDeviceConfigurationText(type)) {
    sections.push({ id: "configuration-files", label: "Running & Startup", group: "Management" });
  }
  if (MANAGED_TYPES.has(type)) {
    sections.push({ id: "console-config", label: "Console Access", group: "Management" });
    sections.push({ id: "remote-access-config", label: "Remote Access", group: "Management" });
    sections.push({ id: "aaa-config", label: "AAA", group: "Management" });
    sections.push({ id: "snmp-config", label: "SNMP", group: "Management" });
  }
  return sections;
}

function monitorSections(type: DeviceType): DeviceWindowSectionDefinition[] {
  const sections: DeviceWindowSectionDefinition[] = [
    { id: "runtime-overview", label: "Runtime Overview" },
  ];
  if (getDeviceProfile(type).interfaceTemplates.length > 0) {
    sections.push({ id: "interfaces-runtime", label: "Interfaces" });
  }
  if (deviceTypeHasCapability(type, "ipv4-routing")) {
    sections.push({ id: "routes-runtime", label: "Routes" });
    sections.push({ id: "neighbors-runtime", label: "ARP / NDP" });
    sections.push({ id: "protocols-runtime", label: "Protocol Neighbors" });
  }
  if (deviceTypeHasCapability(type, "layer2-switching")) {
    sections.push({ id: "mac-runtime", label: "MAC Table" });
  }
  if (MANAGED_TYPES.has(type)) {
    sections.push({ id: "sessions-runtime", label: "Sessions" });
  }
  if (deviceTypeHasCapability(type, "nat")) sections.push({ id: "nat-runtime", label: "NAT Translations" });
  if (deviceTypeHasCapability(type, "stateful-firewall")) {
    sections.push({ id: "firewall-runtime", label: "Firewall Connections" });
  }
  if (QOS_TYPES.has(type)) sections.push({ id: "qos-runtime", label: "QoS Queues & Counters" });
  if (deviceTypeHasCapability(type, "vpn-tunnel")) sections.push({ id: "vpn-runtime", label: "VPN Sessions" });
  if (MANAGED_TYPES.has(type)) {
    sections.push({ id: "aaa-runtime", label: "AAA Runtime", group: "Management" });
    sections.push({ id: "snmp-runtime", label: "SNMP Runtime", group: "Management" });
  }
  return sections;
}

/** One capability-driven source of truth for device-window information architecture. */
export function getDeviceWindowDefinition(type: DeviceType): DeviceWindowDefinition {
  return {
    mainTabs: mainTabs(type),
    configSections: configSections(type),
    monitorSections: monitorSections(type),
  };
}

export function isManagedDeviceWindow(type: DeviceType): boolean {
  return MANAGED_TYPES.has(type);
}
