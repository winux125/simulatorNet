import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DiagramAnnotationSchema, type DiagramAnnotation, type LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import { withDiagramLinkLabel, withoutDiagramLinkLabel } from "../lab/document";
import {
  MAX_ANNOTATION_TEXT_LENGTH,
  MAX_LABEL_TEXT_LENGTH,
  normalizeDiagramText,
  TEXT_ANNOTATION_MAX_HEIGHT,
  TEXT_ANNOTATION_MIN_HEIGHT,
  textAnnotationHeight,
  type TextDiagramAnnotation,
} from "./diagram-editor";
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

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkSources(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

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

describe("M10.3.3b inline text model", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const webSrc = resolve(here, "../../");
  const text = (patch: Partial<TextDiagramAnnotation> = {}): TextDiagramAnnotation => ({
    id: "annotation-1",
    type: "text",
    position: { x: 0, y: 0 },
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
    zIndex: 1,
    rotation: 0,
    locked: false,
    ...patch,
  });

  it("1. grows the rendered height with the content that is being typed", () => {
    const annotation = text({ content: "one" });
    const single = textAnnotationHeight(annotation);
    const multi = textAnnotationHeight(annotation, "one\ntwo\nthree\nfour");
    expect(multi).toBeGreaterThan(single);
    expect(single).toBeGreaterThanOrEqual(TEXT_ANNOTATION_MIN_HEIGHT);
  });

  it("2. bounds the automatic height", () => {
    const tall = textAnnotationHeight(text({ fontSize: 72 }), "x\n".repeat(4_000));
    expect(tall).toBe(TEXT_ANNOTATION_MAX_HEIGHT);
    expect(textAnnotationHeight(text({ fontSize: 8 }))).toBe(TEXT_ANNOTATION_MIN_HEIGHT);
  });

  it("3. honours a fixed height when auto height is disabled", () => {
    expect(textAnnotationHeight(text({ autoHeight: false, height: 128 }), "a\nb\nc\nd")).toBe(128);
  });

  it("4. keeps pasted content as plain text with normalized line endings", () => {
    expect(normalizeDiagramText("Core\r\nEdge\rAccess")).toBe("Core\nEdge\nAccess");
    expect(normalizeDiagramText("safe\u0000te\u0007xt")).toBe("safetext");
    expect(normalizeDiagramText("keep\ttabs")).toBe("keep\ttabs");
  });

  it("5. bounds annotation and label text lengths", () => {
    expect(normalizeDiagramText("x".repeat(9_000)).length).toBe(MAX_ANNOTATION_TEXT_LENGTH);
    expect(normalizeDiagramText("x".repeat(9_000), MAX_LABEL_TEXT_LENGTH).length).toBe(MAX_LABEL_TEXT_LENGTH);
  });

  it("6. leaves no text modal, dialog or prompt in the topology canvas", () => {
    const canvas = readFileSync(join(here, "TopologyCanvas.tsx"), "utf8");
    expect(canvas).toContain('className="inline-text-editor"');
    expect(canvas).not.toContain("annotation-text-dialog");
    expect(canvas).not.toContain("Edit text annotation");
    expect(canvas).not.toMatch(/window\.prompt\((\s*)["'`]Link annotation/);
    // The only remaining dialog on the canvas is the connection modal.
    const dialogRoles = [...canvas.matchAll(/role="dialog"/g)];
    expect(dialogRoles).toHaveLength(0);
  });

  it("7. never renders diagram text through raw HTML", () => {
    for (const file of ["TopologyCanvas.tsx", "DeviceNode.tsx", "x6/graph-controller.ts"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source).not.toContain("dangerouslySetInnerHTML");
      expect(source).not.toContain(".innerHTML");
    }
  });

  it("8. shares one height formula between the canvas node and the editor", () => {
    const controller = readFileSync(join(here, "x6/graph-controller.ts"), "utf8");
    const canvas = readFileSync(join(here, "TopologyCanvas.tsx"), "utf8");
    expect(controller).toContain("textAnnotationHeight(annotation)");
    expect(canvas).toContain("textAnnotationHeight(editingAnnotation, editingText)");
    // No second copy of the formula anywhere in the web sources.
    const duplicates = walkSources(webSrc)
      .filter((file) => !/\.test\.(ts|tsx)$/.test(file))
      .filter((file) => /Math\.max\(1\.8,/.test(readFileSync(file, "utf8")));
    expect(duplicates.map((file) => file.replace(webSrc, ""))).toEqual(["/features/topology/diagram-editor.ts"]);
  });

  it("9. loads an older annotation that has no autoHeight field", () => {
    const legacy = text({ content: "Legacy note", autoHeight: undefined });
    expect(textAnnotationHeight(legacy)).toBeGreaterThanOrEqual(TEXT_ANNOTATION_MIN_HEIGHT);
    const parsed = DiagramAnnotationSchema.parse({ ...legacy, autoHeight: undefined });
    expect(parsed).toMatchObject({ type: "text", content: "Legacy note" });
  });

  it("10. drops a link label without touching topology connectivity", () => {
    const linked: LabDocument = {
      ...empty,
      topology: {
        schemaVersion: 1,
        nodes: [
          { id: "pc-1", kind: "pc", position: { x: 0, y: 0 }, interfaces: [{ id: "eth0" }] },
          { id: "sw-1", kind: "l2-switch", position: { x: 100, y: 0 }, interfaces: [{ id: "Gi0/1" }] },
        ],
        links: [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "sw-1", iface: "Gi0/1" } }],
      },
    };
    const labelled = withDiagramLinkLabel(linked, "link-1", { text: "Trunk", visible: true });
    expect(labelled.diagram?.linkLabels).toHaveLength(1);
    const cleared = withoutDiagramLinkLabel(labelled, "link-1");
    expect(cleared.diagram?.linkLabels).toEqual([]);
    expect(cleared.topology.links).toEqual(linked.topology.links);
    // Removing a label that does not exist is a no-op, not a new document.
    expect(withoutDiagramLinkLabel(cleared, "link-1")).toBe(cleared);
  });
});
