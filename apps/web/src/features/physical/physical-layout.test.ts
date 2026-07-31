import { canonicalizeLabDocument, parseLabDocument, stringifyLabDocument } from "@sim/lab-format";
import { describe, expect, it } from "vitest";
import { HUB_ETHERNET_DEMO } from "../../fixtures/m10-demo-labs";
import { classifyLabChange, hasStructuralChanges } from "../lab/change-impact";
import { addDiagramImage, removeDraftDevice } from "../lab/document";
import {
  addPhysicalRack,
  addPhysicalRoom,
  addPhysicalSite,
  DEFAULT_ROOM_ID,
  DEFAULT_SITE_ID,
  devicesInRack,
  firstFreeRackUnit,
  freeDevicesInRoom,
  physicalConnectionOverlay,
  physicalViewOf,
  placeDeviceInRack,
  placeDeviceInRoom,
  placementOf,
  PhysicalPlacementError,
  unplaceDevice,
  unplacedDeviceIds,
  withRoomBackground,
} from "./physical-layout";

const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

/** The demo lab with one site, one room and one 8-unit rack ready to fill. */
function labWithRack() {
  const withSite = addPhysicalSite(HUB_ETHERNET_DEMO, "Main Campus");
  const siteId = physicalViewOf(withSite).sites.at(-1)!.id;
  const withRoom = addPhysicalRoom(withSite, siteId, "Network Lab");
  const roomId = physicalViewOf(withRoom).sites.at(-1)!.rooms.at(-1)!.id;
  const withRack = addPhysicalRack(withRoom, roomId, "Rack A", 8);
  const rackId = physicalViewOf(withRack).sites.at(-1)!.rooms.at(-1)!.racks[0]!.id;
  return { document: withRack, siteId, roomId, rackId };
}

describe("physical workspace layout", () => {
  it("opens a lab with no physical metadata as one default site, room and all devices unplaced", () => {
    expect(HUB_ETHERNET_DEMO.physical).toBeUndefined();
    const view = physicalViewOf(HUB_ETHERNET_DEMO);
    expect(view.sites).toHaveLength(1);
    expect(view.sites[0]).toMatchObject({ id: DEFAULT_SITE_ID, name: "Default Site" });
    expect(view.sites[0]!.rooms[0]).toMatchObject({ id: DEFAULT_ROOM_ID, name: "Default Room", racks: [] });
    expect(unplacedDeviceIds(HUB_ETHERNET_DEMO)).toEqual(["pc-1", "hub-1", "pc-2"]);
    // An unplaced device is a normal state, not a validation failure.
    expect(() => canonicalizeLabDocument(HUB_ETHERNET_DEMO)).not.toThrow();
  });

  it("persists a rack placement through the canonical document", () => {
    const { document, rackId, roomId, siteId } = labWithRack();
    const placed = placeDeviceInRack(document, "hub-1", rackId, 3);
    const canonical = canonicalizeLabDocument(placed);
    expect(canonical.physical?.devicePlacements).toEqual([
      { deviceId: "hub-1", siteId, roomId, rackId, rackUnit: 3, rackUnitSpan: 1 },
    ]);
    expect(devicesInRack(physicalViewOf(canonical), rackId)).toHaveLength(1);
    expect(unplacedDeviceIds(canonical)).toEqual(["pc-1", "pc-2"]);
  });

  it("rejects a rack-unit collision instead of displacing the occupant", () => {
    const { document, rackId, roomId, siteId } = labWithRack();
    const first = placeDeviceInRack(document, "hub-1", rackId, 2, { rackUnitSpan: 2 });
    expect(() => placeDeviceInRack(first, "pc-1", rackId, 3)).toThrow(PhysicalPlacementError);
    // Out of range is refused for the same reason: nothing silently moves.
    expect(() => placeDeviceInRack(first, "pc-1", rackId, 8, { rackUnitSpan: 2 })).toThrow(PhysicalPlacementError);
    expect(firstFreeRackUnit(physicalViewOf(first), rackId, 1)).toBe(1);
    expect(placementOf(physicalViewOf(first), "hub-1")).toMatchObject({ rackUnit: 2, rackUnitSpan: 2 });
    // A hand-edited document may not smuggle an overlap past the UI either.
    const overlapping = {
      ...first,
      physical: {
        ...first.physical!,
        devicePlacements: [
          ...first.physical!.devicePlacements,
          { deviceId: "pc-1", siteId, roomId, rackId, rackUnit: 3, rackUnitSpan: 1 },
        ],
      },
    };
    expect(() => canonicalizeLabDocument(overlapping)).toThrow(/already occupied/);
  });

  it("classifies placing, moving and unplacing a device as presentation only", () => {
    const { document, rackId, roomId } = labWithRack();
    const placed = placeDeviceInRack(document, "hub-1", rackId, 1);
    const movedInRack = placeDeviceInRack(placed, "hub-1", rackId, 5);
    const movedToRoom = placeDeviceInRoom(movedInRack, "pc-1", roomId, { x: 120, y: 80 });
    const unplacedAgain = unplaceDevice(movedToRoom, "hub-1");
    for (const [before, after] of [
      [HUB_ETHERNET_DEMO, document],
      [document, placed],
      [placed, movedInRack],
      [movedInRack, movedToRoom],
      [movedToRoom, unplacedAgain],
    ] as const) {
      expect(classifyLabChange(before, after)).toBe("presentation");
      // Presentation never queues an Apply Topology / worker rebuild.
      expect(hasStructuralChanges(before, after)).toBe(false);
    }
    expect(freeDevicesInRoom(physicalViewOf(movedToRoom), roomId)).toHaveLength(1);
    // Placing a device must never disturb the room structure around it.
    const rooms = physicalViewOf(unplacedAgain).sites.flatMap((site) => site.rooms);
    expect(rooms.flatMap((room) => room.racks.map((rack) => rack.id))).toEqual([rackId]);
  });

  it("leaves the logical topology and device configuration untouched", () => {
    const { document, rackId } = labWithRack();
    const placed = placeDeviceInRack(document, "hub-1", rackId, 4);
    expect(placed.topology).toBe(HUB_ETHERNET_DEMO.topology);
    expect(placed.topology.links).toEqual(HUB_ETHERNET_DEMO.topology.links);
    expect(placed.configurations).toBe(HUB_ETHERNET_DEMO.configurations);
    expect(placed.simulation).toEqual(HUB_ETHERNET_DEMO.simulation);
  });

  it("drops the placement when its device is deleted", () => {
    const { document, rackId } = labWithRack();
    const placed = placeDeviceInRack(document, "hub-1", rackId, 1);
    const removed = removeDraftDevice(placed, "hub-1");
    expect(removed.physical?.devicePlacements).toEqual([]);
    // A dangling placement would otherwise fail canonical validation.
    expect(() => canonicalizeLabDocument(removed)).not.toThrow();
  });

  it("reuses the diagram asset pool for a room background and rejects anything else", () => {
    const { document, roomId } = labWithRack();
    const withAsset = addDiagramImage(document, {
      id: "asset-floor",
      mime: "image/png",
      originalName: "floor.png",
      dataBase64: ONE_PIXEL_PNG,
      width: 1,
      height: 1,
    }, {
      id: "annotation-floor",
      type: "image",
      assetId: "asset-floor",
      position: { x: 0, y: 0 },
      width: 64,
      height: 64,
      opacity: 1,
      preserveAspectRatio: true,
      zIndex: 0,
      rotation: 0,
    });
    const withBackground = withRoomBackground(withAsset, roomId, "asset-floor");
    expect(canonicalizeLabDocument(withBackground).physical?.sites[0]?.rooms[0]?.backgroundAssetId)
      .toBe("asset-floor");
    expect(() => withRoomBackground(withAsset, roomId, "https://example.test/plan.svg"))
      .toThrow(PhysicalPlacementError);
  });

  it("round-trips placement through export and import", () => {
    const { document, rackId, roomId } = labWithRack();
    const placed = placeDeviceInRoom(placeDeviceInRack(document, "hub-1", rackId, 2), "pc-1", roomId, { x: 40, y: 90 });
    const reopened = canonicalizeLabDocument(parseLabDocument(stringifyLabDocument(placed)));
    expect(reopened.physical).toEqual(canonicalizeLabDocument(placed).physical);
    expect(placementOf(physicalViewOf(reopened), "hub-1")).toMatchObject({ rackId, rackUnit: 2 });
    expect(placementOf(physicalViewOf(reopened), "pc-1")).toMatchObject({ x: 40, y: 90 });
  });

  it("derives the connection overlay from logical links without inventing cables", () => {
    const { document, rackId, roomId, siteId } = labWithRack();
    const second = addPhysicalRoom(document, siteId, "Wiring Closet");
    const otherRoomId = physicalViewOf(second).sites.at(-1)!.rooms.at(-1)!.id;
    const placed = placeDeviceInRoom(
      placeDeviceInRoom(placeDeviceInRack(second, "hub-1", rackId, 1), "pc-1", roomId, { x: 10, y: 10 }),
      "pc-2",
      otherRoomId,
      { x: 10, y: 10 },
    );
    const overlay = physicalConnectionOverlay(placed, roomId);
    expect(overlay.inRoom).toEqual([{ linkId: "link-1", a: "pc-1", b: "hub-1" }]);
    // The peer in another room is summarized, never routed across the drawing.
    expect(overlay.offRoom).toEqual([
      { linkId: "link-2", deviceId: "hub-1", peerDeviceId: "pc-2", peerLocation: "Wiring Closet" },
    ]);
    expect(placed.topology.links).toEqual(HUB_ETHERNET_DEMO.topology.links);
  });
});
