import type { LabDocument, LabMetadata } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  parseLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

const document: LabDocument = {
  schemaVersion: 1,
  id: "diagram-lab",
  title: "Diagram lab",
  description: "Persistence fixture",
  instructions: "Configure both endpoints.",
  expectedOutcome: "The link is reachable.",
  simulation: { seed: 17 },
  topology: {
    schemaVersion: 1,
    nodes: [
      { id: "pc-2", kind: "pc", name: "PC2", position: { x: 500, y: 100 }, interfaces: [{ id: "eth0" }] },
      { id: "pc-1", kind: "pc", name: "PC1", position: { x: 100, y: 100 }, interfaces: [{ id: "eth0" }] },
    ],
    links: [{ id: "link-1", a: { node: "pc-1", iface: "eth0" }, b: { node: "pc-2", iface: "eth0" } }],
  },
  configurations: {
    "pc-1": { kind: "pc", hostname: "PC1", interfaces: [], dhcpEnabled: false },
    "pc-2": { kind: "pc", hostname: "PC2", interfaces: [], dhcpEnabled: false },
  },
  diagram: {
    annotations: [
      {
        id: "z-note",
        type: "text",
        position: { x: 240, y: 40 },
        width: 180,
        content: "LAN",
        fontSize: 16,
        bold: true,
        italic: false,
        alignment: "center",
        foreground: "#284158",
        zIndex: 1,
        rotation: 0,
      },
      {
        id: "a-box",
        type: "rectangle",
        position: { x: 60, y: 60 },
        width: 540,
        height: 170,
        fill: "transparent",
        stroke: "#4d7fa9",
        strokeWidth: 1.5,
        strokeDash: "dashed",
        radius: 8,
        opacity: 0.75,
        zIndex: 0,
        rotation: 0,
      },
    ],
    linkLabels: [{
      linkId: "link-1",
      text: "192.168.10.0/24",
      position: 0.5,
      followLink: true,
      offset: -14,
      visible: true,
    }],
    linkStyles: [{
      linkId: "link-1",
      route: "orthogonal",
      vertices: [{ x: 300, y: 160 }],
    }],
  },
};

describe("diagram metadata", () => {
  it("round-trips through canonical server-safe lab serialization", () => {
    const canonical = canonicalizeLabDocument(document);
    const metadata: LabMetadata = {
      id: canonical.id,
      title: canonical.title,
      description: canonical.description,
      instructions: canonical.instructions,
      expectedOutcome: canonical.expectedOutcome,
      diagram: canonical.diagram,
    };
    const serialized = serializeLabDocument(buildLabFromDocument(canonical), metadata);
    expect(stringifyLabDocument(serialized)).toBe(stringifyLabDocument(canonical));
    expect(serialized.diagram?.annotations.map((annotation) => annotation.id)).toEqual(["a-box", "z-note"]);
    expect(serialized.diagram?.linkStyles).toEqual([{
      linkId: "link-1",
      route: "orthogonal",
      vertices: [{ x: 300, y: 160 }],
    }]);
  });

  it("does not add a diagram section to legacy documents", () => {
    const { diagram: _diagram, instructions: _instructions, expectedOutcome: _outcome, ...legacy } = document;
    const canonical = canonicalizeLabDocument(legacy as LabDocument);
    expect(canonical.diagram).toBeUndefined();
  });

  it("round-trips sorted embedded raster assets and image annotations", () => {
    const withImage: LabDocument = {
      ...document,
      diagram: {
        ...document.diagram!,
        assets: [
          { id: "asset-z", mime: "image/png", originalName: "second.png", dataBase64: ONE_PIXEL_PNG, width: 1, height: 1 },
          { id: "asset-a", mime: "image/png", originalName: "first.png", dataBase64: ONE_PIXEL_PNG, width: 1, height: 1 },
        ],
        annotations: [
          ...document.diagram!.annotations,
          {
            id: "image-map",
            type: "image",
            assetId: "asset-z",
            position: { x: 240, y: 220 },
            width: 240,
            height: 120,
            rotation: 5,
            opacity: 0.8,
            preserveAspectRatio: true,
            locked: true,
            zIndex: 4,
          },
        ],
      },
    };
    const canonical = canonicalizeLabDocument(withImage);
    expect(canonical.diagram?.assets?.map((asset) => asset.id)).toEqual(["asset-a", "asset-z"]);
    expect(parseLabDocument(stringifyLabDocument(canonical)).diagram?.annotations)
      .toContainEqual(expect.objectContaining({ id: "image-map", assetId: "asset-z", locked: true }));
  });

  it("round-trips typed text, shape, line and arrow presentation styles", () => {
    const styled = structuredClone(document);
    styled.diagram!.annotations = [
      {
        id: "multiline",
        type: "text",
        position: { x: 20, y: 30 },
        width: 240,
        height: 72,
        autoHeight: false,
        content: "Management\n10.255.0.0/24",
        fontSize: 18,
        bold: true,
        italic: true,
        alignment: "left",
        foreground: "#203247",
        background: "#dbeafe",
        border: "#4d7fa9",
        borderWidth: 2,
        opacity: 0.9,
        rotation: 12,
        locked: true,
        zIndex: 2,
      },
      {
        id: "shape",
        type: "ellipse",
        position: { x: 300, y: 30 },
        width: 180,
        height: 90,
        fill: "#dbeafe",
        stroke: "#2563eb",
        strokeWidth: 3,
        strokeDash: "dotted",
        opacity: 0.65,
        rotation: 5,
        zIndex: 3,
      },
      {
        id: "line",
        type: "line",
        start: { x: 40, y: 180 },
        end: { x: 260, y: 220 },
        bend: { x: 160, y: 170 },
        stroke: "#2563eb",
        strokeWidth: 2,
        strokeDash: "dashed",
        startMarker: "circle",
        endMarker: "none",
        opacity: 0.8,
        label: "diagram-only",
        zIndex: 4,
      },
      {
        id: "arrow",
        type: "arrow",
        start: { x: 300, y: 180 },
        end: { x: 520, y: 220 },
        stroke: "#4d7fa9",
        strokeWidth: 2.5,
        strokeDash: "solid",
        startMarker: "none",
        endMarker: "arrow",
        opacity: 1,
        zIndex: 5,
      },
    ];

    const canonical = canonicalizeLabDocument(styled);
    expect(parseLabDocument(stringifyLabDocument(canonical)).diagram?.annotations)
      .toEqual(canonical.diagram!.annotations);
  });

  it("rejects content whose decoded signature does not match the MIME type", () => {
    const input = structuredClone(document);
    input.diagram!.assets = [{
      id: "spoofed",
      mime: "image/jpeg",
      originalName: "spoofed.jpg",
      dataBase64: ONE_PIXEL_PNG,
      width: 1,
      height: 1,
    }];
    expect(() => parseLabDocument(input)).toThrowError(expect.objectContaining({ code: "diagram-asset-type-mismatch" }));
  });

  it("rejects declared image dimensions that do not match decoded content", () => {
    const input = structuredClone(document);
    input.diagram!.assets = [{
      id: "wrong-size",
      mime: "image/png",
      originalName: "wrong.png",
      dataBase64: ONE_PIXEL_PNG,
      width: 20,
      height: 10,
    }];
    expect(() => parseLabDocument(input)).toThrowError(expect.objectContaining({ code: "diagram-asset-dimension-mismatch" }));
  });

  it("rejects image annotations that reference an unknown asset", () => {
    const input = structuredClone(document);
    input.diagram!.annotations.push({
      id: "missing-image",
      type: "image",
      assetId: "missing",
      position: { x: 1, y: 1 },
      width: 100,
      height: 100,
      rotation: 0,
      opacity: 1,
      preserveAspectRatio: true,
      zIndex: 2,
    });
    expect(() => parseLabDocument(input)).toThrowError(expect.objectContaining({ code: "unknown-diagram-asset" }));
  });

  it("rejects unsupported image MIME types at the contract boundary", () => {
    const input = structuredClone(document) as unknown as Record<string, any>;
    input.diagram.assets = [{
      id: "svg",
      mime: "image/svg+xml",
      originalName: "unsafe.svg",
      dataBase64: "PHN2Zz48L3N2Zz4=",
      width: 10,
      height: 10,
    }];
    expect(() => parseLabDocument(input)).toThrowError();
  });

  it("loads older diagram metadata without presentation routing", () => {
    const input = structuredClone(document) as unknown as Record<string, any>;
    delete input.diagram.linkStyles;
    expect(parseLabDocument(input).diagram?.linkStyles).toEqual([]);
  });

  it("rejects presentation routing for an unknown topology link", () => {
    const input = structuredClone(document);
    input.diagram!.linkStyles.push({ linkId: "missing-link", route: "straight", vertices: [] });
    expect(() => parseLabDocument(input)).toThrowError(expect.objectContaining({ code: "unknown-diagram-link" }));
  });
});
