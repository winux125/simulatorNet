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
        stroke: "#4d7fa9",
        strokeWidth: 1.5,
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
});
