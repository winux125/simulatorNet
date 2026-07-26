// Self-made fixtures for the import adapters. None of these are copied from real
// third-party labs; they are minimal, hand-written documents that exercise the
// adapters, mapping, config application and security paths.

export const PNETLAB_UNL = `<?xml version="1.0" encoding="UTF-8"?>
<lab name="Campus" id="lab1" version="1">
  <topology>
    <nodes>
      <node id="1" name="R1" type="qemu" template="iosv" left="100" top="120" icon="Router.png">
        <interface id="0" name="Gi0/0" network_id="1"/>
        <interface id="1" name="Gi0/1" network_id="2"/>
        <config><![CDATA[hostname R1
interface Gi0/0
 ip address 10.0.0.1 255.255.255.0
 no shutdown
interface Gi0/1
 ip address 10.0.9.1 255.255.255.0
 no shutdown
router ospf 1
 router-id 1.1.1.1
 network 10.0.0.0 0.0.0.255 area 0
router bgp 65000
 neighbor 10.0.9.2 remote-as 65001]]></config>
      </node>
      <node id="2" name="SW1" type="iol" template="iol-l2-adventerprise" left="300" top="120">
        <interface id="0" name="e0/0" network_id="1"/>
        <interface id="1" name="e0/1" network_id="3"/>
        <interface id="2" name="e0/2" network_id="4"/>
      </node>
      <node id="3" name="PC1" type="qemu" template="vpcs" left="500" top="60">
        <interface id="0" name="e0" network_id="3"/>
        <config><![CDATA[ip 10.0.0.10/24 10.0.0.1]]></config>
      </node>
      <node id="4" name="PC2" type="qemu" template="vpcs" left="500" top="200">
        <interface id="0" name="e0" network_id="4"/>
        <config><![CDATA[ip 10.0.0.11/24 10.0.0.1]]></config>
      </node>
    </nodes>
    <networks>
      <network id="1" type="bridge" name="Net1"/>
      <network id="2" type="bridge" name="Net2"/>
      <network id="3" type="bridge" name="Net3"/>
      <network id="4" type="bridge" name="Net4"/>
    </networks>
  </topology>
</lab>`;

export const EVE_UNL = `<?xml version="1.0"?>
<lab name="Annotated" version="2">
  <topology>
    <nodes>
      <node id="1" name="R1" type="iol" template="iol-l3" left="40" top="40">
        <interface id="0" name="e0/0" network_id="1"/>
      </node>
      <node id="2" name="R2" type="iol" template="iol-l3" left="240" top="40">
        <interface id="0" name="e0/0" network_id="1"/>
      </node>
    </nodes>
    <networks><network id="1" type="bridge" name="Core"/></networks>
    <objects>
      <textobjects>
        <textobject x="120" y="10"><data>Core Link</data></textobject>
      </textobjects>
    </objects>
  </topology>
</lab>`;

export const UNKNOWN_UNL = `<?xml version="1.0"?>
<lab name="Mystery" version="1"><topology>
  <nodes><node id="1" name="MYSTERY" type="acme9000fw" left="0" top="0"><interface id="0" name="e0" network_id="0"/></node></nodes>
  <networks/>
</topology></lab>`;

export const GNS3_JSON = JSON.stringify({
  name: "gns3lab",
  version: "2.2.42",
  project_id: "proj-1",
  revision: 9,
  topology: {
    nodes: [
      { node_id: "aaaa", name: "PC1", node_type: "vpcs", x: 10, y: 20, ports: [{ name: "Ethernet0", adapter_number: 0, port_number: 0 }] },
      { node_id: "bbbb", name: "SW1", node_type: "ethernet_switch", x: 100, y: 20, ports: [{ name: "Ethernet0", adapter_number: 0, port_number: 0 }, { name: "Ethernet1", adapter_number: 0, port_number: 1 }] },
      { node_id: "cccc", name: "R1", node_type: "qemu", x: 200, y: 20, properties: { hda_disk_image: "iosv-15.6.qcow2" }, ports: [{ name: "GigabitEthernet0/0", adapter_number: 0, port_number: 0 }] },
    ],
    links: [
      { link_id: "l1", nodes: [{ node_id: "aaaa", adapter_number: 0, port_number: 0 }, { node_id: "bbbb", adapter_number: 0, port_number: 0 }] },
      { link_id: "l2", nodes: [{ node_id: "bbbb", adapter_number: 0, port_number: 1 }, { node_id: "cccc", adapter_number: 0, port_number: 0 }] },
    ],
    drawings: [{ drawing_id: "d1", x: 5, y: 5, svg: '<svg width="120" height="20"><text>Core</text></svg>' }],
  },
});

export const CONTAINERLAB_YAML = `name: clab1
topology:
  nodes:
    r1:
      kind: vr-csr
      image: vrnetlab/vr-csr:17.03.04
      startup-config: |
        hostname R1
        interface GigabitEthernet1
         ip address 10.0.0.1 255.255.255.0
         no shutdown
    sw1:
      kind: bridge
    srl1:
      kind: srl
      image: ghcr.io/nokia/srlinux:latest
  links:
    - endpoints: ["r1:GigabitEthernet1", "sw1:eth1"]
    - endpoints: ["sw1:eth2", "srl1:e1-1"]
`;

export const CML_YAML = `lab:
  title: CML Campus
nodes:
  - id: n0
    label: R1
    node_definition: iosv
    x: 50
    y: 60
    configuration: |
      hostname R1
      interface GigabitEthernet0/0
       ip address 10.0.0.1 255.255.255.0
    interfaces:
      - id: i0
        label: GigabitEthernet0/0
  - id: n1
    label: HOST1
    node_definition: alpine
    x: 150
    y: 60
    interfaces:
      - id: i0
        label: eth0
links:
  - id: l0
    n1: n0
    i1: i0
    n2: n1
    i2: i0
annotations:
  - type: text
    x1: 20
    y1: 20
    text_content: Campus Core
`;

export const VIRL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<topology xmlns="http://www.cisco.com/VIRL">
  <node name="iosv-0" type="SIMPLE" subtype="IOSv" location="30,40">
    <interface id="0" name="GigabitEthernet0/0"/>
    <extensions><entry key="config">hostname R1</entry></extensions>
  </node>
  <node name="iosv-1" type="SIMPLE" subtype="IOSvL2" location="130,40">
    <interface id="0" name="GigabitEthernet0/0"/>
  </node>
  <connection src="/virl:topology/virl:node[@name='iosv-0']/virl:interface[@id='0']" dst="/virl:topology/virl:node[@name='iosv-1']/virl:interface[@id='0']"/>
</topology>`;

/** Minimal but valid PNG header (signature + IHDR with real dimensions). */
export function tinyPng(width = 4, height = 4): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** qcow2 magic + filler, so the classifier flags it as a vendor image. */
export const FAKE_QCOW2 = Uint8Array.from([0x51, 0x46, 0x49, 0xfb, 0x00, 0x00, 0x00, 0x03, 0xde, 0xad, 0xbe, 0xef]);
