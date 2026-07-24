// @vitest-environment jsdom

import type { LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import { createDiagramAsset } from "./diagram-image-assets";

const document: LabDocument = {
  schemaVersion: 1,
  id: "image-test",
  title: "Image test",
  simulation: { seed: 1 },
  topology: { schemaVersion: 1, nodes: [], links: [] },
  configurations: {},
};

function file(bytes: number[], name: string, type: string): File {
  return {
    name,
    type,
    size: bytes.length,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as File;
}

describe("diagram image ingestion", () => {
  it("rejects SVG and other active/non-raster content", async () => {
    const svg = file([...new TextEncoder().encode("<svg><script/></svg>")], "unsafe.svg", "image/svg+xml");
    await expect(createDiagramAsset(svg, "asset-1", document)).rejects.toThrow("PNG, JPEG, or WebP");
  });

  it("rejects a declared MIME type that does not match the file signature", async () => {
    const pngHeader = file(
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(20).fill(0)],
      "spoofed.jpg",
      "image/jpeg",
    );
    await expect(createDiagramAsset(pngHeader, "asset-1", document)).rejects.toThrow("do not match");
  });

  it("rejects files larger than the per-asset limit before decoding", async () => {
    const oversized = { name: "huge.png", type: "image/png", size: 2 * 1_024 * 1_024 + 1 } as File;
    await expect(createDiagramAsset(oversized, "asset-1", document)).rejects.toThrow("2 MB or smaller");
  });

  it("rejects the twenty-first embedded image", async () => {
    const full: LabDocument = {
      ...document,
      diagram: {
        assets: Array.from({ length: 20 }, (_, index) => ({
          id: `asset-${index}`,
          mime: "image/png" as const,
          originalName: `${index}.png`,
          dataBase64: "AAAA",
          width: 1,
          height: 1,
        })),
        annotations: [],
        linkLabels: [],
      },
    };
    await expect(createDiagramAsset(file([], "next.png", "image/png"), "asset-next", full))
      .rejects.toThrow("at most 20");
  });
});
