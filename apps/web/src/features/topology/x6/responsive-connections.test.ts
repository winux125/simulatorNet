import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Edge } from "@antv/x6";
import type { LabDocument, NodeSpec } from "@sim/contracts";
import { canonicalizeLabDocument, parseLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it, vi } from "vitest";
import { calculateAdaptiveLinkAnchors } from "./adaptive-link-anchor";
import {
  withDiagramLinkLabel,
  withDiagramLinkStyle,
  withNodePosition,
} from "../../lab/document";
import { domainLinkEdgeData, updateLinkEdge } from "./edge-registry";
import {
  createLink,
  toGraphLinks,
  validateConnection,
} from "./lab-document-adapter";
import { edgeLabelAttrs } from "./styles";
import type { GraphLinkModel, LinkView } from "./types";

const here = dirname(fileURLToPath(import.meta.url));

function documentFixture(
  nodes: NodeSpec[] = [
    { id: "pc-1", kind: "pc", position: { x: 80, y: 100 }, interfaces: [{ id: "eth0" }] },
    {
      id: "switch-1",
      kind: "l2-switch",
      position: { x: 360, y: 100 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
    },
    { id: "pc-2", kind: "pc", position: { x: 640, y: 100 }, interfaces: [{ id: "eth0" }] },
  ],
  links: LabDocument["topology"]["links"] = [
    { id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "switch-1", iface: "Gi0/1" } },
  ],
): LabDocument {
  return {
    schemaVersion: 1,
    id: "responsive-links",
    title: "Responsive links",
    description: "",
    simulation: { seed: 32 },
    topology: { schemaVersion: 1, nodes, links },
    configurations: {},
  };
}

function edgeDouble() {
  return {
    setSource: vi.fn(),
    setTarget: vi.fn(),
    setData: vi.fn(),
    setAttrs: vi.fn(),
    setLabels: vi.fn(),
    setVertices: vi.fn(),
    setRouter: vi.fn(),
    setConnector: vi.fn(),
    setZIndex: vi.fn(),
  };
}

const LINK_VIEW: LinkView = {
  operational: true,
  selected: false,
  sourceLabel: "eth0",
  targetLabel: "Gi0/1",
};

describe("M10.3.2b responsive topology connections", () => {
  it("1. anchors a link to exact source and target ports", () => {
    const [link] = toGraphLinks(documentFixture());
    const edge = edgeDouble();
    updateLinkEdge(edge as unknown as Edge, link!, LINK_VIEW);
    expect(edge.setSource).toHaveBeenLastCalledWith({ cell: "pc-1", port: "eth0" });
    expect(edge.setTarget).toHaveBeenLastCalledWith({ cell: "switch-1", port: "Gi0/1" });
    expect(edge.setData).toHaveBeenLastCalledWith({
      kind: "topology-link",
      linkId: "link-1",
      sourceDeviceId: "pc-1",
      sourceInterfaceId: "eth0",
      targetDeviceId: "switch-1",
      targetInterfaceId: "Gi0/1",
    }, { overwrite: true });
  });

  it("2. preserves the source port identity after moving the source node", () => {
    const moved = withNodePosition(documentFixture(), "pc-1", { x: 220, y: 280 });
    expect(toGraphLinks(moved)[0]).toMatchObject({ source: "pc-1", sourcePort: "eth0" });
    expect(moved.topology.nodes.find((node) => node.id === "pc-1")?.position).toEqual({ x: 220, y: 280 });
  });

  it("3. preserves the target port identity after moving the target node", () => {
    const moved = withNodePosition(documentFixture(), "switch-1", { x: 470, y: 320 });
    expect(toGraphLinks(moved)[0]).toMatchObject({ target: "switch-1", targetPort: "Gi0/1" });
    expect(moved.topology.links).toEqual(documentFixture().topology.links);
  });

  it("4. re-anchors the existing edge model instead of allocating a replacement", () => {
    const edge = edgeDouble();
    const link = toGraphLinks(documentFixture())[0]!;
    updateLinkEdge(edge as unknown as Edge, link, LINK_VIEW);
    updateLinkEdge(edge as unknown as Edge, link, LINK_VIEW);
    expect(edge.setSource).toHaveBeenCalledTimes(2);
    expect(edge.setTarget).toHaveBeenCalledTimes(2);
    expect(edge.setZIndex).toHaveBeenLastCalledWith(100);
  });

  it("5. observes canvas dimensions used by Inspector and responsive layout changes", () => {
    const surface = readFileSync(join(here, "../TopologyGraphSurface.tsx"), "utf8");
    expect(surface).toContain("new ResizeObserver");
    expect(surface).toContain("controller.resize(entry.contentRect.width, entry.contentRect.height)");
    expect(surface).toContain("resizeObserver?.disconnect()");
  });

  it("6. resizes and re-anchors without resetting pan, zoom, or fitting the graph", () => {
    const controller = readFileSync(join(here, "graph-controller.ts"), "utf8");
    const resize = controller.match(/resize\(width, height\) \{([\s\S]*?)\n    \},\n    reanchorLinks/)?.[1] ?? "";
    expect(resize).toContain("graph.resize(width, height)");
    expect(resize).toContain("scheduleAdaptiveRefresh()");
    expect(resize).not.toMatch(/zoomToFit|zoomTo\(|centerContent|translate/);
  });

  it("7. keeps endpoint identity independent from the local icon profile", () => {
    const before = toGraphLinks(documentFixture());
    for (const _profile of ["classic", "education", "minimal"] as const) {
      expect(toGraphLinks(documentFixture())).toEqual(before);
    }
  });

  it("8. gives zoom-safe labels a bounded theme-aware presentation", () => {
    const attrs = edgeLabelAttrs("WAN 10.0.0.0/31", "diagram");
    expect(attrs.body.fill).toContain("var(--color-link-label-bg");
    expect(attrs.label.textWrap).toEqual({ width: 220, height: 30, ellipsis: true });
    expect(attrs.label.pointerEvents).toBe("none");
  });

  it("9. restores an imported link and presentation route from canonical data", () => {
    const routed = withDiagramLinkStyle(documentFixture(), "link-1", {
      route: "orthogonal",
      vertices: [{ x: 280, y: 160 }],
    });
    const imported = parseLabDocument(stringifyLabDocument(canonicalizeLabDocument(routed)));
    expect(toGraphLinks(imported)[0]).toMatchObject({
      id: "link-1",
      source: "pc-1",
      sourcePort: "eth0",
      target: "switch-1",
      targetPort: "Gi0/1",
      route: "orthogonal",
      vertices: [{ x: 280, y: 160 }],
    });
  });

  it("10. removes the device-first preview before opening or cancelling the port dialog", () => {
    const controller = readFileSync(join(here, "graph-controller.ts"), "utf8");
    const connected = controller.match(/onEdgeConnected: \(edge\) => \{([\s\S]*?)\n    \},\n    onEdgeClick/)?.[1] ?? "";
    expect(connected.indexOf("graph.removeEdge(edge)")).toBeGreaterThanOrEqual(0);
    expect(connected.indexOf("graph.removeEdge(edge)")).toBeLessThan(connected.indexOf("onConnectionIntent"));
  });

  it("11. rejects an invalid drop without mutating the domain document", () => {
    const before = documentFixture();
    const result = validateConnection(before, "pc-1", "eth0", "switch-1", "Gi0/2");
    expect(result).toMatchObject({ ok: false, code: "SOURCE_OCCUPIED" });
    expect(before.topology.links).toHaveLength(1);
    const controller = readFileSync(join(here, "graph-controller.ts"), "utf8");
    expect(controller).toContain("is-connection-invalid");
    expect(controller).toContain('window.addEventListener("pointerup"');
    expect(controller).toContain('window.removeEventListener("pointerup"');
  });

  it("12. creates a direct port-to-port link with immediate domain endpoint IDs", () => {
    const { document, link } = createLink(documentFixture(undefined, []), "pc-2", "eth0", "switch-1", "Gi0/2");
    expect(link).toEqual({
      id: "link-1",
      a: { node: "pc-2", iface: "eth0" },
      b: { node: "switch-1", iface: "Gi0/2" },
    });
    expect(domainLinkEdgeData(toGraphLinks(document)[0]!)).toMatchObject({
      sourceInterfaceId: "eth0",
      targetInterfaceId: "Gi0/2",
    });
  });

  it("13. produces exactly one edge model per domain link after repeated redraw projections", () => {
    const document = documentFixture();
    expect(toGraphLinks(document)).toHaveLength(document.topology.links.length);
    expect(toGraphLinks(document).map((link) => link.id)).toEqual(["link-1"]);
  });

  it("14. keeps graph ownership independent from terminal presentation changes", () => {
    const surface = readFileSync(join(here, "../TopologyGraphSurface.tsx"), "utf8");
    const controller = readFileSync(join(here, "graph-controller.ts"), "utf8");
    expect(`${surface}\n${controller}`).not.toMatch(/TerminalPresentationMode|floatingTerminal|terminalMode/);
  });

  it("15. permits label presentation edits while reconnect remains structurally gated", () => {
    const canvas = readFileSync(join(here, "../TopologyCanvas.tsx"), "utf8");
    expect(canvas).toContain('contextAction("label")');
    expect(canvas).toContain('disabled={!structuralEditable}');
    expect(canvas).toContain('action === "reconnect" && structuralEditable');
  });

  it("16. projects every edge in a 50-node topology", () => {
    const nodes: NodeSpec[] = Array.from({ length: 50 }, (_, index) => ({
      id: `switch-${index + 1}`,
      kind: "l2-switch",
      position: { x: index * 120, y: (index % 5) * 120 },
      interfaces: [{ id: "Gi0/1" }, { id: "Gi0/2" }],
    }));
    const links: LabDocument["topology"]["links"] = Array.from({ length: 49 }, (_, index) => ({
      id: `link-${index + 1}`,
      a: { node: `switch-${index + 1}`, iface: "Gi0/2" },
      b: { node: `switch-${index + 2}`, iface: "Gi0/1" },
    }));
    expect(toGraphLinks(documentFixture(nodes, links))).toHaveLength(49);
  });

  it("17. preserves long link labels while bounding their rendered text box", () => {
    const text = "Trunk VLAN 10,20 — campus distribution uplink with redundant presentation notes";
    const document = withDiagramLinkLabel(documentFixture(), "link-1", { text, position: 0.62, offset: -18 });
    expect(document.diagram?.linkLabels[0]).toMatchObject({ text, position: 0.62, offset: -18 });
    expect(edgeLabelAttrs(text, "diagram").label).toMatchObject({
      text,
      "data-full-text": text,
      textWrap: { width: 220, height: 30, ellipsis: true },
    });
  });

  it("18. retains source and target port label order across route changes", () => {
    const edge = edgeDouble();
    const link: GraphLinkModel = {
      ...toGraphLinks(documentFixture())[0]!,
      route: "orthogonal",
      vertices: [{ x: 280, y: 160 }],
    };
    const anchors = calculateAdaptiveLinkAnchors({
      sourceRectangle: { x: 80, y: 100, width: 112, height: 92 },
      targetRectangle: { x: 360, y: 100, width: 112, height: 92 },
      sourceCenter: { x: 136, y: 146 },
      targetCenter: { x: 416, y: 146 },
      linkId: link.id,
      parallelCount: 1,
      parallelIndex: 0,
    });
    updateLinkEdge(edge as unknown as Edge, link, LINK_VIEW, anchors);
    const rendered = edge.setLabels.mock.calls.at(-1)?.[0] as Array<{
      attrs: { label: { text: string } };
      position: { distance: number; offset: { x: number; y: number } };
    }>;
    expect(rendered.map((label) => label.attrs.label.text)).toEqual(["eth0", "Gi0/1"]);
    expect(rendered.map((label) => label.position.distance)).toEqual([18, -18]);
    expect(rendered.map((label) => label.position.offset)).toEqual([{ x: 8, y: 0 }, { x: -8, y: 0 }]);
  });

  it("19. batches movement refreshes through the incident-link index and cleans up the frame", () => {
    const controller = readFileSync(join(here, "graph-controller.ts"), "utf8");
    const flush = controller.match(/function flushAdaptiveRefresh\(\): void \{([\s\S]*?)\n  \}/)?.[1] ?? "";
    const schedule = controller.match(/function scheduleAdaptiveRefresh\(nodeId\?: string\): void \{([\s\S]*?)\n  \}/)?.[1] ?? "";
    const destroy = controller.match(/destroy\(\) \{([\s\S]*?)\n    \},/)?.[1] ?? "";
    expect(flush).toContain("state.linkLayout.incidentLinkIds.get(nodeId)");
    expect(flush).toContain("affectedNodes.add(link.source)");
    expect(flush).toContain("distributedPlacementsForNodes(affectedNodes)");
    expect(flush).toContain("refreshRenderedLink(linkId, placements)");
    expect(schedule).toContain("window.requestAnimationFrame(flushAdaptiveRefresh)");
    expect(destroy).toContain("window.cancelAnimationFrame(adaptiveRefreshFrame)");
  });
});
