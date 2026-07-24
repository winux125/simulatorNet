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
  withDiagramLinkLabel,
} from "./document";

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
});
