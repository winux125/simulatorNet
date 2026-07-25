import type { DiagramAnnotation, LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import {
  alignAnnotations,
  annotationBounds,
  annotationsInsideBounds,
  changeAnnotationsZOrder,
  constrainLineEnd,
  createDiagramAnnotation,
  distributeAnnotations,
  duplicateAnnotations,
  isValidDiagramHex,
  moveAnnotations,
  pasteDiagramClipboard,
  rectangleFromDrag,
  removeAnnotations,
  resizeAnnotation,
  rotateAnnotation,
  serializeDiagramClipboard,
  setAnnotationLock,
  snapDiagramPoint,
  snapTranslationToSmartGuides,
  translateAnnotation,
  updateLineEndpoint,
} from "./diagram-editor";

const empty: LabDocument = {
  schemaVersion: 1,
  id: "diagram-editor-test",
  title: "Diagram editor",
  simulation: { seed: 7 },
  topology: { schemaVersion: 1, nodes: [], links: [] },
  configurations: {},
};

function documentWith(...annotations: DiagramAnnotation[]): LabDocument {
  return {
    ...empty,
    diagram: { assets: [], annotations, linkLabels: [], linkStyles: [] },
  };
}

function rectangle(id: string, x: number, y: number, zIndex = 0): DiagramAnnotation {
  return {
    id,
    type: "rectangle",
    position: { x, y },
    width: 100,
    height: 50,
    fill: "transparent",
    stroke: "#4d7fa9",
    strokeWidth: 2,
    strokeDash: "solid",
    opacity: 1,
    radius: 4,
    zIndex,
    rotation: 0,
  };
}

describe("professional diagram editing model", () => {
  it("creates a rectangle from a pointer drag", () => {
    const annotation = createDiagramAnnotation(empty, "annotation-rectangle", { x: 10, y: 20 }, { x: 170, y: 110 });
    expect(annotation).toMatchObject({ type: "rectangle", position: { x: 10, y: 20 }, width: 160, height: 90 });
  });

  it("constrains Shift rectangle creation to a square", () => {
    expect(rectangleFromDrag({ x: 0, y: 0 }, { x: 90, y: 40 }, { shift: true }))
      .toMatchObject({ width: 90, height: 90 });
  });

  it("creates shapes from their center with Alt", () => {
    expect(rectangleFromDrag({ x: 100, y: 100 }, { x: 130, y: 120 }, { alt: true }))
      .toEqual({ x: 70, y: 80, width: 60, height: 40 });
  });

  it("uses a predictable default size for a click without drag", () => {
    expect(rectangleFromDrag({ x: 20, y: 30 }, { x: 21, y: 31 }))
      .toEqual({ x: 20, y: 30, width: 140, height: 80 });
  });

  it("creates ellipse, text, line, and arrow as distinct domain objects", () => {
    expect(createDiagramAnnotation(empty, "annotation-ellipse", { x: 0, y: 0 }, { x: 30, y: 20 })?.type).toBe("ellipse");
    expect(createDiagramAnnotation(empty, "annotation-text", { x: 0, y: 0 })?.type).toBe("text");
    expect(createDiagramAnnotation(empty, "annotation-line", { x: 0, y: 0 }, { x: 30, y: 20 })?.type).toBe("line");
    expect(createDiagramAnnotation(empty, "annotation-arrow", { x: 0, y: 0 }, { x: 30, y: 20 }))
      .toMatchObject({ type: "arrow", endMarker: "arrow" });
  });

  it("constrains a Shift line to 45 degree increments", () => {
    const end = constrainLineEnd({ x: 0, y: 0 }, { x: 100, y: 25 }, true);
    expect(end.y).toBeCloseTo(0);
  });

  it("snaps points to the local-only ten-pixel grid", () => {
    expect(snapDiagramPoint({ x: 14, y: 26 })).toEqual({ x: 10, y: 30 });
    expect(snapDiagramPoint({ x: 14, y: 26 }, false)).toEqual({ x: 14, y: 26 });
  });

  it("moves a single unlocked object but not a locked object", () => {
    const source = rectangle("one", 10, 20);
    expect(translateAnnotation(source, 4, 5)).toMatchObject({ position: { x: 14, y: 25 } });
    expect(translateAnnotation({ ...source, locked: true }, 4, 5)).toEqual({ ...source, locked: true });
  });

  it("moves a multi-selection as one group", () => {
    const next = moveAnnotations(documentWith(rectangle("a", 0, 0), rectangle("b", 100, 0)), ["a", "b"], 20, 30);
    expect(next.diagram?.annotations.map((annotation) => annotationBounds(annotation).x)).toEqual([20, 120]);
  });

  it("resizes with minimum dimensions and optional aspect preservation", () => {
    const source = { ...rectangle("a", 0, 0), width: 100, height: 50 };
    expect(resizeAnnotation(source, 1, 2)).toMatchObject({ width: 12, height: 12 });
    expect(resizeAnnotation(source, 200, 80, true)).toMatchObject({ width: 200, height: 100 });
  });

  it("normalizes rotation without transforming locked objects", () => {
    const source = rectangle("a", 0, 0);
    expect(rotateAnnotation(source, -90)).toMatchObject({ rotation: 270 });
    expect(rotateAnnotation({ ...source, locked: true }, 90)).toMatchObject({ rotation: 0 });
  });

  it("edits arrow endpoints independently", () => {
    const arrow = createDiagramAnnotation(empty, "annotation-arrow", { x: 0, y: 0 }, { x: 50, y: 0 })!;
    expect(updateLineEndpoint(arrow, "end", { x: 80, y: 20 })).toMatchObject({ end: { x: 80, y: 20 } });
    expect(updateLineEndpoint(arrow, "bend", { x: 30, y: 30 })).toMatchObject({ bend: { x: 30, y: 30 } });
  });

  it("selects annotations fully inside a marquee", () => {
    const doc = documentWith(rectangle("inside", 10, 10), rectangle("outside", 200, 200));
    expect(annotationsInsideBounds(doc, { x: 0, y: 0, width: 150, height: 100 })).toEqual(["inside"]);
  });

  it("duplicates with deterministic non-conflicting IDs and offsets", () => {
    const result = duplicateAnnotations(documentWith(rectangle("annotation-1", 0, 0)), ["annotation-1"]);
    expect(result.ids).toEqual(["annotation-2"]);
    expect(result.document.diagram?.annotations[1]).toMatchObject({ id: "annotation-2", position: { x: 20, y: 20 } });
  });

  it("deletes only selected objects", () => {
    const next = removeAnnotations(documentWith(rectangle("a", 0, 0), rectangle("b", 20, 20)), ["a"]);
    expect(next.diagram?.annotations.map((annotation) => annotation.id)).toEqual(["b"]);
  });

  it("locks and unlocks a multi-selection", () => {
    const doc = documentWith(rectangle("a", 0, 0), rectangle("b", 20, 20));
    const locked = setAnnotationLock(doc, ["a", "b"], true);
    expect(locked.diagram?.annotations.every((annotation) => annotation.locked)).toBe(true);
    expect(setAnnotationLock(locked, ["a"], false).diagram?.annotations[0]?.locked).toBe(false);
  });

  it("supports forward, backward, front, and back z-order operations", () => {
    const doc = documentWith(rectangle("a", 0, 0, 0), rectangle("b", 0, 0, 1), rectangle("c", 0, 0, 2));
    expect(changeAnnotationsZOrder(doc, ["a"], "front").diagram?.annotations.find((a) => a.id === "a")?.zIndex).toBe(2);
    expect(changeAnnotationsZOrder(doc, ["c"], "back").diagram?.annotations.find((a) => a.id === "c")?.zIndex).toBe(0);
    expect(changeAnnotationsZOrder(doc, ["b"], "forward").diagram?.annotations.find((a) => a.id === "b")?.zIndex).toBe(2);
    expect(changeAnnotationsZOrder(doc, ["b"], "backward").diagram?.annotations.find((a) => a.id === "b")?.zIndex).toBe(0);
  });

  it("aligns selected objects by their domain bounds", () => {
    const next = alignAnnotations(documentWith(rectangle("a", 10, 0), rectangle("b", 80, 20)), ["a", "b"], "left");
    expect(next.diagram?.annotations.map((annotation) => annotationBounds(annotation).x)).toEqual([10, 10]);
  });

  it("distributes three objects evenly", () => {
    const next = distributeAnnotations(
      documentWith(rectangle("a", 0, 0), rectangle("b", 80, 0), rectangle("c", 300, 0)),
      ["a", "b", "c"],
      "horizontal",
    );
    expect(next.diagram?.annotations.map((annotation) => annotationBounds(annotation).x)).toEqual([0, 150, 300]);
  });

  it("snaps group movement to object center and edge guides", () => {
    const doc = documentWith(rectangle("moving", 0, 0), rectangle("target", 106, 100));
    expect(snapTranslationToSmartGuides(doc, ["moving"], 101, 0, true))
      .toMatchObject({ dx: 106, guideX: 106 });
    expect(snapTranslationToSmartGuides(doc, ["moving"], 101, 0, false)).toEqual({ dx: 101, dy: 0 });
  });

  it("copies and pastes plain safe diagram objects with deterministic IDs", () => {
    const doc = documentWith(rectangle("annotation-1", 0, 0));
    const pasted = pasteDiagramClipboard(doc, serializeDiagramClipboard(doc, ["annotation-1"]));
    expect(pasted?.ids).toEqual(["annotation-2"]);
    expect(pasted?.document.diagram?.annotations).toHaveLength(2);
  });

  it("copies embedded images with their bounded local asset", () => {
    const doc: LabDocument = {
      ...empty,
      diagram: {
        assets: [{ id: "asset-1", mime: "image/png", originalName: "note.png", dataBase64: "AAAA", width: 1, height: 1 }],
        annotations: [{
          id: "annotation-1",
          type: "image",
          assetId: "asset-1",
          position: { x: 10, y: 20 },
          width: 80,
          height: 60,
          opacity: 1,
          preserveAspectRatio: true,
          alt: "Diagram note",
          zIndex: 1,
          rotation: 0,
        }],
        linkLabels: [],
        linkStyles: [],
      },
    };
    const pasted = pasteDiagramClipboard(doc, serializeDiagramClipboard(doc, ["annotation-1"]));
    expect(pasted?.document.diagram?.assets).toHaveLength(2);
    expect(pasted?.document.diagram?.annotations[1]).toMatchObject({
      type: "image",
      assetId: "asset-2",
      alt: "Diagram note",
    });
  });

  it("rejects malformed and executable clipboard payloads", () => {
    expect(pasteDiagramClipboard(empty, "<script>alert(1)</script>")).toBeUndefined();
    expect(pasteDiagramClipboard(empty, JSON.stringify({ version: 1, annotations: [{ type: "script" }] }))).toBeUndefined();
  });

  it("validates six-digit hexadecimal colors", () => {
    expect(isValidDiagramHex("#1a2B3c")).toBe(true);
    expect(isValidDiagramHex("red")).toBe(false);
    expect(isValidDiagramHex("#fff")).toBe(false);
  });

  it("keeps a diagram line distinct from a physical network link", () => {
    const line = createDiagramAnnotation(empty, "annotation-line", { x: 0, y: 0 }, { x: 50, y: 0 });
    expect(line).not.toHaveProperty("a");
    expect(line).not.toHaveProperty("b");
    expect(empty.topology.links).toHaveLength(0);
  });
});
