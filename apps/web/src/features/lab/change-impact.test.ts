import type { LabDocument } from "@sim/contracts";
import { describe, expect, it } from "vitest";
import { HUB_ETHERNET_DEMO } from "../../fixtures/m10-demo-labs";
import {
  addDiagramAnnotation,
  addDiagramImage,
  addDraftDevice,
  removeDraftDevice,
  removeDraftLink,
  withDiagramLinkLabel,
  withHostStaticConfiguration,
  withNodePosition,
} from "./document";
import {
  assertLabChangeImpact,
  classifyLabChange,
  hasStructuralChanges,
  LabChangeImpactError,
} from "./change-impact";

function textNote(document: LabDocument): LabDocument {
  return addDiagramAnnotation(document, {
    id: "note-1",
    type: "text",
    position: { x: 15, y: 25 },
    width: 160,
    content: "Presentation only",
    fontSize: 14,
    bold: false,
    italic: false,
    alignment: "left",
    foreground: "auto",
    rotation: 0,
    zIndex: 1,
  });
}

describe("LabChangeImpact", () => {
  it("classifies positions, annotations and link labels as presentation", () => {
    expect(classifyLabChange(HUB_ETHERNET_DEMO, withNodePosition(HUB_ETHERNET_DEMO, "pc-1", { x: 400, y: 300 }))).toBe("presentation");
    expect(classifyLabChange(HUB_ETHERNET_DEMO, textNote(HUB_ETHERNET_DEMO))).toBe("presentation");
    expect(classifyLabChange(
      HUB_ETHERNET_DEMO,
      withDiagramLinkLabel(HUB_ETHERNET_DEMO, "link-1", { text: "Users", visible: true }),
    )).toBe("presentation");
    expect(classifyLabChange(HUB_ETHERNET_DEMO, addDiagramImage(
      HUB_ETHERNET_DEMO,
      {
        id: "asset-1",
        mime: "image/png",
        originalName: "pixel.png",
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
        width: 1,
        height: 1,
      },
      {
        id: "image-1",
        type: "image",
        assetId: "asset-1",
        position: { x: 12, y: 24 },
        width: 100,
        height: 100,
        rotation: 0,
        opacity: 1,
        preserveAspectRatio: true,
        zIndex: 1,
      },
    ))).toBe("presentation");
  });

  it("classifies reusable host configuration as configuration", () => {
    const configured = withHostStaticConfiguration(HUB_ETHERNET_DEMO, "pc-1", {
      address: "192.168.10.99",
      prefixLength: 24,
    });
    expect(classifyLabChange(HUB_ETHERNET_DEMO, configured)).toBe("configuration");
  });

  it("classifies device and link inventory changes as structural", () => {
    expect(classifyLabChange(HUB_ETHERNET_DEMO, addDraftDevice(HUB_ETHERNET_DEMO, "router"))).toBe("structural");
    expect(classifyLabChange(HUB_ETHERNET_DEMO, removeDraftDevice(HUB_ETHERNET_DEMO, "pc-2"))).toBe("structural");
    expect(classifyLabChange(HUB_ETHERNET_DEMO, removeDraftLink(HUB_ETHERNET_DEMO, "link-1"))).toBe("structural");
    const reconnected = structuredClone(HUB_ETHERNET_DEMO);
    reconnected.topology.links[0]!.b.iface = "Eth0/3";
    expect(classifyLabChange(HUB_ETHERNET_DEMO, reconnected)).toBe("structural");
  });

  it("fails safely for an unknown document mutation or a false declaration", () => {
    const unknown = { ...HUB_ETHERNET_DEMO, futureField: "unsafe-default" } as LabDocument;
    expect(classifyLabChange(HUB_ETHERNET_DEMO, unknown)).toBe("structural");
    expect(() => assertLabChangeImpact(
      HUB_ETHERNET_DEMO,
      addDraftDevice(HUB_ETHERNET_DEMO, "router"),
      "presentation",
    )).toThrow(LabChangeImpactError);
  });

  it("tracks only unapplied structural differences", () => {
    expect(hasStructuralChanges(HUB_ETHERNET_DEMO, withNodePosition(HUB_ETHERNET_DEMO, "pc-1", { x: 9, y: 9 }))).toBe(false);
    expect(hasStructuralChanges(HUB_ETHERNET_DEMO, textNote(HUB_ETHERNET_DEMO))).toBe(false);
    expect(hasStructuralChanges(HUB_ETHERNET_DEMO, addDraftDevice(HUB_ETHERNET_DEMO, "router"))).toBe(true);
  });
});
