/**
 * Mapping behaviour against synthetic-format containers: real container
 * geometry carrying XML we author, so a case can be constructed that the one
 * local real fixture does not contain.
 *
 * The activity documents here model `.pka` structure as this importer
 * understands it — an activity root wrapping several network documents in
 * role-named elements. That shape has *not* been checked against a container
 * written by Packet Tracer itself, because no permissively-licensed real `.pka`
 * has been available; the parser is written tolerantly for exactly that reason
 * and reports an unrecognised role rather than guessing one.
 */
import { describe, expect, it } from "vitest";
import {
  encodeModernContainer,
} from "../../packet-tracer-format/tests/helpers/encode";
import { executeLabImport } from "../src/plan/plan";
import { inspectPacketTracerFile } from "../src/packet-tracer/inspect";

interface DeviceOptions {
  readonly name: string;
  readonly engine: string;
  readonly model: string;
  readonly ports?: number;
  readonly x?: number;
  readonly y?: number;
  readonly runningConfig?: readonly string[];
  readonly ip?: string;
  readonly subnet?: string;
  readonly gateway?: string;
}

function device(options: DeviceOptions, refId: string): string {
  const ports = Array.from({ length: options.ports ?? 1 }, () => `
        <PORT>
         <TYPE>eCopperFastEthernet</TYPE>
         ${options.ip !== undefined ? `<IP>${options.ip}</IP>` : "<IP/>"}
         ${options.subnet !== undefined ? `<SUBNET>${options.subnet}</SUBNET>` : "<SUBNET/>"}
         <PORT_DHCP_ENABLE>false</PORT_DHCP_ENABLE>
        </PORT>`).join("");
  const config = options.runningConfig
    ? `<RUNNINGCONFIG>${options.runningConfig.map((line) => `<LINE>${line}</LINE>`).join("")}</RUNNINGCONFIG>`
    : "";
  return `
   <DEVICE>
    <ENGINE>
     <TYPE customModel="" model="${options.model}">${options.engine}</TYPE>
     <NAME translate="true">${options.name}</NAME>
     <MODULE><SLOT><MODULE>${ports}</MODULE></SLOT></MODULE>
     <SAVE_REF_ID>save-ref-id:${refId}</SAVE_REF_ID>
     ${options.gateway !== undefined ? `<GATEWAY>${options.gateway}</GATEWAY>` : ""}
     ${config}
    </ENGINE>
    <WORKSPACE><LOGICAL><X>${options.x ?? 100}</X><Y>${options.y ?? 100}</Y></LOGICAL></WORKSPACE>
   </DEVICE>`;
}

function cable(fromRef: string, fromPort: string, toRef: string, toPort: string, type = "eStraightThrough"): string {
  return `
   <LINK>
    <TYPE>eCopper</TYPE>
    <CABLE>
     <FROM>save-ref-id:${fromRef}</FROM>
     <PORT>${fromPort}</PORT>
     <TO>save-ref-id:${toRef}</TO>
     <PORT>${toPort}</PORT>
     <TYPE>${type}</TYPE>
    </CABLE>
   </LINK>`;
}

const networkXml = (devices: string, links: string): string =>
  `<NETWORK><DEVICES>${devices}</DEVICES><LINKS>${links}</LINKS></NETWORK>`;

const documentXml = (devices: string, links: string, version = "8.2.0.0400"): string =>
  `<PACKETTRACER5><VERSION>${version}</VERSION>${networkXml(devices, links)}</PACKETTRACER5>`;

const SIMPLE = documentXml(
  device({ name: "R1", engine: "Router", model: "1941", ports: 2, x: 100, y: 100 }, "1")
  + device({ name: "SW1", engine: "Switch", model: "2960-24TT", ports: 26, x: 300, y: 100 }, "2"),
  cable("1", "GigabitEthernet0/0", "2", "FastEthernet0/1"),
);

async function inspect(xml: string, filename = "lab.pkt"): ReturnType<typeof inspectPacketTracerFile> {
  return inspectPacketTracerFile({ filename, bytes: await encodeModernContainer(xml) });
}

describe("Packet Tracer mapping", () => {
  it("maps a router-to-switch link onto real interfaces", async () => {
    const { plan } = await inspect(SIMPLE);
    const { document } = executeLabImport(plan);
    const byName = new Map(document.topology.nodes.map((node) => [node.name, node]));

    expect(byName.get("R1")?.kind).toBe("router");
    expect(byName.get("SW1")?.kind).toBe("l2-switch");
    const link = document.topology.links[0]!;
    expect(link.a.iface).toBe("Gi0/0");
    expect(link.b.iface).toBe("Fa0/1");
  });

  it("keeps an unsupported model as a placeholder and says so", async () => {
    const xml = documentXml(
      device({ name: "Thing0", engine: "IoT Device", model: "Smart Fan" }, "1")
      + device({ name: "SW1", engine: "Switch", model: "2960-24TT", ports: 26 }, "2"),
      "",
    );
    const { plan } = await inspect(xml);
    const proposal = plan.proposals.find((entry) => entry.label === "Thing0")!;

    expect(proposal.suggestedDeviceType).toBeUndefined();
    expect(plan.report.entries.some((entry) =>
      entry.code === "packet-tracer-unsupported-model" && entry.message.includes("Smart Fan"))).toBe(true);

    // The device survives as an external appliance rather than vanishing.
    const { document } = executeLabImport(plan);
    expect(document.topology.nodes.find((node) => node.name === "Thing0")?.kind).toBe("external-appliance");
  });

  it("drops a link it cannot place rather than attaching it to a free port", async () => {
    const xml = documentXml(
      device({ name: "R1", engine: "Router", model: "1941", ports: 2 }, "1")
      + device({ name: "SW1", engine: "Switch", model: "2960-24TT", ports: 26 }, "2"),
      cable("1", "UnknownModule0/1", "2", "FastEthernet0/1"),
    );
    const { plan } = await inspect(xml);
    const { document } = executeLabImport(plan);

    expect(document.topology.links).toHaveLength(0);
    expect(plan.report.entries.some((entry) => entry.code === "packet-tracer-link-unmapped")).toBe(true);
  });

  it("applies a router running-config through the shared IOS parser", async () => {
    const xml = documentXml(
      device({
        name: "R1",
        engine: "Router",
        model: "1941",
        ports: 2,
        runningConfig: [
          "!",
          "hostname R1",
          "!",
          "interface GigabitEthernet0/0",
          " ip address 10.0.0.1 255.255.255.0",
          " no shutdown",
          "!",
        ],
      }, "1"),
      "",
    );
    const { plan } = await inspect(xml);
    const { document, report } = executeLabImport(plan);
    const r1 = document.topology.nodes.find((node) => node.name === "R1")!;
    const config = document.configurations[r1.id];

    expect(report.importedStartupConfigs).toBe(1);
    expect(config?.kind).toBe("router");
    // The address came from the existing parser, not from anything this
    // importer understands about IOS.
    //
    // This also guards a subtlety: Packet Tracer stores each config line in its
    // own <LINE> element, and the IOS parser uses a line's indentation to tell
    // a sub-command from a top-level one. If the XML reader trimmed that
    // whitespace away, every interface-level line would silently become
    // unparsed and the device would import with no addressing at all.
    expect(config).toMatchObject({
      interfaces: expect.arrayContaining([
        expect.objectContaining({ id: "Gi0/0", ipv4: { address: "10.0.0.1", prefixLength: 24 } }),
      ]),
    });
    expect(report.entries.some((entry) => entry.code === "config-unparsed")).toBe(false);
  });

  it("carries a static host address across", async () => {
    const xml = documentXml(
      device({
        name: "PC1", engine: "Pc", model: "PC-PT",
        ip: "192.168.5.10", subnet: "255.255.255.0", gateway: "192.168.5.1",
      }, "1"),
      "",
    );
    const { plan } = await inspect(xml);
    const { document } = executeLabImport(plan);
    const pc = document.topology.nodes.find((node) => node.name === "PC1")!;

    expect(document.configurations[pc.id]).toMatchObject({
      kind: "pc",
      ipv4: { address: "192.168.5.10", prefixLength: 24, defaultGateway: "192.168.5.1" },
    });
  });

  it("falls back to the standard layout when the source has no coordinates", async () => {
    const xml = `<PACKETTRACER5><VERSION>8.2.0.0400</VERSION><NETWORK><DEVICES>
      <DEVICE><ENGINE><TYPE customModel="" model="PC-PT">Pc</TYPE><NAME>PC1</NAME>
      <SAVE_REF_ID>save-ref-id:1</SAVE_REF_ID></ENGINE></DEVICE>
    </DEVICES><LINKS/></NETWORK></PACKETTRACER5>`;
    const { plan } = await inspect(xml);
    expect(plan.report.entries.some((entry) => entry.code === "packet-tracer-no-coordinates")).toBe(true);
  });
});

describe("Packet Tracer activity (.pka) network selection", () => {
  const activity = (body: string): string =>
    `<PACKETTRACER5_ACTIVITY><VERSION>8.2.0.0400</VERSION><TITLE>Build a small LAN</TITLE>${body}</PACKETTRACER5_ACTIVITY>`;

  const oneDevice = (name: string): string =>
    `<PACKETTRACER5>${networkXml(device({ name, engine: "Pc", model: "PC-PT" }, "1"), "")}</PACKETTRACER5>`;

  const twoDevices = `<PACKETTRACER5>${networkXml(
    device({ name: "PC1", engine: "Pc", model: "PC-PT" }, "1")
    + device({ name: "SW1", engine: "Switch", model: "2960-24TT", ports: 26 }, "2"),
    cable("1", "FastEthernet0", "2", "FastEthernet0/1"),
  )}</PACKETTRACER5>`;

  it("discovers each contained network and its role", async () => {
    const xml = activity(
      `<INITIAL_NETWORK>${oneDevice("PC1")}</INITIAL_NETWORK><ANSWER_NETWORK>${twoDevices}</ANSWER_NETWORK>`,
    );
    const inspection = await inspect(xml, "activity.pka");

    expect(inspection.format).toBe("packet-tracer-pka");
    expect(inspection.activityTitle).toBe("Build a small LAN");
    expect(inspection.networks).toHaveLength(2);
    expect(inspection.networks.map((network) => network.role).sort()).toEqual(["answer", "initial"]);
    // Counts are shown so the user can tell the snapshots apart.
    const answer = inspection.networks.find((network) => network.role === "answer")!;
    expect(answer.deviceCount).toBe(2);
    expect(answer.linkCount).toBe(1);
  });

  it("never defaults to the answer network", async () => {
    const xml = activity(
      `<ANSWER_NETWORK>${twoDevices}</ANSWER_NETWORK><INITIAL_NETWORK>${oneDevice("PC1")}</INITIAL_NETWORK>`,
    );
    const inspection = await inspect(xml, "activity.pka");
    const selected = inspection.networks.find((network) => network.id === inspection.selectedNetworkId)!;

    expect(selected.role).toBe("initial");
    expect(inspection.requiresNetworkChoice).toBe(true);
    expect(inspection.selectionReason).toContain("initial");
  });

  it("imports the network the user chose", async () => {
    const xml = activity(
      `<INITIAL_NETWORK>${oneDevice("PC1")}</INITIAL_NETWORK><ANSWER_NETWORK>${twoDevices}</ANSWER_NETWORK>`,
    );
    const first = await inspect(xml, "activity.pka");
    const answerId = first.networks.find((network) => network.role === "answer")!.id;

    const chosen = await inspectPacketTracerFile(
      { filename: "activity.pka", bytes: await encodeModernContainer(xml) },
      { networkId: answerId },
    );
    const { document } = executeLabImport(chosen.plan);

    expect(chosen.selectedNetworkId).toBe(answerId);
    expect(document.topology.nodes).toHaveLength(2);
    expect(document.topology.links).toHaveLength(1);
    // The report records which snapshot the lab came from.
    expect(chosen.plan.report.entries.some((entry) => entry.code === "packet-tracer-network-selected")).toBe(true);
  });

  it("selects automatically when the activity holds a single network", async () => {
    const inspection = await inspect(activity(`<CURRENT_NETWORK>${oneDevice("PC1")}</CURRENT_NETWORK>`), "activity.pka");
    expect(inspection.requiresNetworkChoice).toBe(false);
    expect(inspection.networks).toHaveLength(1);
  });

  it("offers an unrecognised role by position rather than guessing", async () => {
    const xml = activity(`<SOME_FUTURE_WRAPPER>${oneDevice("PC1")}</SOME_FUTURE_WRAPPER>`);
    const inspection = await inspect(xml, "activity.pka");
    expect(inspection.networks[0]?.role).toBe("unknown");
  });
});
