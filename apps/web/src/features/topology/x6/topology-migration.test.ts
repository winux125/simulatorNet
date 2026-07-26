import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { LabDocument } from "@sim/contracts";
import { canonicalizeLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it, vi } from "vitest";
import { removeDraftDevice, withNodePosition } from "../../lab/document";
import { attachGraphEvents } from "./graph-events";
import { createLink, toGraphLinks, toGraphNodes, validateConnection, validateDeviceConnection } from "./lab-document-adapter";
import { buildPorts } from "./port-registry";
import { edgeLineAttrs, portBodyAttrs } from "./styles";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = resolve(here, "../../../"); // apps/web/src
const webRoot = resolve(here, "../../../../"); // apps/web
const repoRoot = resolve(here, "../../../../../../"); // repository root

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(webSrc).filter((file) => /\.(ts|tsx|css)$/.test(file));
}

// Product source only — test files legitimately contain the forbidden patterns
// inside their own assertions.
function productSourceFiles(): string[] {
  return sourceFiles().filter((file) => !/\.test\.(ts|tsx)$/.test(file));
}

const SEVEN: LabDocument["topology"]["nodes"] = [
  { id: "pc-1", kind: "pc", position: { x: 0, y: 0 }, interfaces: [{ id: "eth0" }] },
  { id: "server-1", kind: "server", position: { x: 10, y: 0 }, interfaces: [{ id: "eth0" }] },
  { id: "hub-1", kind: "hub", position: { x: 20, y: 0 }, interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] },
  { id: "bridge-1", kind: "bridge", position: { x: 30, y: 0 }, interfaces: [{ id: "Eth0/1" }, { id: "Eth0/2" }] },
  { id: "switch-1", kind: "l2-switch", position: { x: 40, y: 0 }, interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }] },
  { id: "l3-switch-1", kind: "l3-switch", position: { x: 50, y: 0 }, interfaces: [{ id: "Gi0/1" }] },
  { id: "router-1", kind: "router", position: { x: 60, y: 0 }, interfaces: [{ id: "Gi0/0" }] },
];

function doc(nodes = SEVEN, links: LabDocument["topology"]["links"] = []): LabDocument {
  return {
    schemaVersion: 1,
    id: "adapter-lab",
    title: "Adapter Lab",
    description: "",
    simulation: { seed: 1 },
    topology: { schemaVersion: 1, nodes, links },
    configurations: {},
  };
}

describe("M10.2.2a React Flow removal", () => {
  it("1. has no React Flow dependency in the web package", () => {
    const pkg = JSON.parse(readFileSync(join(webRoot, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies?.["@xyflow/react"]).toBeUndefined();
    expect(pkg.devDependencies?.["@xyflow/react"]).toBeUndefined();
    expect(pkg.dependencies?.["@antv/x6"]).toBeDefined();
  });

  it("2. has no React Flow imports in the web source", () => {
    const offenders = productSourceFiles().filter((file) => /@xyflow\/react|react-flow-renderer|from "reactflow"/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("3. has no React Flow attribution flag anywhere in the app", () => {
    const patterns = /VITE_HIDE_REACT_FLOW_ATTRIBUTION|hideAttribution|proOptions/;
    const offenders = [...productSourceFiles(), join(repoRoot, ".env.example")].filter((file) => patterns.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("M10.2.2a topology adapter", () => {
  it("4. converts all seven device types into graph nodes with stable IDs", () => {
    const nodes = toGraphNodes(doc());
    expect(nodes).toHaveLength(7);
    expect(nodes.map((node) => node.id)).toEqual(SEVEN.map((node) => node.id));
  });

  it("5. exposes every interface as a separate port", () => {
    const [, , hub] = toGraphNodes(doc());
    const ports = buildPorts(hub!);
    expect(ports.items.map((port) => port.id)).toEqual(["Eth0/1", "Eth0/2"]);
  });

  it("6. preserves the source and target interface IDs on links", () => {
    const links = [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }];
    const [graphLink] = toGraphLinks(doc(SEVEN, links));
    expect(graphLink).toMatchObject({ id: "link-1", source: "pc-1", sourcePort: "eth0", target: "switch-1", targetPort: "Gi0/1" });
  });

  it("7. updates the draft position when a node moves", () => {
    const moved = withNodePosition(doc(), "pc-1", { x: 240, y: 180 });
    expect(moved.topology.nodes.find((node) => node.id === "pc-1")?.position).toEqual({ x: 240, y: 180 });
  });

  it("8. creates a draft link on a valid connection", () => {
    const { document, link } = createLink(doc(), "pc-1", "eth0", "switch-1", "Gi0/1");
    expect(link.id).toBe("link-1");
    expect(document.topology.links).toHaveLength(1);
    expect(document.topology.links[0]).toMatchObject({ a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } });
  });

  it("9. rejects a connection to an already-occupied interface", () => {
    const links = [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }];
    const result = validateConnection(doc(SEVEN, links), "server-1", "eth0", "switch-1", "Gi0/1");
    expect(result).toEqual({ ok: false, code: "TARGET_OCCUPIED", message: expect.stringContaining("already connected") });
  });

  it("10. rejects a duplicate link between the same interfaces", () => {
    const links = [{ id: "link-1", a: { node: "hub-1", iface: "Eth0/1" }, b: { node: "bridge-1", iface: "Eth0/1" } }];
    // A second, distinct pair would be fine; the exact same pair is a duplicate.
    const result = validateConnection(doc(SEVEN, links), "hub-1", "Eth0/1", "bridge-1", "Eth0/1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["SOURCE_OCCUPIED", "TARGET_OCCUPIED", "DUPLICATE_LINK"]).toContain(result.code);
  });

  it("11. rejects a self-link on the same interface", () => {
    const result = validateConnection(doc(), "hub-1", "Eth0/1", "hub-1", "Eth0/1");
    expect(result).toEqual({ ok: false, code: "SELF_LINK", message: expect.any(String) });
  });

  it("12. removes related draft links when a node is deleted", () => {
    const links = [
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
      { id: "link-2", a: { node: "server-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/2" } },
    ];
    const pruned = removeDraftDevice(doc(SEVEN, links), "switch-1");
    expect(pruned.topology.nodes.some((node) => node.id === "switch-1")).toBe(false);
    expect(pruned.topology.links).toHaveLength(0);
  });

  it("13. exports through the canonical LabDocument, not an X6 JSON blob", () => {
    const links = [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }];
    const exported = stringifyLabDocument(canonicalizeLabDocument(doc(SEVEN, links)));
    const parsed = JSON.parse(exported);
    expect(parsed.topology.links[0].a).toEqual({ node: "pc-1", iface: "eth0" });
    expect(parsed.cells).toBeUndefined(); // X6's serialization uses a `cells` array.
  });

  it("14. restores positions, ports and links on import", () => {
    const links = [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }];
    const imported = doc(SEVEN, links);
    const [pc] = toGraphNodes(imported);
    expect(pc!.position).toEqual({ x: 0, y: 0 });
    expect(buildPorts(pc!).items.map((port) => port.id)).toEqual(["eth0"]);
    expect(toGraphLinks(imported)).toHaveLength(1);
  });

  it("15. removes every subscription when the controller detaches events", () => {
    const on = vi.fn();
    const off = vi.fn();
    const fakeGraph = { on, off, clientToLocal: (p: { x: number; y: number }) => p, zoom: () => 1 } as unknown as Parameters<typeof attachGraphEvents>[0];
    const detach = attachGraphEvents(fakeGraph, {
      onNodeMoved: vi.fn(), onNodeClick: vi.fn(), onNodeDoubleClick: vi.fn(), onEdgeConnected: vi.fn(), onEdgeClick: vi.fn(), onEdgeContextMenu: vi.fn(),
      onBlankClick: vi.fn(), onBlankContextMenu: vi.fn(), onScale: vi.fn(),
    });
    const subscribed = on.mock.calls.map((call) => call[0]);
    expect(subscribed.length).toBeGreaterThan(0);
    detach();
    expect(off.mock.calls.map((call) => call[0]).sort()).toEqual([...subscribed].sort());
  });

  it("16. drives canvas styles from theme-aware CSS variables", () => {
    expect(edgeLineAttrs(true, false).stroke).toContain("var(--color-topology-link");
    expect(edgeLineAttrs(false, true).stroke).toContain("var(--color-accent");
    // Ports are invisible anchors since M10.3.3c, so they carry no theme color.
    expect(portBodyAttrs(false, true)).toMatchObject({ fill: "none", stroke: "none", opacity: 0 });
  });

  it("17. validates a device drag before opening the interface dialog", () => {
    expect(validateDeviceConnection(doc(), "pc-1", "switch-1")).toEqual({ ok: true });
    expect(validateDeviceConnection(doc(), "pc-1", "pc-1")).toEqual({
      ok: false,
      code: "SELF_LINK",
      message: expect.any(String),
    });
    expect(validateDeviceConnection(doc(), "pc-1", "switch-1", { locked: true })).toEqual({
      ok: false,
      code: "TOPOLOGY_LOCKED",
      message: expect.any(String),
    });
    const links = [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } }];
    expect(validateDeviceConnection(doc(SEVEN, links), "pc-1", "server-1")).toEqual({
      ok: false,
      code: "SOURCE_OCCUPIED",
      message: expect.stringContaining("All interfaces"),
    });
  });

  it("18. preserves a device-first connection through canonical export", () => {
    const { document } = createLink(doc(), "pc-1", "eth0", "switch-1", "Gi0/1");
    const parsed = JSON.parse(stringifyLabDocument(canonicalizeLabDocument(document))) as LabDocument;
    expect(parsed.topology.links).toEqual([
      { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
    ]);
  });

  it("19. keeps sim-core out of the main thread (worker owns the engine)", () => {
    const mainThread = sourceFiles().filter((file) => file.endsWith(".ts") || file.endsWith(".tsx"))
      .filter((file) => !file.includes(`${join("src", "worker")}`));
    const offenders = mainThread.filter((file) => /from "@sim\/sim-core"/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
