import type { Point } from "./types";

export type AdaptiveAnchorSide = "top" | "right" | "bottom" | "left";

export interface AdaptiveNodeRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AdaptiveEndpointAnchor {
  side: AdaptiveAnchorSide;
  /** Absolute graph-space point on the node boundary. */
  point: Point;
  /** Absolute position measured from the top/left end of the chosen side. */
  position: number;
  /** Signed displacement from the center of the chosen side. */
  offsetAlongSide: number;
  /** Direction in which the endpoint label is placed outside the node. */
  labelDirection: AdaptiveAnchorSide;
  /** Stable symmetric displacement used to separate parallel physical links. */
  parallelLinkOffset: number;
}

export interface AdaptiveLinkAnchors {
  linkId: string;
  source: AdaptiveEndpointAnchor;
  target: AdaptiveEndpointAnchor;
  parallelCount: number;
  parallelIndex: number;
}

export interface AdaptiveLinkAnchorInput {
  sourceRectangle: AdaptiveNodeRectangle;
  targetRectangle: AdaptiveNodeRectangle;
  sourceCenter: Point;
  targetCenter: Point;
  linkId: string;
  parallelCount: number;
  parallelIndex: number;
  previous?: Pick<AdaptiveLinkAnchors, "source" | "target">;
}

export interface AdaptiveLinkIdentity {
  id: string;
  sourceDeviceId: string;
  targetDeviceId: string;
}

export interface AdaptiveParallelPlacement {
  parallelCount: number;
  parallelIndex: number;
}

export interface AdaptiveLinkLayoutIndex {
  incidentLinkIds: ReadonlyMap<string, ReadonlySet<string>>;
  parallelPlacement: ReadonlyMap<string, AdaptiveParallelPlacement>;
}

/** Axis changes need to exceed this band before an existing side is replaced. */
export const ADAPTIVE_ANCHOR_HYSTERESIS_PX = 12;
export const ADAPTIVE_PARALLEL_SPACING_PX = 14;
const ANCHOR_CORNER_PADDING_PX = 14;

function axisOf(side: AdaptiveAnchorSide): "horizontal" | "vertical" {
  return side === "left" || side === "right" ? "horizontal" : "vertical";
}

function opposite(side: AdaptiveAnchorSide): AdaptiveAnchorSide {
  if (side === "left") return "right";
  if (side === "right") return "left";
  if (side === "top") return "bottom";
  return "top";
}

function overlapSide(linkId: string): AdaptiveAnchorSide {
  let hash = 0;
  for (const character of linkId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return (["right", "bottom", "left", "top"] as const)[hash % 4]!;
}

export function chooseAdaptiveAnchorSide(
  sourceCenter: Point,
  targetCenter: Point,
  linkId: string,
  previous?: AdaptiveAnchorSide,
): AdaptiveAnchorSide {
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  if (absX === 0 && absY === 0) return previous ?? overlapSide(linkId);

  const dominance = absX - absY;
  let horizontal = dominance >= 0;
  if (previous) {
    horizontal = axisOf(previous) === "horizontal"
      ? dominance >= -ADAPTIVE_ANCHOR_HYSTERESIS_PX
      : dominance > ADAPTIVE_ANCHOR_HYSTERESIS_PX;
  }
  if (horizontal) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function sideLength(rectangle: AdaptiveNodeRectangle, side: AdaptiveAnchorSide): number {
  return side === "left" || side === "right" ? rectangle.height : rectangle.width;
}

function boundaryPoint(
  rectangle: AdaptiveNodeRectangle,
  side: AdaptiveAnchorSide,
  offsetAlongSide: number,
): { point: Point; position: number } {
  const length = sideLength(rectangle, side);
  const position = Math.max(0, Math.min(length, length / 2 + offsetAlongSide));
  if (side === "left") return { point: { x: rectangle.x, y: rectangle.y + position }, position };
  if (side === "right") {
    return { point: { x: rectangle.x + rectangle.width, y: rectangle.y + position }, position };
  }
  if (side === "top") return { point: { x: rectangle.x + position, y: rectangle.y }, position };
  return { point: { x: rectangle.x + position, y: rectangle.y + rectangle.height }, position };
}

function parallelOffset(
  sourceRectangle: AdaptiveNodeRectangle,
  targetRectangle: AdaptiveNodeRectangle,
  sourceSide: AdaptiveAnchorSide,
  targetSide: AdaptiveAnchorSide,
  count: number,
  index: number,
): number {
  if (count <= 1) return 0;
  const available = Math.max(0, Math.min(
    sideLength(sourceRectangle, sourceSide) / 2 - ANCHOR_CORNER_PADDING_PX,
    sideLength(targetRectangle, targetSide) / 2 - ANCHOR_CORNER_PADDING_PX,
  ));
  const spacing = Math.min(ADAPTIVE_PARALLEL_SPACING_PX, available * 2 / (count - 1));
  return (Math.max(0, Math.min(count - 1, index)) - (count - 1) / 2) * spacing;
}

export function calculateAdaptiveLinkAnchors(input: AdaptiveLinkAnchorInput): AdaptiveLinkAnchors {
  const sourceSide = chooseAdaptiveAnchorSide(
    input.sourceCenter,
    input.targetCenter,
    input.linkId,
    input.previous?.source.side,
  );
  const targetSide = opposite(sourceSide);
  const count = Math.max(1, Math.trunc(input.parallelCount));
  const index = Math.max(0, Math.min(count - 1, Math.trunc(input.parallelIndex)));
  const offset = parallelOffset(
    input.sourceRectangle,
    input.targetRectangle,
    sourceSide,
    targetSide,
    count,
    index,
  );
  const source = boundaryPoint(input.sourceRectangle, sourceSide, offset);
  const target = boundaryPoint(input.targetRectangle, targetSide, offset);
  return {
    linkId: input.linkId,
    source: {
      side: sourceSide,
      ...source,
      offsetAlongSide: offset,
      labelDirection: sourceSide,
      parallelLinkOffset: offset,
    },
    target: {
      side: targetSide,
      ...target,
      offsetAlongSide: offset,
      labelDirection: targetSide,
      parallelLinkOffset: offset,
    },
    parallelCount: count,
    parallelIndex: index,
  };
}

function devicePairKey(sourceDeviceId: string, targetDeviceId: string): string {
  return sourceDeviceId < targetDeviceId
    ? `${sourceDeviceId}\u0000${targetDeviceId}`
    : `${targetDeviceId}\u0000${sourceDeviceId}`;
}

/** O(links) index used by the controller to refresh only incident edges. */
export function indexAdaptiveLinkLayout(links: readonly AdaptiveLinkIdentity[]): AdaptiveLinkLayoutIndex {
  const incident = new Map<string, Set<string>>();
  const parallelGroups = new Map<string, AdaptiveLinkIdentity[]>();
  for (const link of links) {
    for (const deviceId of new Set([link.sourceDeviceId, link.targetDeviceId])) {
      const ids = incident.get(deviceId) ?? new Set<string>();
      ids.add(link.id);
      incident.set(deviceId, ids);
    }
    const key = devicePairKey(link.sourceDeviceId, link.targetDeviceId);
    const group = parallelGroups.get(key) ?? [];
    group.push(link);
    parallelGroups.set(key, group);
  }

  const placement = new Map<string, AdaptiveParallelPlacement>();
  for (const group of parallelGroups.values()) {
    group.sort((left, right) => left.id.localeCompare(right.id));
    group.forEach((link, parallelIndex) => {
      placement.set(link.id, { parallelCount: group.length, parallelIndex });
    });
  }
  return { incidentLinkIds: incident, parallelPlacement: placement };
}
