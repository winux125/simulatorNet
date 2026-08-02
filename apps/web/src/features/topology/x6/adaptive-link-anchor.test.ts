import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_ANCHOR_HYSTERESIS_PX,
  calculateAdaptiveLinkAnchors,
  chooseAdaptiveAnchorSide,
  distributeAdaptiveIncidentAnchors,
  indexAdaptiveLinkLayout,
  type AdaptiveLinkAnchorInput,
  type AdaptiveNodeRectangle,
} from "./adaptive-link-anchor";

const SOURCE: AdaptiveNodeRectangle = { x: 0, y: 0, width: 112, height: 92 };

function center(rectangle: AdaptiveNodeRectangle) {
  return {
    x: rectangle.x + rectangle.width / 2,
    y: rectangle.y + rectangle.height / 2,
  };
}

function anchors(
  targetRectangle: AdaptiveNodeRectangle,
  overrides: Partial<AdaptiveLinkAnchorInput> = {},
) {
  return calculateAdaptiveLinkAnchors({
    sourceRectangle: SOURCE,
    targetRectangle,
    sourceCenter: center(SOURCE),
    targetCenter: center(targetRectangle),
    linkId: "link-1",
    parallelCount: 1,
    parallelIndex: 0,
    ...overrides,
  });
}

describe("adaptive device link anchors", () => {
  it("places source right and target left when the target is to the right", () => {
    const result = anchors({ x: 300, y: 0, width: 112, height: 92 });
    expect(result.source).toMatchObject({ side: "right", point: { x: 112, y: 46 } });
    expect(result.target).toMatchObject({ side: "left", point: { x: 300, y: 46 } });
  });

  it("places source left and target right when the target is to the left", () => {
    const result = anchors({ x: -300, y: 0, width: 112, height: 92 });
    expect(result.source).toMatchObject({ side: "left", point: { x: 0, y: 46 } });
    expect(result.target).toMatchObject({ side: "right", point: { x: -188, y: 46 } });
  });

  it.each([
    ["above", { x: 0, y: -200, width: 112, height: 92 }, "top", "bottom"],
    ["below", { x: 0, y: 200, width: 112, height: 92 }, "bottom", "top"],
  ] as const)("uses top/bottom boundaries when the target is %s", (_name, target, sourceSide, targetSide) => {
    const result = anchors(target);
    expect(result.source.side).toBe(sourceSide);
    expect(result.target.side).toBe(targetSide);
    expect(result.source.labelDirection).toBe(sourceSide);
    expect(result.target.labelDirection).toBe(targetSide);
  });

  it("holds the previous diagonal axis inside the hysteresis band", () => {
    const source = { x: 0, y: 0 };
    expect(chooseAdaptiveAnchorSide(
      source,
      { x: 100, y: 96 },
      "link-1",
      "bottom",
    )).toBe("bottom");
    expect(chooseAdaptiveAnchorSide(
      source,
      { x: 96, y: 100 },
      "link-1",
      "right",
    )).toBe("right");
  });

  it("changes the diagonal axis only after movement exceeds hysteresis", () => {
    const source = { x: 0, y: 0 };
    expect(chooseAdaptiveAnchorSide(
      source,
      { x: 100 + ADAPTIVE_ANCHOR_HYSTERESIS_PX + 1, y: 100 },
      "link-1",
      "bottom",
    )).toBe("right");
    expect(chooseAdaptiveAnchorSide(
      source,
      { x: 100, y: 100 + ADAPTIVE_ANCHOR_HYSTERESIS_PX + 1 },
      "link-1",
      "right",
    )).toBe("bottom");
  });

  it("keeps anchors on the node boundary and away from corners", () => {
    const result = anchors(
      { x: 300, y: 0, width: 112, height: 92 },
      { parallelCount: 8, parallelIndex: 0 },
    );
    expect(result.source.point.x).toBe(SOURCE.x + SOURCE.width);
    expect(result.source.position).toBeGreaterThanOrEqual(14);
    expect(result.source.position).toBeLessThanOrEqual(SOURCE.height - 14);
  });

  it("gives parallel links distinct symmetric offsets", () => {
    const target = { x: 300, y: 0, width: 112, height: 92 };
    const first = anchors(target, { linkId: "link-a", parallelCount: 2, parallelIndex: 0 });
    const second = anchors(target, { linkId: "link-b", parallelCount: 2, parallelIndex: 1 });
    expect(first.source.parallelLinkOffset).toBe(-7);
    expect(second.source.parallelLinkOffset).toBe(7);
    expect(first.target.parallelLinkOffset).toBe(-7);
    expect(second.target.parallelLinkOffset).toBe(7);
    expect(first.source.point.y).not.toBe(second.source.point.y);
  });

  it("orders parallel links by stable link ID regardless of input order", () => {
    const index = indexAdaptiveLinkLayout([
      { id: "link-20", sourceDeviceId: "sw-2", targetDeviceId: "sw-1" },
      { id: "link-10", sourceDeviceId: "sw-1", targetDeviceId: "sw-2" },
    ]);
    expect(index.parallelPlacement.get("link-10")).toEqual({ parallelCount: 2, parallelIndex: 0 });
    expect(index.parallelPlacement.get("link-20")).toEqual({ parallelCount: 2, parallelIndex: 1 });
  });

  it("recenters the surviving link after a parallel link is deleted", () => {
    const before = indexAdaptiveLinkLayout([
      { id: "link-1", sourceDeviceId: "sw-1", targetDeviceId: "sw-2" },
      { id: "link-2", sourceDeviceId: "sw-1", targetDeviceId: "sw-2" },
    ]);
    const after = indexAdaptiveLinkLayout([
      { id: "link-2", sourceDeviceId: "sw-1", targetDeviceId: "sw-2" },
    ]);
    expect(before.parallelPlacement.get("link-2")).toEqual({ parallelCount: 2, parallelIndex: 1 });
    expect(after.parallelPlacement.get("link-2")).toEqual({ parallelCount: 1, parallelIndex: 0 });
    expect(anchors(
      { x: 300, y: 0, width: 112, height: 92 },
      { ...after.parallelPlacement.get("link-2"), linkId: "link-2" },
    ).source.parallelLinkOffset).toBe(0);
  });

  it("indexes only incident links for a moved node", () => {
    const index = indexAdaptiveLinkLayout([
      { id: "link-1", sourceDeviceId: "pc-1", targetDeviceId: "sw-1" },
      { id: "link-2", sourceDeviceId: "sw-1", targetDeviceId: "pc-2" },
      { id: "link-3", sourceDeviceId: "r-1", targetDeviceId: "r-2" },
    ]);
    expect([...index.incidentLinkIds.get("pc-1") ?? []]).toEqual(["link-1"]);
    expect([...index.incidentLinkIds.get("sw-1") ?? []]).toEqual(["link-1", "link-2"]);
    expect(index.incidentLinkIds.get("pc-1")).not.toContain("link-3");
  });

  it("chooses a deterministic side for overlapping device centers", () => {
    expect(chooseAdaptiveAnchorSide(center(SOURCE), center(SOURCE), "link-overlap"))
      .toBe(chooseAdaptiveAnchorSide(center(SOURCE), center(SOURCE), "link-overlap"));
  });

  it("distributes twenty incident links to distinct anchors across one safe edge", () => {
    const placements = distributeAdaptiveIncidentAnchors(
      SOURCE,
      center(SOURCE),
      Array.from({ length: 20 }, (_, index) => ({
        linkId: `link-${String(index + 1).padStart(2, "0")}`,
        peerCenter: { x: 400, y: index * 20 },
      })),
    );
    const offsets = [...placements.values()].map((placement) => placement.offsetAlongSide);
    expect(new Set(offsets).size).toBe(20);
    expect([...placements.values()].every((placement) => placement.side === "right")).toBe(true);
    expect(Math.min(...offsets)).toBe(-32);
    expect(Math.max(...offsets)).toBe(32);
  });

  it("keeps dense ordering stable regardless of input order", () => {
    const incidents = [
      { linkId: "link-c", peerCenter: { x: 400, y: 300 } },
      { linkId: "link-a", peerCenter: { x: 400, y: 100 } },
      { linkId: "link-b", peerCenter: { x: 400, y: 200 } },
    ];
    const first = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), incidents);
    const second = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), [...incidents].reverse());
    expect([...first]).toEqual([...second]);
    expect(first.get("link-a")!.offsetAlongSide).toBeLessThan(first.get("link-b")!.offsetAlongSide);
    expect(first.get("link-b")!.offsetAlongSide).toBeLessThan(first.get("link-c")!.offsetAlongSide);
  });

  it("groups top, right, bottom and left incidents independently", () => {
    const placements = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), [
      { linkId: "top", peerCenter: { x: 56, y: -300 } },
      { linkId: "right", peerCenter: { x: 400, y: 46 } },
      { linkId: "bottom", peerCenter: { x: 56, y: 300 } },
      { linkId: "left", peerCenter: { x: -300, y: 46 } },
    ]);
    expect(Object.fromEntries([...placements].map(([id, placement]) => [id, placement.side]))).toEqual({
      top: "top",
      right: "right",
      bottom: "bottom",
      left: "left",
    });
    expect([...placements.values()].every((placement) => placement.offsetAlongSide === 0)).toBe(true);
  });

  it("uses link ID as the stable tie-break for parallel links to one peer", () => {
    const placements = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), [
      { linkId: "link-20", peerCenter: { x: 400, y: 46 } },
      { linkId: "link-10", peerCenter: { x: 400, y: 46 } },
    ]);
    expect(placements.get("link-10")?.incidentIndex).toBe(0);
    expect(placements.get("link-20")?.incidentIndex).toBe(1);
    expect(placements.get("link-10")?.offsetAlongSide).toBe(-7);
    expect(placements.get("link-20")?.offsetAlongSide).toBe(7);
  });

  it("recenters the remaining dense endpoint after a link is removed", () => {
    const before = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), [
      { linkId: "link-1", peerCenter: { x: 400, y: 46 } },
      { linkId: "link-2", peerCenter: { x: 400, y: 46 } },
    ]);
    const after = distributeAdaptiveIncidentAnchors(SOURCE, center(SOURCE), [
      { linkId: "link-2", peerCenter: { x: 400, y: 46 } },
    ]);
    expect(before.get("link-2")?.offsetAlongSide).toBe(7);
    expect(after.get("link-2")?.offsetAlongSide).toBe(0);
  });

  it("applies node-wide source and target offsets without changing link identity", () => {
    const result = anchors(
      { x: 300, y: 0, width: 112, height: 92 },
      {
        sourcePlacement: { side: "right", offsetAlongSide: -20, incidentCount: 20, incidentIndex: 3 },
        targetPlacement: { side: "left", offsetAlongSide: 12, incidentCount: 4, incidentIndex: 2 },
      },
    );
    expect(result.linkId).toBe("link-1");
    expect(result.source).toMatchObject({ side: "right", point: { x: 112, y: 26 } });
    expect(result.target).toMatchObject({ side: "left", point: { x: 300, y: 58 } });
  });
});
