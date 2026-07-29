import {
  DEVICE_TYPES,
  type AccessPointDeviceConfig,
  type DeviceConfig,
  type DeviceType,
  type LabDocument,
  type Layer3SwitchDeviceConfig,
  type LaptopDeviceConfig,
  type PcDeviceConfig,
  type ServerDeviceConfig,
  type SmartphoneDeviceConfig,
  type SwitchDeviceConfig,
} from "@sim/contracts";
import { addDraftDevice, renameDraftDevice } from "../features/lab/document";

const LAYOUT: ReadonlyArray<{
  type: DeviceType;
  hostname: string;
  position: { x: number; y: number };
}> = [
  { type: "cloud", hostname: "ISP-CLOUD", position: { x: 40, y: 70 } },
  { type: "firewall", hostname: "EDGE-FW", position: { x: 270, y: 70 } },
  { type: "router", hostname: "CORE-R1", position: { x: 500, y: 70 } },
  { type: "l3-switch", hostname: "CORE-SW", position: { x: 730, y: 70 } },
  { type: "wireless-router", hostname: "HOME-WRT", position: { x: 960, y: 70 } },
  { type: "traffic-generator", hostname: "TESTER", position: { x: 40, y: 300 } },
  { type: "external-appliance", hostname: "UNSUPPORTED", position: { x: 270, y: 300 } },
  { type: "l2-switch", hostname: "ACCESS-SW", position: { x: 500, y: 300 } },
  { type: "access-point", hostname: "LAB-AP", position: { x: 730, y: 300 } },
  { type: "smartphone", hostname: "PHONE1", position: { x: 960, y: 300 } },
  { type: "pc", hostname: "PC1", position: { x: 40, y: 530 } },
  { type: "hub", hostname: "HUB1", position: { x: 270, y: 530 } },
  { type: "bridge", hostname: "BR1", position: { x: 500, y: 530 } },
  { type: "server", hostname: "SRV1", position: { x: 730, y: 530 } },
  { type: "laptop", hostname: "LAPTOP1", position: { x: 960, y: 530 } },
];

function withOpenWirelessProfile<T extends LaptopDeviceConfig | SmartphoneDeviceConfig>(
  configuration: T,
): T {
  return {
    ...configuration,
    wireless: {
      ...configuration.wireless,
      savedNetworks: [{
        id: "saved-icon-lab",
        ssid: "SimulatorNet",
        securityMode: "open",
        autoConnect: true,
      }],
      autoConnect: true,
      preferredSsid: "SimulatorNet",
    },
  };
}

function buildAllDevicesIconDemo(): LabDocument {
  let document: LabDocument = {
    schemaVersion: 1,
    id: "demo-all-device-icons",
    title: "All Devices Icon Laboratory",
    description: "Compare every built-in SimulatorNet device silhouette while preserving a runnable wired and wireless topology.",
    instructions: "Switch View > Device Icon Style while the lab is running. Verify that links, CLI sessions and wireless associations remain intact.",
    expectedOutcome: "All fifteen device types remain recognizable in Classic Lab, Education Flat and Minimal Network.",
    simulation: { seed: 10_711 },
    topology: { schemaVersion: 1, nodes: [], links: [] },
    configurations: {},
  };

  for (const entry of LAYOUT) {
    document = addDraftDevice(document, entry.type, entry.position);
    const added = document.topology.nodes.at(-1);
    if (added) document = renameDraftDevice(document, added.id, entry.hostname);
  }

  const configurations: Record<string, DeviceConfig> = { ...document.configurations };
  const pc = configurations["pc-1"] as PcDeviceConfig;
  configurations["pc-1"] = {
    ...pc,
    ipv4: { address: "192.168.77.10", prefixLength: 24 },
    dhcpEnabled: false,
  };
  const server = configurations["server-1"] as ServerDeviceConfig;
  configurations["server-1"] = {
    ...server,
    interfaces: [{
      id: "eth0",
      shutdown: false,
      ipv4: { address: "192.168.77.20", prefixLength: 24 },
    }],
  };
  const layer2Switch = configurations["switch-1"] as SwitchDeviceConfig;
  configurations["switch-1"] = {
    ...layer2Switch,
    etherChannels: [{
      channelId: 1,
      mode: "on",
      members: ["Gi0/1", "Gi0/2"],
      minimumLinks: 1,
    }],
  };
  const layer3Switch = configurations["l3-switch-1"] as Layer3SwitchDeviceConfig;
  configurations["l3-switch-1"] = {
    ...layer3Switch,
    etherChannels: [{
      channelId: 1,
      mode: "on",
      members: ["Gi0/2", "Gi0/3"],
      minimumLinks: 1,
    }],
  };
  const accessPoint = configurations["access-point-1"] as AccessPointDeviceConfig;
  configurations["access-point-1"] = {
    ...accessPoint,
    accessPoint: { ...accessPoint.accessPoint, priority: 200 },
  };
  configurations["laptop-1"] = withOpenWirelessProfile(
    configurations["laptop-1"] as LaptopDeviceConfig,
  );
  configurations["smartphone-1"] = withOpenWirelessProfile(
    configurations["smartphone-1"] as SmartphoneDeviceConfig,
  );

  return {
    ...document,
    configurations,
    topology: {
      ...document.topology,
      links: [
        { id: "wan-cloud", a: { node: "cloud-1", iface: "Eth0/0" }, b: { node: "firewall-1", iface: "Eth0/0" } },
        { id: "wan-firewall", a: { node: "firewall-1", iface: "Eth0/1" }, b: { node: "router-1", iface: "Gi0/0" } },
        { id: "core-routing", a: { node: "router-1", iface: "Gi0/1" }, b: { node: "l3-switch-1", iface: "Gi0/1" } },
        { id: "etherchannel-a", a: { node: "l3-switch-1", iface: "Gi0/2" }, b: { node: "switch-1", iface: "Gi0/1" } },
        { id: "etherchannel-b", a: { node: "l3-switch-1", iface: "Gi0/3" }, b: { node: "switch-1", iface: "Gi0/2" } },
        { id: "test-link", a: { node: "traffic-generator-1", iface: "eth0" }, b: { node: "l3-switch-1", iface: "Gi0/4" } },
        { id: "pc-hub", a: { node: "pc-1", iface: "eth0" }, b: { node: "hub-1", iface: "Eth0/1" } },
        { id: "hub-access", a: { node: "hub-1", iface: "Eth0/2" }, b: { node: "switch-1", iface: "Gi0/3" } },
        { id: "access-bridge", a: { node: "switch-1", iface: "Gi0/4" }, b: { node: "bridge-1", iface: "Eth0/1" } },
        { id: "bridge-server", a: { node: "bridge-1", iface: "Eth0/2" }, b: { node: "server-1", iface: "eth0" } },
        { id: "ap-uplink", a: { node: "access-point-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/5" } },
        { id: "wireless-router-lan", a: { node: "wireless-router-1", iface: "LAN1" }, b: { node: "switch-1", iface: "Gi0/6" } },
      ],
    },
    diagram: {
      annotations: [{
        id: "icon-lab-title",
        type: "text",
        position: { x: 405, y: 5 },
        width: 350,
        content: "SimulatorNet device silhouettes",
        fontSize: 18,
        bold: true,
        italic: false,
        alignment: "center",
        foreground: "auto",
        rotation: 0,
        zIndex: 2,
      }],
      linkLabels: [
        { linkId: "wan-firewall", text: "WAN /31", position: 0.5, offset: -15, followLink: true, visible: true },
        { linkId: "etherchannel-a", text: "EtherChannel", position: 0.5, offset: -17, followLink: true, visible: true },
        { linkId: "bridge-server", text: "192.168.77.0/24", position: 0.52, offset: -15, followLink: true, visible: true },
      ],
      linkStyles: [],
    },
  };
}

export const ALL_DEVICES_ICON_DEMO = buildAllDevicesIconDemo();

if (ALL_DEVICES_ICON_DEMO.topology.nodes.length !== DEVICE_TYPES.length) {
  throw new Error("All Devices Icon Laboratory must contain every DeviceType exactly once.");
}
