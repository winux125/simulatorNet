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
