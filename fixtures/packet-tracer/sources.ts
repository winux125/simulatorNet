/**
 * The XML the committed `.pkt`/`.pka` fixtures beside this file carry.
 *
 * These are **synthetic-format fixtures**: real container geometry — the same
 * compression, masking and Twofish-EAX layers Packet Tracer writes — carrying
 * XML authored here. They are not files written by Cisco Packet Tracer, and
 * they do not prove compatibility with Cisco's own XML vocabulary. That is what
 * the real-fixture gate is for; see `README.md`.
 *
 * Keeping the sources as data means a test can assert what a fixture *should*
 * decode to without re-deriving it, and a regenerated container can be checked
 * against the same statement of intent.
 */

export interface PacketTracerFixtureSource {
  /** Filename beside this module. */
  readonly file: string;
  readonly format: "pkt" | "pka";
  readonly xml: string;
  /** What the fixture exists to exercise, for a reader of a failing test. */
  readonly purpose: string;
}

const VERSION = "8.2.0.0400";

interface DeviceOptions {
  readonly name: string;
  readonly engine: string;
  readonly model: string;
  readonly ports?: number;
  readonly x: number;
  readonly y: number;
  readonly ip?: string;
  readonly subnet?: string;
  readonly gateway?: string;
  readonly runningConfig?: readonly string[];
}

/**
 * One `<DEVICE>`. A `<PORT>` deliberately carries no name — Packet Tracer
 * derives interface names from the chassis at load time — so ports here only
 * establish how many the device has.
 */
function device(refId: string, options: DeviceOptions): string {
  const ports = Array.from({ length: options.ports ?? 1 }, () => [
    "        <PORT>",
    "         <TYPE>eCopperFastEthernet</TYPE>",
    `         ${options.ip !== undefined ? `<IP>${options.ip}</IP>` : "<IP/>"}`,
    `         ${options.subnet !== undefined ? `<SUBNET>${options.subnet}</SUBNET>` : "<SUBNET/>"}`,
    "         <PORT_DHCP_ENABLE>false</PORT_DHCP_ENABLE>",
    "        </PORT>",
  ].join("\n")).join("\n");
  const running = options.runningConfig === undefined
    ? ""
    : `\n     <RUNNINGCONFIG>${options.runningConfig.map((line) => `<LINE>${line}</LINE>`).join("")}</RUNNINGCONFIG>`;
  return [
    "   <DEVICE>",
    "    <ENGINE>",
    `     <TYPE customModel="" model="${options.model}">${options.engine}</TYPE>`,
    `     <NAME translate="true">${options.name}</NAME>`,
    "     <MODULE><SLOT><MODULE>",
    ports,
    "     </MODULE></SLOT></MODULE>",
    `     <SAVE_REF_ID>save-ref-id:${refId}</SAVE_REF_ID>`,
    options.gateway === undefined ? "" : `     <GATEWAY>${options.gateway}</GATEWAY>`,
    running,
    "    </ENGINE>",
    `    <WORKSPACE><LOGICAL><X>${options.x}</X><Y>${options.y}</Y></LOGICAL></WORKSPACE>`,
    "   </DEVICE>",
  ].filter((line) => line !== "").join("\n");
}

/** One `<CABLE>`: four ordered siblings, so each port follows its endpoint. */
function cable(fromRef: string, fromPort: string, toRef: string, toPort: string): string {
  return [
    "   <LINK>",
    "    <TYPE>eCopper</TYPE>",
    "    <CABLE>",
    `     <FROM>save-ref-id:${fromRef}</FROM>`,
    `     <PORT>${fromPort}</PORT>`,
    `     <TO>save-ref-id:${toRef}</TO>`,
    `     <PORT>${toPort}</PORT>`,
    "     <TYPE>eStraightThrough</TYPE>",
    "    </CABLE>",
    "   </LINK>",
  ].join("\n");
}

function network(devices: readonly string[], links: readonly string[]): string {
  return [
    " <NETWORK>",
    "  <DEVICES>",
    ...devices,
    "  </DEVICES>",
    "  <LINKS>",
    ...links,
    "  </LINKS>",
    " </NETWORK>",
  ].join("\n");
}

function labDocument(devices: readonly string[], links: readonly string[]): string {
  return `<PACKETTRACER5>\n <VERSION>${VERSION}</VERSION>\n${network(devices, links)}\n</PACKETTRACER5>\n`;
}

const SWITCH_MODEL = "2960-24TT";
/** A 2960-24TT is 24 access ports plus two uplinks. */
const SWITCH_PORTS = 26;

// --- basic-lab.pkt: two hosts either side of one switch -------------------

const BASIC = labDocument(
  [
    device("1", { name: "PC0", engine: "Pc", model: "PC-PT", x: 160, y: 320 }),
    device("2", { name: "Switch0", engine: "Switch", model: SWITCH_MODEL, ports: SWITCH_PORTS, x: 340, y: 180 }),
    device("3", { name: "PC1", engine: "Pc", model: "PC-PT", x: 520, y: 320 }),
  ],
  [
    cable("1", "FastEthernet0", "2", "FastEthernet0/1"),
    cable("2", "FastEthernet0/2", "3", "FastEthernet0"),
  ],
);

// --- configured-lab.pkt: a routed network with real device configuration ---

const ROUTER_CONFIG = [
  "!",
  "hostname R1",
  "!",
  "interface GigabitEthernet0/0",
  " ip address 192.168.10.1 255.255.255.0",
  " no shutdown",
  "!",
  "interface GigabitEthernet0/1",
  " ip address 10.20.0.1 255.255.255.252",
  " no shutdown",
  "!",
  "ip route 0.0.0.0 0.0.0.0 10.20.0.2",
  "!",
  "end",
];

const SWITCH_CONFIG = [
  "!",
  "hostname Switch0",
  "!",
  "interface FastEthernet0/1",
  " switchport mode access",
  " switchport access vlan 1",
  "!",
  "end",
];

const CONFIGURED = labDocument(
  [
    device("1", {
      name: "R1", engine: "Router", model: "1941", ports: 2, x: 180, y: 140,
      runningConfig: ROUTER_CONFIG,
    }),
    device("2", {
      name: "Switch0", engine: "Switch", model: SWITCH_MODEL, ports: SWITCH_PORTS, x: 380, y: 240,
      runningConfig: SWITCH_CONFIG,
    }),
    device("3", {
      name: "PC0", engine: "Pc", model: "PC-PT", x: 260, y: 400,
      ip: "192.168.10.10", subnet: "255.255.255.0", gateway: "192.168.10.1",
    }),
    device("4", {
      name: "PC1", engine: "Pc", model: "PC-PT", x: 500, y: 400,
      ip: "192.168.10.11", subnet: "255.255.255.0", gateway: "192.168.10.1",
    }),
  ],
  [
    cable("1", "GigabitEthernet0/0", "2", "FastEthernet0/1"),
    cable("2", "FastEthernet0/2", "3", "FastEthernet0"),
    cable("2", "FastEthernet0/3", "4", "FastEthernet0"),
  ],
);

// --- activity.pka: an activity holding an initial and an answer network ----

const ACTIVITY_INITIAL = `<PACKETTRACER5>\n${network(
  [
    device("1", { name: "PC0", engine: "Pc", model: "PC-PT", x: 200, y: 300 }),
    device("2", { name: "Switch0", engine: "Switch", model: SWITCH_MODEL, ports: SWITCH_PORTS, x: 380, y: 180 }),
  ],
  [cable("1", "FastEthernet0", "2", "FastEthernet0/1")],
)}\n</PACKETTRACER5>`;

const ACTIVITY_ANSWER = `<PACKETTRACER5>\n${network(
  [
    device("1", {
      name: "PC0", engine: "Pc", model: "PC-PT", x: 200, y: 300,
      ip: "192.168.20.10", subnet: "255.255.255.0", gateway: "192.168.20.1",
    }),
    device("2", { name: "Switch0", engine: "Switch", model: SWITCH_MODEL, ports: SWITCH_PORTS, x: 380, y: 180 }),
    device("3", {
      name: "PC1", engine: "Pc", model: "PC-PT", x: 560, y: 300,
      ip: "192.168.20.11", subnet: "255.255.255.0", gateway: "192.168.20.1",
    }),
  ],
  [
    cable("1", "FastEthernet0", "2", "FastEthernet0/1"),
    cable("2", "FastEthernet0/2", "3", "FastEthernet0"),
  ],
)}\n</PACKETTRACER5>`;

const ACTIVITY = [
  "<PACKETTRACER5_ACTIVITY>",
  ` <VERSION>${VERSION}</VERSION>`,
  " <TITLE>Connect two hosts through a switch</TITLE>",
  " <INSTRUCTIONS>Cable PC1 to the switch and give both hosts an address in 192.168.20.0/24.</INSTRUCTIONS>",
  ` <INITIAL_NETWORK>${ACTIVITY_INITIAL}</INITIAL_NETWORK>`,
  ` <ANSWER_NETWORK>${ACTIVITY_ANSWER}</ANSWER_NETWORK>`,
  "</PACKETTRACER5_ACTIVITY>",
  "",
].join("\n");

export const PACKET_TRACER_FIXTURE_SOURCES: readonly PacketTracerFixtureSource[] = [
  {
    file: "basic-lab.pkt",
    format: "pkt",
    xml: BASIC,
    purpose: "Two hosts either side of one switch: the smallest importable topology.",
  },
  {
    file: "configured-lab.pkt",
    format: "pkt",
    xml: CONFIGURED,
    purpose: "Router and switch running-configs plus static host addressing.",
  },
  {
    file: "activity.pka",
    format: "pka",
    xml: ACTIVITY,
    purpose: "An activity holding an initial and an answer network, so the choice must be offered.",
  },
];
