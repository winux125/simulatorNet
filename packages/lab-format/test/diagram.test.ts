import type { LabDocument, LabMetadata } from "@sim/contracts";
import {
  buildLabFromDocument,
  canonicalizeLabDocument,
  serializeLabDocument,
  stringifyLabDocument,
} from "@sim/lab-format";
import { describe, expect, it } from "vitest";

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
});
