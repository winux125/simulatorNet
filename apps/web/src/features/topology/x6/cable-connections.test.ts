import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, parseLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  createLink,
  toGraphLinks,
  toGraphNodes,
  validateConnection,
  validateDeviceConnection,
} from "./lab-document-adapter";
import { buildPorts, portsMatch } from "./port-registry";
import { PORT_ANCHOR_RADIUS, portBodyAttrs } from "./styles";

// M10.3.3c — devices show one cable handle and no port dots. Domain interfaces
// and X6 ports still exist internally so links keep exact endpoints.

const here = dirname(fileURLToPath(import.meta.url));
const topology = resolve(here, "..");
const webSrc = resolve(here, "../../../");

function read(relative: string): string {
  return readFileSync(join(topology, relative), "utf8");
}

/** Comments describe intent; assertions must only see real code. */
function code(relative: string): string {
  return read(relative).replaceAll(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}|(^|\s)\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const NODES: NodeSpec[] = [
  { id: "pc-1", kind: "pc", position: { x: 40, y: 40 }, interfaces: [{ id: "eth0" }] },
  { id: "pc-2", kind: "pc", position: { x: 40, y: 200 }, interfaces: [{ id: "eth0" }] },
  {
    id: "switch-1",
    kind: "l2-switch",
    position: { x: 320, y: 120 },
    interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }, { id: "Gi0/3" }],
  },
];

function doc(links: LabDocument["topology"]["links"] = []): LabDocument {
  return {
    schemaVersion: 1,
    id: "cable-only",
    title: "Cable only",
    description: "",
    simulation: { seed: 5 },
    topology: { schemaVersion: 1, nodes: NODES, links },
    configurations: {},
  };
}

describe("M10.3.3c invisible interface ports", () => {
  it("1. paints no port marker at all", () => {
    for (const occupied of [false, true]) {
      for (const up of [false, true]) {
        expect(portBodyAttrs(occupied, up)).toMatchObject({
          opacity: 0,
          fill: "none",
          stroke: "none",
          strokeWidth: 0,
        });
      }
    }
  });

  it("2. leaves no port magnet for a user drag", () => {
    expect(portBodyAttrs(false, false)).toMatchObject({ magnet: false, pointerEvents: "none", cursor: "default" });
    expect(portBodyAttrs(true, true).magnet).toBe(false);
  });

  it("3. keeps stable anchor geometry for every interface", () => {
    const [pc, , sw] = toGraphNodes(doc());
    expect(buildPorts(pc!).items.map((port) => port.id)).toEqual(["eth0"]);
    expect(buildPorts(sw!).items.map((port) => port.id)).toEqual(["Gi0/1", "Gi0/2", "Gi0/3"]);
    for (const port of buildPorts(sw!).items) {
      expect(port.attrs.circle).toMatchObject({ r: PORT_ANCHOR_RADIUS, "data-interface": port.id });
    }
    expect(portsMatch(buildPorts(sw!).items.map((port) => port.id), ["Gi0/1", "Gi0/2", "Gi0/3"])).toBe(true);
  });

  it("4. is never hidden with display:none, in any mode or icon profile", () => {
    const css = readFileSync(join(webSrc, "styles/app.css"), "utf8");
    expect(css).not.toMatch(/\.x6-port[^{]*\{[^}]*display:\s*none/);
    expect(css).not.toContain(".x6-port-body:hover");
    expect(css).not.toMatch(/data-occupied="true"\]\s*\{[^}]*opacity/);
    // Nothing profile-specific may re-introduce visible ports.
    expect(css).not.toMatch(/data-profile="(classic|education|minimal)"[^{]*\{[^}]*x6-port/);
  });

  it("5. configures invisibility centrally, not through brittle global selectors", () => {
    // The port registry and its style token own the invisible markup.
    expect(read("x6/port-registry.ts")).toContain("portBodyAttrs");
    const offenders = walk(webSrc)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /x6-port/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("M10.3.3c cable-only connection workflow", () => {
  it("6. accepts a drag only from the device cable handle", () => {
    const graph = code("x6/create-graph.ts");
    expect(graph).toContain('magnet.getAttribute("data-connection-handle") === "true"');
    expect(graph).not.toContain('magnet.getAttribute("port")');
    expect(graph).not.toContain("data-occupied");
  });

  it("7. draws no magnet highlight, only a whole-device target highlight", () => {
    const graph = code("x6/create-graph.ts");
    expect(graph).toContain("nodeAvailable");
    expect(graph).not.toContain("magnetAvailable");
    expect(graph).not.toContain("magnetAdsorbed");
  });

  it("8. renders exactly one cable handle per device", () => {
    const node = read("DeviceNode.tsx");
    expect([...node.matchAll(/data-connection-handle="true"/g)]).toHaveLength(1);
    expect(node).toContain('className="device-node__connect"');
    expect(node).toContain("aria-label={`Connect ${data.hostname} to another device`}");
    expect(node).toContain('title="Connect"');
    expect(node).toContain("{data.connectable && (");
  });

  it("9. hides the cable handle for pan, drawing, inline editing and a locked lab", () => {
    const canvas = code("TopologyCanvas.tsx");
    expect(canvas).toContain("const cableHandleAvailable = structuralEditable");
    expect(canvas).toContain('props.activeTool === "select" || props.activeTool === "add-link"');
    expect(canvas).toContain("textEditing === undefined");
    expect(canvas).toContain("resolveDeviceInterfaceTemplates(node.kind, node.hardwareProfileId)");
    expect(canvas).toContain('template.media !== "wireless"');
  });

  it("10. still exposes Connect through the context menu and the toolbar", () => {
    const canvas = read("TopologyCanvas.tsx");
    expect(canvas).toContain('contextAction("connect")');
    expect(canvas).toContain('onClick={() => props.onActiveTool("add-link")}');
    const toolbar = readFileSync(join(webSrc, "components/Toolbar.tsx"), "utf8");
    expect(toolbar).toContain('label="Add link"');
  });

  it("11. has no Show connection points or advanced port-drag preference", () => {
    const sources = walk(webSrc)
      .filter((file) => /\.(ts|tsx|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    expect(sources).not.toMatch(/Show connection points|Show port handles|Advanced port drag|showPortHandles/i);
    // Port Labels stays: it names interfaces, it is not a connection point.
    expect(sources).toContain("Port Labels");
  });
});

describe("M10.3.3c domain identity behind the invisible ports", () => {
  it("12. keeps exact source and target interface IDs on a created link", () => {
    const { document, link } = createLink(doc(), "pc-1", "eth0", "switch-1", "Gi0/1");
    expect(link).toEqual({
      id: "link-1",
      a: { node: "pc-1", iface: "eth0" },
      b: { node: "switch-1", iface: "Gi0/1" },
    });
    expect(toGraphLinks(document)[0]).toMatchObject({
      source: "pc-1",
      sourcePort: "eth0",
      target: "switch-1",
      targetPort: "Gi0/1",
    });
  });

  it("13. marks used interfaces as occupied without offering them again", () => {
    const wired = doc([{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }]);
    const [pc, , sw] = toGraphNodes(wired);
    expect(pc!.occupiedInterfaces).toEqual(["eth0"]);
    expect(sw!.occupiedInterfaces).toEqual(["Gi0/1"]);
    expect(buildPorts(sw!).items.find((port) => port.id === "Gi0/1")?.attrs.circle)
      .toMatchObject({ "data-occupied": "true", opacity: 0 });
    // A fully wired device cannot start another connection.
    expect(validateDeviceConnection(wired, "pc-1", "pc-2")).toMatchObject({ ok: false, code: "SOURCE_OCCUPIED" });
    expect(validateDeviceConnection(wired, "pc-2", "switch-1")).toEqual({ ok: true });
  });

  it("14. blocks the cable workflow while the topology is locked", () => {
    expect(validateDeviceConnection(doc(), "pc-1", "switch-1", { locked: true }))
      .toMatchObject({ ok: false, code: "TOPOLOGY_LOCKED" });
  });

  it("15. preserves interface IDs and anchors through a canonical round trip", () => {
    const { document } = createLink(doc(), "pc-2", "eth0", "switch-1", "Gi0/3");
    const restored = parseLabDocument(stringifyLabDocument(canonicalizeLabDocument(document)));
    expect(restored.topology.links).toEqual([
      { id: "link-1", a: { node: "pc-2", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/3" } },
    ]);
    expect(toGraphLinks(restored)[0]).toMatchObject({ sourcePort: "eth0", targetPort: "Gi0/3" });
    // Imported topologies anchor to the same invisible ports.
    const [, , sw] = toGraphNodes(restored);
    expect(buildPorts(sw!).items.map((port) => port.id)).toEqual(["Gi0/1", "Gi0/2", "Gi0/3"]);
  });

  it("16. keeps a typed direct-connection operation for tests and imports only", () => {
    // Available as a domain action…
    const { document } = createLink(doc(), "pc-1", "eth0", "switch-1", "Gi0/2");
    expect(document.topology.links).toHaveLength(1);
    // …but never surfaced as a visual port-to-port drag.
    expect(code("x6/create-graph.ts")).not.toMatch(/sourceMagnet\?\.getAttribute\("port"\)[^\n]*validateMagnet/);
    expect(read("x6/graph-controller.ts")).toContain("createDraftLink");
  });
});

describe("M10.6 wireless interfaces stay out of the cable workflow", () => {
  const wirelessDocument: LabDocument = {
    schemaVersion: 1,
    id: "wireless-cables",
    title: "Wireless cable filtering",
    simulation: { seed: 106 },
    topology: {
      schemaVersion: 1,
      nodes: [
        {
          id: "laptop",
          kind: "laptop",
          interfaces: [{ id: "wlan0" }, { id: "eth0" }],
        },
        {
          id: "phone",
          kind: "smartphone",
          interfaces: [{ id: "wlan0" }],
        },
        { id: "pc", kind: "pc", interfaces: [{ id: "eth0" }] },
      ],
      links: [],
    },
    configurations: {},
  };

  it("keeps wlan0 as domain identity but exposes only Ethernet anchors", () => {
    expect(toGraphNodes(wirelessDocument).find((node) => node.id === "laptop")?.interfaces)
      .toEqual(["eth0"]);
    expect(toGraphNodes(wirelessDocument).find((node) => node.id === "phone")?.interfaces)
      .toEqual([]);
    expect(validateDeviceConnection(wirelessDocument, "phone", "pc")).toMatchObject({
      ok: false,
      code: "SOURCE_OCCUPIED",
    });
    expect(validateConnection(
      wirelessDocument,
      "laptop",
      "wlan0",
      "pc",
      "eth0",
    )).toMatchObject({
      ok: false,
      code: "SOURCE_WIRELESS_INTERFACE",
    });
  });
});
