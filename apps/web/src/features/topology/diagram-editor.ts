import type {
  DiagramAnnotation,
  DiagramPoint,
  LabDocument,
} from "@sim/contracts";
import {
  DiagramAnnotationSchema,
  DiagramAssetSchema,
  MAX_DIAGRAM_ASSETS,
  MAX_DIAGRAM_ASSET_TOTAL_BYTES,
  MAX_DIAGRAM_DOCUMENT_JSON_BYTES,
} from "@sim/contracts";
import type { WorkspaceTool } from "../../state/workspace-store";
import { addDiagramAnnotation, addDiagramImage, allocateId, updateDiagramAnnotation } from "../lab/document";

export const DIAGRAM_GRID_SIZE = 10;
export const DIAGRAM_MIN_SIZE = 12;
export const DIAGRAM_DEFAULT_SHAPE_SIZE = { width: 140, height: 80 };
export const DIAGRAM_CLIPBOARD_TYPE = "application/x-simulatornet-diagram";

/** Bounds shared by the rendered text annotation and its inline editor. */
export const TEXT_ANNOTATION_MIN_HEIGHT = 30;
export const TEXT_ANNOTATION_MAX_HEIGHT = 2_000;
export const TEXT_ANNOTATION_MIN_WIDTH = 60;
export const MAX_ANNOTATION_TEXT_LENGTH = 4_096;
export const MAX_LABEL_TEXT_LENGTH = 512;

export type TextDiagramAnnotation = Extract<DiagramAnnotation, { type: "text" }>;

/**
 * Rendered height of a text annotation. The canvas node and the inline editor
 * must agree exactly, so both call this instead of recomputing the formula.
 */
export function textAnnotationHeight(annotation: TextDiagramAnnotation, content = annotation.content): number {
  if (annotation.autoHeight === false) return annotation.height ?? 40;
  const lines = content.split("\n").length;
  return Math.min(
    TEXT_ANNOTATION_MAX_HEIGHT,
    Math.max(TEXT_ANNOTATION_MIN_HEIGHT, annotation.fontSize * Math.max(1.8, lines * 1.25)),
  );
}

/**
 * Diagram text is plain text only. Pasted content is taken from `text/plain`,
 * normalized to `\n` line endings, stripped of control characters, and bounded.
 * HTML markup, styles and embedded content never enter a LabDocument.
 */
export function normalizeDiagramText(value: string, limit = MAX_ANNOTATION_TEXT_LENGTH): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    // Control characters other than the newline we just normalized.
    .replaceAll(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, limit);
}

export interface DiagramModifiers {
  shift?: boolean;
  alt?: boolean;
  snap?: boolean;
}

export interface DiagramBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SmartGuideResult {
  dx: number;
  dy: number;
  guideX?: number;
  guideY?: number;
}

export type DiagramZOrder = "forward" | "backward" | "front" | "back";
export type DiagramAlignment = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DiagramDistribution = "horizontal" | "vertical";

function maximumZ(document: LabDocument): number {
  return Math.max(0, ...(document.diagram?.annotations.map((annotation) => annotation.zIndex) ?? []));
}

export function snapDiagramValue(value: number, enabled = true, gridSize = DIAGRAM_GRID_SIZE): number {
  return enabled ? Math.round(value / gridSize) * gridSize : value;
}

export function snapDiagramPoint(point: DiagramPoint, enabled = true): DiagramPoint {
  return {
    x: snapDiagramValue(point.x, enabled),
    y: snapDiagramValue(point.y, enabled),
  };
}

export function constrainLineEnd(start: DiagramPoint, end: DiagramPoint, shift = false): DiagramPoint {
  if (!shift) return end;
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  if (distance === 0) return end;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const increment = Math.PI / 4;
  const constrained = Math.round(angle / increment) * increment;
  return {
    x: start.x + Math.cos(constrained) * distance,
    y: start.y + Math.sin(constrained) * distance,
  };
}

export function rectangleFromDrag(
  start: DiagramPoint,
  end: DiagramPoint,
  modifiers: DiagramModifiers = {},
): DiagramBounds {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (modifiers.shift) {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  const clicked = Math.hypot(dx, dy) < 4;
  if (clicked) {
    const { width, height } = DIAGRAM_DEFAULT_SHAPE_SIZE;
    return {
      x: snapDiagramValue(start.x, modifiers.snap),
      y: snapDiagramValue(start.y, modifiers.snap),
      width,
      height: modifiers.shift ? width : height,
    };
  }
  const x1 = modifiers.alt ? start.x - dx : start.x;
  const y1 = modifiers.alt ? start.y - dy : start.y;
  const x2 = modifiers.alt ? start.x + dx : start.x + dx;
  const y2 = modifiers.alt ? start.y + dy : start.y + dy;
  const x = snapDiagramValue(Math.min(x1, x2), modifiers.snap);
  const y = snapDiagramValue(Math.min(y1, y2), modifiers.snap);
  const width = Math.max(DIAGRAM_MIN_SIZE, snapDiagramValue(Math.abs(x2 - x1), modifiers.snap));
  const height = Math.max(DIAGRAM_MIN_SIZE, snapDiagramValue(Math.abs(y2 - y1), modifiers.snap));
  return { x, y, width, height };
}

export function createDiagramAnnotation(
  document: LabDocument,
  tool: WorkspaceTool,
  start: DiagramPoint,
  end: DiagramPoint = start,
  modifiers: DiagramModifiers = {},
): DiagramAnnotation | undefined {
  const id = allocateId("annotation", document.diagram?.annotations.map((annotation) => annotation.id) ?? []);
  const zIndex = maximumZ(document) + 1;
  const origin = snapDiagramPoint(start, modifiers.snap);
  if (tool === "annotation-text") {
    return {
      id,
      type: "text",
      position: origin,
      width: 200,
      height: 40,
      autoHeight: true,
      content: "",
      fontSize: 16,
      bold: false,
      italic: false,
      alignment: "left",
      foreground: "auto",
      background: "transparent",
      border: "transparent",
      borderWidth: 0,
      opacity: 1,
      zIndex,
      rotation: 0,
      locked: false,
    };
  }
  if (tool === "annotation-line" || tool === "annotation-arrow") {
    const constrainedEnd = constrainLineEnd(start, end, modifiers.shift);
    const target = Math.hypot(constrainedEnd.x - start.x, constrainedEnd.y - start.y) < 4
      ? { x: start.x + 140, y: start.y }
      : constrainedEnd;
    return {
      id,
      type: tool === "annotation-line" ? "line" : "arrow",
      start: origin,
      end: snapDiagramPoint(target, modifiers.snap),
      stroke: "#4d7fa9",
      strokeWidth: 2,
      strokeDash: "solid",
      startMarker: "none",
      endMarker: tool === "annotation-arrow" ? "arrow" : "none",
      opacity: 1,
      zIndex,
      locked: false,
    };
  }
  if (tool === "annotation-rectangle" || tool === "annotation-ellipse") {
    const bounds = rectangleFromDrag(start, end, modifiers);
    const common = {
      id,
      position: { x: bounds.x, y: bounds.y },
      width: bounds.width,
      height: bounds.height,
      fill: "transparent" as const,
      stroke: "#4d7fa9" as const,
      strokeWidth: 2,
      strokeDash: "solid" as const,
      opacity: 1,
      zIndex,
      rotation: 0,
      locked: false,
    };
    return tool === "annotation-rectangle"
      ? { ...common, type: "rectangle", radius: 4 }
      : { ...common, type: "ellipse" };
  }
  return undefined;
}

export function annotationBounds(annotation: DiagramAnnotation): DiagramBounds {
  if (annotation.type === "line" || annotation.type === "arrow") {
    const points = annotation.bend ? [annotation.start, annotation.bend, annotation.end] : [annotation.start, annotation.end];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(DIAGRAM_MIN_SIZE, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(DIAGRAM_MIN_SIZE, Math.max(...ys) - Math.min(...ys)),
    };
  }
  return {
    x: annotation.position.x,
    y: annotation.position.y,
    width: annotation.width,
    height: annotation.type === "text" ? annotation.height ?? 40 : annotation.height,
  };
}

export function translateAnnotation(
  annotation: DiagramAnnotation,
  dx: number,
  dy: number,
  snap = false,
): DiagramAnnotation {
  if (annotation.locked) return annotation;
  if (annotation.type === "line" || annotation.type === "arrow") {
    const move = (point: DiagramPoint) => snapDiagramPoint({ x: point.x + dx, y: point.y + dy }, snap);
    return {
      ...annotation,
      start: move(annotation.start),
      end: move(annotation.end),
      bend: annotation.bend ? move(annotation.bend) : undefined,
    };
  }
  return {
    ...annotation,
    position: snapDiagramPoint({ x: annotation.position.x + dx, y: annotation.position.y + dy }, snap),
  };
}

export function resizeAnnotation(
  annotation: DiagramAnnotation,
  width: number,
  height: number,
  preserveAspect = false,
): DiagramAnnotation {
  if (annotation.locked || annotation.type === "line" || annotation.type === "arrow") return annotation;
  let nextWidth = Math.max(DIAGRAM_MIN_SIZE, width);
  let nextHeight = Math.max(DIAGRAM_MIN_SIZE, height);
  if (preserveAspect || (annotation.type === "image" && annotation.preserveAspectRatio)) {
    const currentHeight = annotation.height ?? 40;
    const ratio = annotation.width / currentHeight;
    if (Math.abs(nextWidth - annotation.width) >= Math.abs(nextHeight - currentHeight)) nextHeight = nextWidth / ratio;
    else nextWidth = nextHeight * ratio;
  }
  return { ...annotation, width: nextWidth, height: nextHeight };
}

export function rotateAnnotation(annotation: DiagramAnnotation, degrees: number): DiagramAnnotation {
  if (annotation.locked || annotation.type === "line" || annotation.type === "arrow") return annotation;
  const normalized = ((degrees % 360) + 360) % 360;
  return { ...annotation, rotation: normalized };
}

export function updateLineEndpoint(
  annotation: DiagramAnnotation,
  endpoint: "start" | "end" | "bend",
  point: DiagramPoint,
  shift = false,
): DiagramAnnotation {
  if (annotation.locked || (annotation.type !== "line" && annotation.type !== "arrow")) return annotation;
  if (endpoint === "start") return { ...annotation, start: constrainLineEnd(annotation.end, point, shift) };
  if (endpoint === "end") return { ...annotation, end: constrainLineEnd(annotation.start, point, shift) };
  return { ...annotation, bend: point };
}

export function replaceAnnotations(document: LabDocument, annotations: DiagramAnnotation[]): LabDocument {
  const ids = new Set(annotations.map((annotation) => annotation.id));
  const current = document.diagram ?? { assets: [], annotations: [], linkLabels: [], linkStyles: [] };
  return {
    ...document,
    diagram: {
      ...current,
      annotations: [
        ...current.annotations.filter((annotation) => !ids.has(annotation.id)),
        ...annotations,
      ],
    },
  };
}

export function moveAnnotations(
  document: LabDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
  snap = false,
): LabDocument {
  const selected = new Set(ids);
  return replaceAnnotations(document, (document.diagram?.annotations ?? [])
    .filter((annotation) => selected.has(annotation.id))
    .map((annotation) => translateAnnotation(annotation, dx, dy, snap)));
}

export function removeAnnotations(document: LabDocument, ids: readonly string[]): LabDocument {
  const removed = new Set(ids);
  const current = document.diagram;
  if (!current) return document;
  const annotations = current.annotations.filter((annotation) => !removed.has(annotation.id));
  const referencedAssets = new Set(annotations.flatMap((annotation) => annotation.type === "image" ? [annotation.assetId] : []));
  return {
    ...document,
    diagram: {
      ...current,
      annotations,
      assets: current.assets?.filter((asset) => referencedAssets.has(asset.id)),
    },
  };
}

export function duplicateAnnotations(document: LabDocument, ids: readonly string[]): {
  document: LabDocument;
  ids: string[];
} {
  let next = document;
  const created: string[] = [];
  for (const sourceId of ids) {
    const source = next.diagram?.annotations.find((annotation) => annotation.id === sourceId);
    if (!source) continue;
    const id = allocateId("annotation", next.diagram?.annotations.map((annotation) => annotation.id) ?? []);
    const copy = translateAnnotation({ ...source, id, zIndex: maximumZ(next) + 1, locked: false }, 20, 20);
    next = addDiagramAnnotation(next, copy);
    created.push(id);
  }
  return { document: next, ids: created };
}

export function changeAnnotationsZOrder(
  document: LabDocument,
  ids: readonly string[],
  direction: DiagramZOrder,
): LabDocument {
  const current = document.diagram?.annotations ?? [];
  const selected = new Set(ids);
  if (selected.size === 0) return document;
  const ordered = [...current].sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
  const moving = ordered.filter((annotation) => selected.has(annotation.id));
  const stationary = ordered.filter((annotation) => !selected.has(annotation.id));
  let result: DiagramAnnotation[];
  if (direction === "front") result = [...stationary, ...moving];
  else if (direction === "back") result = [...moving, ...stationary];
  else {
    result = [...ordered];
    if (direction === "forward") {
      for (let index = result.length - 2; index >= 0; index -= 1) {
        if (selected.has(result[index]!.id) && !selected.has(result[index + 1]!.id)) {
          [result[index], result[index + 1]] = [result[index + 1]!, result[index]!];
        }
      }
    } else {
      for (let index = 1; index < result.length; index += 1) {
        if (selected.has(result[index]!.id) && !selected.has(result[index - 1]!.id)) {
          [result[index], result[index - 1]] = [result[index - 1]!, result[index]!];
        }
      }
    }
  }
  return replaceAnnotations(document, result.map((annotation, index) => ({ ...annotation, zIndex: index })));
}

export function alignAnnotations(
  document: LabDocument,
  ids: readonly string[],
  alignment: DiagramAlignment,
): LabDocument {
  const selected = (document.diagram?.annotations ?? []).filter((annotation) => ids.includes(annotation.id) && !annotation.locked);
  if (selected.length < 2) return document;
  const bounds = selected.map(annotationBounds);
  const outer = {
    left: Math.min(...bounds.map((box) => box.x)),
    top: Math.min(...bounds.map((box) => box.y)),
    right: Math.max(...bounds.map((box) => box.x + box.width)),
    bottom: Math.max(...bounds.map((box) => box.y + box.height)),
  };
  const moved = selected.map((annotation) => {
    const box = annotationBounds(annotation);
    let dx = 0;
    let dy = 0;
    if (alignment === "left") dx = outer.left - box.x;
    if (alignment === "center") dx = (outer.left + outer.right - box.width) / 2 - box.x;
    if (alignment === "right") dx = outer.right - box.width - box.x;
    if (alignment === "top") dy = outer.top - box.y;
    if (alignment === "middle") dy = (outer.top + outer.bottom - box.height) / 2 - box.y;
    if (alignment === "bottom") dy = outer.bottom - box.height - box.y;
    return translateAnnotation(annotation, dx, dy);
  });
  return replaceAnnotations(document, moved);
}

export function distributeAnnotations(
  document: LabDocument,
  ids: readonly string[],
  axis: DiagramDistribution,
): LabDocument {
  const selected = (document.diagram?.annotations ?? [])
    .filter((annotation) => ids.includes(annotation.id) && !annotation.locked)
    .sort((a, b) => {
      const aa = annotationBounds(a);
      const bb = annotationBounds(b);
      return axis === "horizontal" ? aa.x - bb.x : aa.y - bb.y;
    });
  if (selected.length < 3) return document;
  const first = annotationBounds(selected[0]!);
  const last = annotationBounds(selected.at(-1)!);
  const start = axis === "horizontal" ? first.x : first.y;
  const end = axis === "horizontal" ? last.x : last.y;
  const step = (end - start) / (selected.length - 1);
  return replaceAnnotations(document, selected.map((annotation, index) => {
    if (index === 0 || index === selected.length - 1) return annotation;
    const box = annotationBounds(annotation);
    return translateAnnotation(
      annotation,
      axis === "horizontal" ? start + step * index - box.x : 0,
      axis === "vertical" ? start + step * index - box.y : 0,
    );
  }));
}

export function annotationsInsideBounds(document: LabDocument, marquee: DiagramBounds): string[] {
  return (document.diagram?.annotations ?? [])
    .filter((annotation) => {
      const box = annotationBounds(annotation);
      return box.x >= marquee.x && box.y >= marquee.y
        && box.x + box.width <= marquee.x + marquee.width
        && box.y + box.height <= marquee.y + marquee.height;
    })
    .map((annotation) => annotation.id);
}

export function snapTranslationToSmartGuides(
  document: LabDocument,
  movingIds: readonly string[],
  dx: number,
  dy: number,
  enabled = true,
  tolerance = 6,
): SmartGuideResult {
  if (!enabled) return { dx, dy };
  const movingSet = new Set(movingIds);
  const moving = (document.diagram?.annotations ?? []).filter((annotation) => movingSet.has(annotation.id));
  const stationary = (document.diagram?.annotations ?? []).filter((annotation) => !movingSet.has(annotation.id));
  if (moving.length === 0 || stationary.length === 0) return { dx, dy };
  const movingBoxes = moving.map(annotationBounds);
  const movingBounds = {
    x: Math.min(...movingBoxes.map((box) => box.x)),
    y: Math.min(...movingBoxes.map((box) => box.y)),
    right: Math.max(...movingBoxes.map((box) => box.x + box.width)),
    bottom: Math.max(...movingBoxes.map((box) => box.y + box.height)),
  };
  const movingX = [movingBounds.x + dx, (movingBounds.x + movingBounds.right) / 2 + dx, movingBounds.right + dx];
  const movingY = [movingBounds.y + dy, (movingBounds.y + movingBounds.bottom) / 2 + dy, movingBounds.bottom + dy];
  const targetX = stationary.flatMap((annotation) => {
    const box = annotationBounds(annotation);
    return [box.x, box.x + box.width / 2, box.x + box.width];
  });
  const targetY = stationary.flatMap((annotation) => {
    const box = annotationBounds(annotation);
    return [box.y, box.y + box.height / 2, box.y + box.height];
  });
  let correctionX = 0;
  let correctionY = 0;
  let guideX: number | undefined;
  let guideY: number | undefined;
  let closestX = tolerance + 1;
  let closestY = tolerance + 1;
  for (const source of movingX) {
    for (const target of targetX) {
      const distance = Math.abs(target - source);
      if (distance <= tolerance && distance < closestX) {
        closestX = distance;
        correctionX = target - source;
        guideX = target;
      }
    }
  }
  for (const source of movingY) {
    for (const target of targetY) {
      const distance = Math.abs(target - source);
      if (distance <= tolerance && distance < closestY) {
        closestY = distance;
        correctionY = target - source;
        guideY = target;
      }
    }
  }
  return { dx: dx + correctionX, dy: dy + correctionY, guideX, guideY };
}

export function serializeDiagramClipboard(document: LabDocument, ids: readonly string[]): string {
  const selected = new Set(ids);
  const annotations = (document.diagram?.annotations ?? []).filter((annotation) => selected.has(annotation.id));
  const assetIds = new Set(annotations.flatMap((annotation) => annotation.type === "image" ? [annotation.assetId] : []));
  return JSON.stringify({
    version: 1,
    annotations,
    assets: (document.diagram?.assets ?? []).filter((asset) => assetIds.has(asset.id)),
  });
}

export function pasteDiagramClipboard(document: LabDocument, payload: string): {
  document: LabDocument;
  ids: string[];
} | undefined {
  try {
    if (new TextEncoder().encode(payload).byteLength > MAX_DIAGRAM_DOCUMENT_JSON_BYTES) return undefined;
    const parsed = JSON.parse(payload) as { version?: unknown; annotations?: unknown; assets?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.annotations)) return undefined;
    if (parsed.annotations.length > 100 || (parsed.assets !== undefined && !Array.isArray(parsed.assets))) return undefined;
    const parsedAssets = (parsed.assets ?? []).map((asset) => DiagramAssetSchema.safeParse(asset));
    if (parsedAssets.some((asset) => !asset.success)) return undefined;
    const assets = new Map(parsedAssets.flatMap((asset) => asset.success ? [[asset.data.id, asset.data] as const] : []));
    let next = document;
    const ids: string[] = [];
    for (const unsafe of parsed.annotations) {
      const result = DiagramAnnotationSchema.safeParse(unsafe);
      if (!result.success) return undefined;
      const validated = result.data;
      const id = allocateId("annotation", next.diagram?.annotations.map((annotation) => annotation.id) ?? []);
      const copy = translateAnnotation({ ...validated, id, zIndex: maximumZ(next) + 1, locked: false }, 20, 20);
      if (copy.type === "image") {
        const sourceAsset = assets.get(copy.assetId);
        if (!sourceAsset) return undefined;
        if ((next.diagram?.assets?.length ?? 0) >= MAX_DIAGRAM_ASSETS) return undefined;
        const retainedBytes = (next.diagram?.assets ?? []).reduce((sum, asset) =>
          sum + Math.floor(asset.dataBase64.length * 3 / 4), 0);
        const copiedBytes = Math.floor(sourceAsset.dataBase64.length * 3 / 4);
        if (retainedBytes + copiedBytes > MAX_DIAGRAM_ASSET_TOTAL_BYTES) return undefined;
        const assetId = allocateId("asset", next.diagram?.assets?.map((asset) => asset.id) ?? []);
        next = addDiagramImage(
          next,
          { ...sourceAsset, id: assetId },
          { ...copy, assetId },
        );
      } else {
        next = addDiagramAnnotation(next, copy);
      }
      ids.push(id);
    }
    return ids.length ? { document: next, ids } : undefined;
  } catch {
    return undefined;
  }
}

export function isValidDiagramHex(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

export function setAnnotationLock(document: LabDocument, ids: readonly string[], locked: boolean): LabDocument {
  let next = document;
  for (const id of ids) {
    const annotation = next.diagram?.annotations.find((candidate) => candidate.id === id);
    if (annotation) next = updateDiagramAnnotation(next, { ...annotation, locked });
  }
  return next;
}
