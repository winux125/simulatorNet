import { z } from "zod";

export const DEVICE_TYPES = [
  "pc",
  "server",
  "hub",
  "bridge",
  "l2-switch",
  "l3-switch",
  "router",
  "firewall",
  "cloud",
  "traffic-generator",
  "external-appliance",
  "access-point",
  "laptop",
  "smartphone",
  "wireless-router",
] as const;

export const DeviceTypeSchema = z.enum(DEVICE_TYPES);
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const DEVICE_CATEGORIES = [
  "network",
  "wireless",
  "end-device",
  "security",
  "infrastructure",
  "external",
] as const;
export const DeviceCategorySchema = z.enum(DEVICE_CATEGORIES);
export type DeviceCategory = z.infer<typeof DeviceCategorySchema>;

export const DEVICE_CAPABILITIES = [
  "ethernet-end-host",
  "ethernet-repeater",
  "ethernet-bridge",
  "layer2-switching",
  "vlan",
  "dot1q-trunk",
  "spanning-tree",
  "ipv4-host",
  "ipv4-routing",
  "static-routing",
  "router-subinterfaces",
  "svi",
  "dhcp-client",
  "dhcp-server",
  "application-services",
  "packet-policy",
  "nat",
  "stateful-firewall",
  /** Terminates logical GRE tunnels and site-to-site IPsec protection. */
  "vpn-tunnel",
  "network-impairment",
  "traffic-generation",
  "wireless-station",
  "wireless-access-point",
  "wireless-bridge",
  "home-wireless-router",
] as const;

export const DeviceCapabilitySchema = z.enum(DEVICE_CAPABILITIES);
export type DeviceCapability = z.infer<typeof DeviceCapabilitySchema>;

export interface InterfaceTemplate {
  readonly id: string;
  readonly media: "ethernet" | "wireless";
}

export const DEVICE_HARDWARE_PROFILE_IDS = [
  "compact-8",
  "access-24",
  "access-48",
  "multilayer-8",
  "multilayer-24",
  "multilayer-48",
] as const;

export const DeviceHardwareProfileIdSchema = z.enum(DEVICE_HARDWARE_PROFILE_IDS);
export type DeviceHardwareProfileId = z.infer<typeof DeviceHardwareProfileIdSchema>;

export interface DeviceHardwareProfile {
  readonly id: DeviceHardwareProfileId;
  readonly deviceType: "l2-switch" | "l3-switch";
  readonly displayName: string;
  readonly interfaceTemplates: readonly InterfaceTemplate[];
  readonly rackUnitSpan?: number;
  readonly description: string;
}

export type DeviceCliProfile =
  | "pc-host"
  | "server-host"
  | "bridge"
  | "switch"
  | "layer3-switch"
  | "router"
  | "firewall";

export interface DeviceProfile {
  readonly type: DeviceType;
  readonly displayName: string;
  readonly category: DeviceCategory;
  readonly capabilities: readonly DeviceCapability[];
  readonly interfaceTemplates: readonly InterfaceTemplate[];
  readonly iconKey: string;
  /** Absent when the device deliberately has no interactive CLI. */
  readonly cliProfile?: DeviceCliProfile;
  readonly description: string;
}

function ethernet(ids: readonly string[]): readonly InterfaceTemplate[] {
  return ids.map((id) => ({ id, media: "ethernet" as const }));
}

function numbered(prefix: string, first: number, last: number): readonly InterfaceTemplate[] {
  return ethernet(Array.from({ length: last - first + 1 }, (_, index) => `${prefix}${first + index}`));
}

function wireless(ids: readonly string[]): readonly InterfaceTemplate[] {
  return ids.map((id) => ({ id, media: "wireless" as const }));
}

function accessSwitchInterfaces(accessPorts: number, uplinkPorts: number): readonly InterfaceTemplate[] {
  return [
    ...numbered("Fa0/", 1, accessPorts),
    ...numbered("Gi0/", 1, uplinkPorts),
  ];
}

/**
 * Hardware inventory is deliberately separate from DeviceType: all profiles
 * reuse the same L2/L3 protocol implementation and differ only in their
 * bounded physical interface templates.
 */
export const DEVICE_HARDWARE_PROFILES = {
  "compact-8": {
    id: "compact-8",
    deviceType: "l2-switch",
    displayName: "Compact — 8 Gigabit ports",
    interfaceTemplates: numbered("Gi0/", 1, 8),
    rackUnitSpan: 1,
    description: "Compact L2 switch for small labs.",
  },
  "access-24": {
    id: "access-24",
    deviceType: "l2-switch",
    displayName: "Access — 24 ports + 2 uplinks",
    interfaceTemplates: accessSwitchInterfaces(24, 2),
    rackUnitSpan: 1,
    description: "High-density L2 access switch with FastEthernet access ports and Gigabit uplinks.",
  },
  "access-48": {
    id: "access-48",
    deviceType: "l2-switch",
    displayName: "Access — 48 ports + 4 uplinks",
    interfaceTemplates: accessSwitchInterfaces(48, 4),
    rackUnitSpan: 1,
    description: "High-density L2 access switch for large endpoint labs.",
  },
  "multilayer-8": {
    id: "multilayer-8",
    deviceType: "l3-switch",
    displayName: "Multilayer — 8 Gigabit ports",
    interfaceTemplates: numbered("Gi0/", 1, 8),
    rackUnitSpan: 1,
    description: "Compact multilayer switch for routed campus labs.",
  },
  "multilayer-24": {
    id: "multilayer-24",
    deviceType: "l3-switch",
    displayName: "Multilayer — 24 ports + 2 uplinks",
    interfaceTemplates: accessSwitchInterfaces(24, 2),
    rackUnitSpan: 1,
    description: "High-density multilayer access switch with routed and switched ports.",
  },
  "multilayer-48": {
    id: "multilayer-48",
    deviceType: "l3-switch",
    displayName: "Multilayer — 48 ports + 4 uplinks",
    interfaceTemplates: accessSwitchInterfaces(48, 4),
    rackUnitSpan: 1,
    description: "High-density multilayer switch for large campus labs.",
  },
} as const satisfies Record<DeviceHardwareProfileId, DeviceHardwareProfile>;

const DEFAULT_HARDWARE_PROFILE_BY_DEVICE = {
  "l2-switch": "compact-8",
  "l3-switch": "multilayer-8",
} as const satisfies Partial<Record<DeviceType, DeviceHardwareProfileId>>;

export function getDeviceHardwareProfile(id: DeviceHardwareProfileId): DeviceHardwareProfile {
  return DEVICE_HARDWARE_PROFILES[id];
}

export function getDeviceHardwareProfiles(type: DeviceType): readonly DeviceHardwareProfile[] {
  return DEVICE_HARDWARE_PROFILE_IDS
    .map((id) => DEVICE_HARDWARE_PROFILES[id])
    .filter((profile) => profile.deviceType === type);
}

export function getDefaultHardwareProfileId(type: DeviceType): DeviceHardwareProfileId | undefined {
  return DEFAULT_HARDWARE_PROFILE_BY_DEVICE[type as keyof typeof DEFAULT_HARDWARE_PROFILE_BY_DEVICE];
}

export function resolveDeviceInterfaceTemplates(
  type: DeviceType,
  hardwareProfileId?: DeviceHardwareProfileId,
): readonly InterfaceTemplate[] {
  if (!hardwareProfileId) return DEVICE_PROFILES[type].interfaceTemplates;
  const hardwareProfile = DEVICE_HARDWARE_PROFILES[hardwareProfileId];
  return hardwareProfile.deviceType === type
    ? hardwareProfile.interfaceTemplates
    : DEVICE_PROFILES[type].interfaceTemplates;
}

export function inferSwitchHardwareProfile(
  type: DeviceType,
  interfaceIds: readonly string[],
): DeviceHardwareProfileId | undefined {
  if (type !== "l2-switch" && type !== "l3-switch") return undefined;
  const normalized = new Set(interfaceIds.map((id) => id.toLowerCase()));
  const candidates = getDeviceHardwareProfiles(type)
    .filter((profile) => profile.interfaceTemplates.every((template) => normalized.has(template.id.toLowerCase())))
    .sort((a, b) => b.interfaceTemplates.length - a.interfaceTemplates.length || a.id.localeCompare(b.id));
  if (candidates[0]) return candidates[0].id;
  const density = interfaceIds.length > 26 ? 48 : interfaceIds.length > 8 ? 24 : 8;
  if (type === "l2-switch") return density === 48 ? "access-48" : density === 24 ? "access-24" : "compact-8";
  return density === 48 ? "multilayer-48" : density === 24 ? "multilayer-24" : "multilayer-8";
}

/**
 * Browser-safe, immutable-by-convention registry for every supported generic
 * educational device. Profiles contain presentation/configuration metadata
 * only; runtime state and protocol implementations stay in sim-core.
 */
export const DEVICE_PROFILES = {
  pc: {
    type: "pc",
    displayName: "PC",
    category: "end-device",
    capabilities: ["ethernet-end-host", "ipv4-host", "dhcp-client"],
    interfaceTemplates: ethernet(["eth0"]),
    iconKey: "pc",
    cliProfile: "pc-host",
    description: "An IPv4 end host for interactive client actions.",
  },
  server: {
    type: "server",
    displayName: "Server",
    category: "end-device",
    capabilities: ["ethernet-end-host", "ipv4-host", "dhcp-client", "application-services"],
    interfaceTemplates: ethernet(["eth0", "eth1"]),
    iconKey: "server",
    cliProfile: "server-host",
    description: "An IPv4 end host prepared for network services.",
  },
  hub: {
    type: "hub",
    displayName: "Hub",
    category: "network",
    capabilities: ["ethernet-repeater"],
    interfaceTemplates: numbered("Eth0/", 1, 8),
    iconKey: "hub",
    description: "Repeats every Ethernet frame to all other active ports.",
  },
  bridge: {
    type: "bridge",
    displayName: "Bridge",
    category: "network",
    capabilities: ["ethernet-bridge"],
    interfaceTemplates: ethernet(["Eth0/1", "Eth0/2"]),
    iconKey: "bridge",
    cliProfile: "bridge",
    description: "Learns MAC addresses and forwards frames between two segments.",
  },
  "l2-switch": {
    type: "l2-switch",
    displayName: "L2 Switch",
    category: "network",
    capabilities: ["ethernet-bridge", "layer2-switching", "vlan", "dot1q-trunk", "spanning-tree"],
    interfaceTemplates: numbered("Gi0/", 1, 8),
    iconKey: "l2-switch",
    cliProfile: "switch",
    description: "Learns MAC addresses and switches Ethernet frames within VLANs.",
  },
  "l3-switch": {
    type: "l3-switch",
    displayName: "L3 Switch",
    category: "network",
    capabilities: [
      "ethernet-bridge",
      "layer2-switching",
      "vlan",
      "dot1q-trunk",
      "spanning-tree",
      "ipv4-routing",
      "static-routing",
      "svi",
      "packet-policy",
    ],
    interfaceTemplates: numbered("Gi0/", 1, 8),
    iconKey: "l3-switch",
    cliProfile: "layer3-switch",
    description: "Combines VLAN switching with IPv4 routing through SVIs and routed ports.",
  },
  router: {
    type: "router",
    displayName: "Router",
    category: "network",
    capabilities: [
      "ipv4-routing",
      "static-routing",
      "router-subinterfaces",
      "dhcp-server",
      "packet-policy",
      "nat",
      "vpn-tunnel",
    ],
    interfaceTemplates: ethernet(["Gi0/0", "Gi0/1"]),
    iconKey: "router",
    cliProfile: "router",
    description: "Routes IPv4 packets between connected and static networks.",
  },
  firewall: {
    type: "firewall",
    displayName: "Firewall",
    category: "security",
    capabilities: [
      "ipv4-routing",
      "static-routing",
      "packet-policy",
      "nat",
      "stateful-firewall",
      "vpn-tunnel",
    ],
    interfaceTemplates: numbered("Eth0/", 0, 3),
    iconKey: "firewall",
    cliProfile: "firewall",
    description: "Stateful routed security appliance with zones, ACLs, and NAT.",
  },
  cloud: {
    type: "cloud",
    displayName: "Cloud / ISP",
    category: "infrastructure",
    capabilities: ["ipv4-routing", "static-routing", "network-impairment"],
    interfaceTemplates: numbered("Eth0/", 0, 3),
    iconKey: "cloud",
    description: "Simulated routed provider network with deterministic latency and loss.",
  },
  "traffic-generator": {
    type: "traffic-generator",
    displayName: "Traffic Generator",
    category: "infrastructure",
    capabilities: ["ethernet-end-host", "ipv4-host", "traffic-generation"],
    interfaceTemplates: ethernet(["eth0"]),
    iconKey: "traffic-generator",
    description: "Runs bounded ICMP, UDP, TCP, and HTTP test flows.",
  },
  "external-appliance": {
    type: "external-appliance",
    displayName: "External Appliance",
    category: "external",
    capabilities: [],
    interfaceTemplates: [],
    iconKey: "external-appliance",
    description:
      "Imported node from another platform that SimulatorNet does not simulate. Kept as a visual placeholder with no data plane.",
  },
  "access-point": {
    type: "access-point",
    displayName: "Access Point",
    category: "wireless",
    capabilities: ["ethernet-bridge", "wireless-access-point", "wireless-bridge"],
    interfaceTemplates: [...wireless(["wlan0"]), ...ethernet(["eth0"])],
    iconKey: "access-point",
    description: "Bridges associated wireless stations onto one Ethernet uplink.",
  },
  laptop: {
    type: "laptop",
    displayName: "Laptop",
    category: "end-device",
    capabilities: [
      "ethernet-end-host",
      "ipv4-host",
      "dhcp-client",
      "application-services",
      "wireless-station",
    ],
    interfaceTemplates: [...wireless(["wlan0"]), ...ethernet(["eth0"])],
    iconKey: "laptop",
    cliProfile: "pc-host",
    description: "A portable end host with wireless and Ethernet connectivity.",
  },
  smartphone: {
    type: "smartphone",
    displayName: "Smartphone",
    category: "end-device",
    capabilities: ["ipv4-host", "dhcp-client", "application-services", "wireless-station"],
    interfaceTemplates: wireless(["wlan0"]),
    cliProfile: "pc-host",
    iconKey: "smartphone",
    description: "A compact wireless end host with educational network applications.",
  },
  "wireless-router": {
    type: "wireless-router",
    displayName: "Wireless Router",
    category: "wireless",
    capabilities: [
      "ethernet-bridge",
      "layer2-switching",
      "wireless-access-point",
      "wireless-bridge",
      "ipv4-routing",
      "static-routing",
      "dhcp-server",
      "packet-policy",
      "nat",
      "stateful-firewall",
      "home-wireless-router",
    ],
    interfaceTemplates: [
      ...wireless(["wlan0"]),
      ...ethernet(["LAN1", "LAN2", "LAN3", "LAN4", "WAN"]),
    ],
    iconKey: "wireless-router",
    description: "Composes a WLAN, LAN switch, router, DHCP, PAT and stateful firewall.",
  },
} as const satisfies Record<DeviceType, DeviceProfile>;

export const DEVICE_PROFILE_LIST: readonly DeviceProfile[] = DEVICE_TYPES.map((type) => DEVICE_PROFILES[type]);

export function getDeviceProfile(type: DeviceType): DeviceProfile {
  return DEVICE_PROFILES[type];
}

export function deviceTypeHasCapability(type: DeviceType, capability: DeviceCapability): boolean {
  return (DEVICE_PROFILES[type].capabilities as readonly DeviceCapability[]).includes(capability);
}
