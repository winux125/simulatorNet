import type {
  AccessPointDeviceConfig,
  LabDocument,
  LaptopDeviceConfig,
  PasswordVerifier,
  RouterDeviceConfig,
  SmartphoneDeviceConfig,
  WirelessRouterDeviceConfig,
} from "@sim/contracts";

const RADIO = {
  enabled: true,
  band: "2.4ghz" as const,
  supportedChannels: [1, 6, 11],
  radioDomainId: "wireless-demo",
};

/** Opaque demo material only; the corresponding plaintext is never persisted. */
const SECURE_LAB_WPA2_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "+3BJNCbCOVD+5zddraLP7g==",
  hashBase64: "5R+gOrpcMzLkxPA40Qbymd+iofuXdynAgCz+avEdLdY=",
};

const HOME_WLAN_WPA2_VERIFIER: PasswordVerifier = {
  algorithm: "pbkdf2-sha256",
  iterations: 120_000,
  saltBase64: "3T3PApgWJCgLehEcA+d3tQ==",
  hashBase64: "bmoyZp6w9rAmVjw60rlUiuyQlxAIKYQGQHsLW315Zm8=",
};

function demoVerifier(ssid: string): PasswordVerifier {
  return ssid === "HOME-WLAN"
    ? { ...HOME_WLAN_WPA2_VERIFIER }
    : { ...SECURE_LAB_WPA2_VERIFIER };
}

function apConfiguration(
  hostname: string,
  ssid: string,
  options: { security?: "open" | "wpa2"; priority?: number } = {},
): AccessPointDeviceConfig {
  return {
    kind: "access-point",
    hostname,
    interfaces: [],
    radio: { ...RADIO, supportedChannels: [...RADIO.supportedChannels] },
    accessPoint: {
      ssid,
      broadcastSsid: true,
      band: "2.4ghz",
      channel: 6,
      enabled: true,
      radioDomainId: RADIO.radioDomainId,
      priority: options.priority ?? 100,
      maximumClients: 32,
      clientIsolation: false,
      security: options.security === "wpa2"
        ? { mode: "wpa2-personal", credentialVerifier: demoVerifier(ssid) }
        : { mode: "open" },
    },
  };
}

function laptopConfiguration(
  hostname: string,
  ssid: string,
  options: {
    security?: "open" | "wpa2";
    dhcp?: boolean;
    address?: string;
    gateway?: string;
    preferredBssid?: string;
  } = {},
): LaptopDeviceConfig {
  const securityMode = options.security === "wpa2" ? "wpa2-personal" : "open";
  return {
    kind: "laptop",
    hostname,
    interfaces: [],
    ipv4: options.address
      ? { address: options.address, prefixLength: 24, defaultGateway: options.gateway }
      : undefined,
    dhcpEnabled: options.dhcp ?? !options.address,
    wireless: {
      radio: { ...RADIO, supportedChannels: [...RADIO.supportedChannels] },
      savedNetworks: [{
        id: `saved-${ssid.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
        ssid,
        securityMode,
        credentialVerifier: securityMode === "wpa2-personal"
          ? demoVerifier(ssid)
          : undefined,
        autoConnect: true,
        preferredBssid: options.preferredBssid,
      }],
      autoConnect: true,
      preferredSsid: ssid,
      preferredBssid: options.preferredBssid,
    },
  };
}

function smartphoneConfiguration(hostname: string, ssid: string): SmartphoneDeviceConfig {
  return {
    kind: "smartphone",
    hostname,
    interfaces: [],
    dhcpEnabled: true,
    ipv6: { mode: "slaac" },
    wireless: {
      radio: { ...RADIO, supportedChannels: [...RADIO.supportedChannels] },
      savedNetworks: [{
        id: `saved-${ssid.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
        ssid,
        securityMode: "wpa2-personal",
        credentialVerifier: demoVerifier(ssid),
        autoConnect: true,
      }],
      autoConnect: true,
      preferredSsid: ssid,
    },
  };
}

function routerConfiguration(
  hostname: string,
  interfaces: RouterDeviceConfig["interfaces"],
  dhcpPools: RouterDeviceConfig["dhcpPools"] = [],
): RouterDeviceConfig {
  return {
    kind: "router",
    hostname,
    interfaces,
    subinterfaces: [],
    staticRoutes: [],
    dhcpPools,
    acls: [],
    aclBindings: [],
    natPools: [],
    natRules: [],
    natInterfaceRoles: [],
  };
}

export const OPEN_WIRELESS_LAN_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "wireless-open-lan",
  title: "Open Wireless LAN",
  description: "Associate a Laptop with an open SSID, obtain DHCP through an AP bridge, and reach the wired gateway.",
  instructions: "Start the lab, open Laptop > Wireless, scan for LAB-OPEN, then connect. Inspect DHCP and ARP in Packet Trace.",
  expectedOutcome: "The Laptop receives 192.168.10.100–150 and can ping 192.168.10.1.",
  simulation: { seed: 10_601 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "laptop-1", kind: "laptop", name: "LAPTOP1", position: { x: 120, y: 250 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "ap-1", kind: "access-point", name: "AP1", position: { x: 430, y: 220 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "router-1", kind: "router", name: "DHCP-R1", position: { x: 750, y: 220 }, interfaces: [{ id: "Gi0/0" }] },
    ],
    links: [
      { id: "ap-uplink", a: { node: "ap-1", iface: "eth0" }, b: { node: "router-1", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    "laptop-1": laptopConfiguration("LAPTOP1", "LAB-OPEN", { security: "open", dhcp: true }),
    "ap-1": apConfiguration("AP1", "LAB-OPEN"),
    "router-1": routerConfiguration(
      "DHCP-R1",
      [{ id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "192.168.10.1", prefixLength: 24 } }],
      [{
        id: "WLAN",
        network: "192.168.10.0",
        prefixLength: 24,
        defaultGateway: "192.168.10.1",
        rangeStart: "192.168.10.100",
        rangeEnd: "192.168.10.150",
        leaseSeconds: 3600,
      }],
    ),
  },
};

export const WPA2_WIRELESS_LAN_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "wireless-wpa2-services",
  title: "WPA2 Wireless LAN",
  description: "Authenticate to WPA2-Personal and use DNS/HTTP on a wired server.",
  instructions: "Connect LAPTOP1 to SECURE-LAB with the key supplied by the lab instructions. Then resolve portal.lab and open HTTP.",
  expectedOutcome: "Incorrect credentials fail without an operational interface; the configured saved verifier associates and reaches 10.20.0.20.",
  simulation: { seed: 10_602 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "laptop-1", kind: "laptop", name: "LAPTOP1", position: { x: 100, y: 240 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "ap-1", kind: "access-point", name: "SECURE-AP", position: { x: 420, y: 210 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "server-1", kind: "server", name: "WEB-SRV", position: { x: 740, y: 210 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [
      { id: "ap-server", a: { node: "ap-1", iface: "eth0" }, b: { node: "server-1", iface: "eth0" } },
    ],
  },
  configurations: {
    "laptop-1": {
      ...laptopConfiguration("LAPTOP1", "SECURE-LAB", { security: "wpa2", address: "10.20.0.10" }),
      dnsServer: "10.20.0.20",
    },
    "ap-1": apConfiguration("SECURE-AP", "SECURE-LAB", { security: "wpa2" }),
    "server-1": {
      kind: "server",
      hostname: "WEB-SRV",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "10.20.0.20", prefixLength: 24 } }],
      dhcpClientEnabled: false,
      enabledServices: [
        { id: "dns", type: "dns", enabled: true, port: 53, records: [{ name: "portal.lab", address: "10.20.0.20" }] },
        { id: "http", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "Wireless lab ready" }] },
      ],
    },
  },
};

export const HOME_WIRELESS_ROUTER_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "wireless-home-router",
  title: "Home Wireless Router",
  description: "A composed WLAN/LAN router provides WPA2, DHCP, SLAAC, routing, PAT and established-return firewall policy.",
  instructions: "Start the lab. Observe Laptop/Smartphone association and DHCP/SLAAC, then browse to the public server through PAT.",
  expectedOutcome: "Private WLAN clients reach 198.51.100.10 while unsolicited inbound WAN traffic remains denied.",
  simulation: { seed: 10_603 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "laptop-1", kind: "laptop", name: "HOME-LAPTOP", position: { x: 90, y: 140 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "phone-1", kind: "smartphone", name: "PHONE1", position: { x: 90, y: 340 }, interfaces: [{ id: "wlan0" }] },
      { id: "wireless-router-1", kind: "wireless-router", name: "HOME-RTR", position: { x: 410, y: 235 }, interfaces: [{ id: "wlan0" }, { id: "LAN1" }, { id: "LAN2" }, { id: "LAN3" }, { id: "LAN4" }, { id: "WAN" }] },
      { id: "isp-1", kind: "cloud", name: "ISP Cloud", position: { x: 740, y: 235 }, interfaces: [{ id: "Gi0/0" }, { id: "Gi0/1" }] },
      { id: "server-1", kind: "server", name: "PUBLIC-SRV", position: { x: 1050, y: 235 }, interfaces: [{ id: "eth0" }, { id: "eth1" }] },
    ],
    links: [
      { id: "wan", a: { node: "wireless-router-1", iface: "WAN" }, b: { node: "isp-1", iface: "Gi0/0" } },
      { id: "public", a: { node: "isp-1", iface: "Gi0/1" }, b: { node: "server-1", iface: "eth0" } },
    ],
  },
  configurations: {
    "laptop-1": laptopConfiguration("HOME-LAPTOP", "HOME-WLAN", { security: "wpa2", dhcp: true }),
    "phone-1": smartphoneConfiguration("PHONE1", "HOME-WLAN"),
    "wireless-router-1": {
      kind: "wireless-router",
      hostname: "HOME-RTR",
      interfaces: [],
      radio: { ...RADIO, supportedChannels: [...RADIO.supportedChannels] },
      accessPoint: {
        ...apConfiguration("HOME-RTR", "HOME-WLAN", { security: "wpa2" }).accessPoint,
      },
      lan: {
        address: "192.168.50.1",
        prefixLength: 24,
        dhcpEnabled: true,
        dhcpRangeStart: "192.168.50.100",
        dhcpRangeEnd: "192.168.50.150",
        ipv6Address: "2001:db8:50::1",
        ipv6PrefixLength: 64,
        routerAdvertisementEnabled: true,
        dhcpv6Enabled: false,
      },
      wan: { mode: "static", address: "203.0.113.2", prefixLength: 30, defaultGateway: "203.0.113.1" },
      natEnabled: true,
      firewallEnabled: true,
    } satisfies WirelessRouterDeviceConfig,
    "isp-1": {
      ...routerConfiguration("ISP Cloud", [
        { id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "203.0.113.1", prefixLength: 30 } },
        { id: "Gi0/1", shutdown: false, routed: true, ipv4: { address: "198.51.100.1", prefixLength: 24 } },
      ]),
      kind: "cloud",
      impairments: [],
    },
    "server-1": {
      kind: "server",
      hostname: "PUBLIC-SRV",
      interfaces: [{ id: "eth0", shutdown: false, ipv4: { address: "198.51.100.10", prefixLength: 24 } }],
      defaultGateway: "198.51.100.1",
      dhcpClientEnabled: false,
      enabledServices: [
        { id: "http", type: "http", enabled: true, port: 80, resources: [{ path: "/", contentType: "text/plain", body: "Public service reached through PAT" }] },
      ],
    },
  },
};

export const AP_FAILOVER_DEMO: LabDocument = {
  schemaVersion: 1,
  id: "wireless-ap-failover",
  title: "AP Failover",
  description: "Two APs share one SSID and bridged LAN; deterministic priority selects the primary and AP shutdown triggers roaming.",
  instructions: "Start the lab, confirm association to AP-PRIMARY, disable it, then inspect the wireless-roamed event and restored DHCP connectivity.",
  expectedOutcome: "The station keeps its MAC and roams to AP-BACKUP without creating or changing a physical topology link.",
  simulation: { seed: 10_604 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "laptop-1", kind: "laptop", name: "ROAM-LAPTOP", position: { x: 90, y: 230 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "ap-1", kind: "access-point", name: "AP-PRIMARY", position: { x: 360, y: 100 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "ap-2", kind: "access-point", name: "AP-BACKUP", position: { x: 360, y: 360 }, interfaces: [{ id: "wlan0" }, { id: "eth0" }] },
      { id: "switch-1", kind: "l2-switch", name: "WLAN-SW", position: { x: 650, y: 230 }, interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }] },
      { id: "router-1", kind: "router", name: "WLAN-R1", position: { x: 930, y: 230 }, interfaces: [{ id: "Gi0/0" }] },
    ],
    links: [
      { id: "ap1-uplink", a: { node: "ap-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
      { id: "ap2-uplink", a: { node: "ap-2", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/2" } },
      { id: "gateway-uplink", a: { node: "switch-1", iface: "Gi0/3" }, b: { node: "router-1", iface: "Gi0/0" } },
    ],
  },
  configurations: {
    "laptop-1": laptopConfiguration("ROAM-LAPTOP", "CAMPUS-WLAN", { dhcp: true }),
    "ap-1": apConfiguration("AP-PRIMARY", "CAMPUS-WLAN", { priority: 200 }),
    "ap-2": apConfiguration("AP-BACKUP", "CAMPUS-WLAN", { priority: 100 }),
    "switch-1": { kind: "l2-switch", hostname: "WLAN-SW", interfaces: [], vlans: [] },
    "router-1": routerConfiguration(
      "WLAN-R1",
      [{ id: "Gi0/0", shutdown: false, routed: true, ipv4: { address: "172.16.60.1", prefixLength: 24 } }],
      [{
        id: "ROAMING",
        network: "172.16.60.0",
        prefixLength: 24,
        defaultGateway: "172.16.60.1",
        rangeStart: "172.16.60.100",
        rangeEnd: "172.16.60.150",
        leaseSeconds: 3600,
      }],
    ),
  },
};

export const WIRELESS_DEMO_LABS = [
  OPEN_WIRELESS_LAN_DEMO,
  WPA2_WIRELESS_LAN_DEMO,
  HOME_WIRELESS_ROUTER_DEMO,
  AP_FAILOVER_DEMO,
] as const;
