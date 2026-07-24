// @vitest-environment jsdom

import { canonicalizeLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import {
  setDeviceIconProfile,
  DEVICE_ICON_PROFILE_STORAGE_KEY,
} from "../../hooks/useDeviceIconProfile";
import { HUB_ETHERNET_DEMO } from "../../fixtures/m10-demo-labs";
import { portLabelsVisible } from "../topology/diagram-presentation";
import {
  addDiagramAnnotation,
  addDiagramImage,
  duplicateDiagramAnnotation,
  moveDiagramAnnotation,
  removeDiagramAnnotation,
  withDiagramLinkLabel,
} from "./document";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

describe("diagram document helpers", () => {
  it("persists link labels and text annotations through canonical LabDocument", () => {
    const withLabel = withDiagramLinkLabel(HUB_ETHERNET_DEMO, "link-1", {
      text: "192.168.10.0/24",
      position: 0.42,
      offset: -16,
    });
    const withText = addDiagramAnnotation(withLabel, {
      id: "annotation-loopback",
      type: "text",
      position: { x: 300, y: 70 },
      width: 220,
      content: "Loopback addressing",
      fontSize: 15,
      bold: true,
      italic: false,
      alignment: "center",
      foreground: "#284158",
      zIndex: 2,
      rotation: 0,
    });
    const canonical = canonicalizeLabDocument(withText);
    expect(canonical.diagram?.linkLabels[0]).toMatchObject({
      linkId: "link-1",
      text: "192.168.10.0/24",
      position: 0.42,
    });
    expect(canonical.diagram?.annotations[0]).toMatchObject({
      id: "annotation-loopback",
      type: "text",
      content: "Loopback addressing",
    });
  });

  it("loads old documents with no diagram metadata", () => {
    const old = canonicalizeLabDocument(HUB_ETHERNET_DEMO);
    expect(old.diagram).toBeUndefined();
  });

  it("supports Always, Selected and Hidden endpoint port labels", () => {
    expect(portLabelsVisible("always", false)).toBe(true);
    expect(portLabelsVisible("selected", false)).toBe(false);
    expect(portLabelsVisible("selected", true)).toBe(true);
    expect(portLabelsVisible("hidden", true)).toBe(false);
  });

  it("keeps icon profile preference outside the LabDocument", () => {
    const before = JSON.stringify(HUB_ETHERNET_DEMO);
    setDeviceIconProfile("minimal");
    expect(window.localStorage.getItem(DEVICE_ICON_PROFILE_STORAGE_KEY)).toBe("minimal");
    expect(JSON.stringify(HUB_ETHERNET_DEMO)).toBe(before);
  });

  it("adds, duplicates and garbage-collects an embedded image asset", () => {
    const withImage = addDiagramImage(
      HUB_ETHERNET_DEMO,
      { id: "asset-1", mime: "image/png", originalName: "map.png", dataBase64: ONE_PIXEL_PNG, width: 1, height: 1 },
      {
        id: "annotation-1",
        type: "image",
        assetId: "asset-1",
        position: { x: 120, y: 80 },
        width: 200,
        height: 120,
        opacity: 1,
        preserveAspectRatio: true,
        rotation: 0,
        zIndex: 1,
      },
    );
    const duplicated = duplicateDiagramAnnotation(withImage, "annotation-1");
    expect(duplicated.diagram?.annotations.filter((annotation) => annotation.type === "image")).toHaveLength(2);
    expect(duplicated.diagram?.assets).toHaveLength(1);
    const withoutFirst = removeDiagramAnnotation(duplicated, "annotation-1");
    expect(withoutFirst.diagram?.assets).toHaveLength(1);
    const duplicateId = withoutFirst.diagram?.annotations.find((annotation) => annotation.type === "image")?.id;
    expect(removeDiagramAnnotation(withoutFirst, duplicateId!).diagram?.assets).toHaveLength(0);
  });

  it("does not move a locked annotation", () => {
    const locked = addDiagramAnnotation(HUB_ETHERNET_DEMO, {
      id: "locked-note",
      type: "text",
      position: { x: 10, y: 20 },
      width: 160,
      content: "Locked",
      fontSize: 14,
      bold: false,
      italic: false,
      alignment: "left",
      foreground: "#203247",
      rotation: 0,
      locked: true,
      zIndex: 1,
    });
    expect(moveDiagramAnnotation(locked, "locked-note", { x: 300, y: 300 })).toBe(locked);
  });
});
