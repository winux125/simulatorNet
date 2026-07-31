import {
  DEFAULT_RACK_UNITS,
  DEFAULT_RACK_WIDTH,
  MAX_DEVICE_RACK_UNIT_SPAN,
  MAX_PHYSICAL_RACKS_PER_ROOM,
  MAX_PHYSICAL_ROOMS_PER_SITE,
  MAX_PHYSICAL_SITES,
  MIN_DEVICE_RACK_UNIT_SPAN,
  placementLastRackUnit,
  type DevicePhysicalPlacement,
  type LabDocument,
  type LabPhysicalLayout,
  type PhysicalRack,
  type PhysicalRoom,
  type PhysicalSite,
} from "@sim/contracts";

/**
 * Pure model behind the Physical workspace.
 *
 * Everything here maps one `LabDocument` to another `LabDocument` whose only
 * difference is `physical`. That makes every operation a *presentation* change
 * by construction: the topology, configurations, seed and diagram objects are
 * passed through untouched, so no worker rebuild, no Apply Topology and no
 * runtime reset can be triggered from this file.
 */

export const DEFAULT_SITE_ID = "site-default";
export const DEFAULT_ROOM_ID = "room-default";
export const DEFAULT_SITE_NAME = "Default Site";
export const DEFAULT_ROOM_NAME = "Default Room";

export class PhysicalPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhysicalPlacementError";
  }
}

/**
 * Local id allocator. Deliberately not imported from `features/lab/document`:
 * that module prunes placements when a device is deleted, so the dependency
 * runs one way only and the two files stay acyclic.
 */
function allocateId(prefix: string, existing: Iterable<string>): string {
  const ids = new Set(existing);
  let index = 1;
  while (ids.has(`${prefix}-${index}`)) index++;
  return `${prefix}-${index}`;
}

/**
 * The layout a lab is *shown* with. A lab saved before M10.8.1 has no physical
 * metadata at all, which is not an error: it opens with one Default Site, one
 * Default Room and every device in Unplaced.
 */
export function physicalViewOf(document: LabDocument | undefined): LabPhysicalLayout {
  const stored = document?.physical;
  if (stored && stored.sites.length > 0) return stored;
  return {
    sites: [{ id: DEFAULT_SITE_ID, name: DEFAULT_SITE_NAME, rooms: [defaultRoom()] }],
    devicePlacements: stored?.devicePlacements ?? [],
  };
}

function defaultRoom(): PhysicalRoom {
  return { id: DEFAULT_ROOM_ID, name: DEFAULT_ROOM_NAME, racks: [] };
}

/** Store the layout, dropping it entirely when it carries nothing worth saving. */
function withLayout(document: LabDocument, layout: LabPhysicalLayout): LabDocument {
  const empty = layout.sites.length === 0 && layout.devicePlacements.length === 0;
  return { ...document, physical: empty ? undefined : layout };
}

export function findRoom(
  layout: LabPhysicalLayout,
  roomId: string,
): { site: PhysicalSite; room: PhysicalRoom } | undefined {
  for (const site of layout.sites) {
    const room = site.rooms.find((candidate) => candidate.id === roomId);
    if (room) return { site, room };
  }
  return undefined;
}

export function findRack(layout: LabPhysicalLayout, rackId: string): PhysicalRack | undefined {
  for (const site of layout.sites) {
    for (const room of site.rooms) {
      const rack = room.racks.find((candidate) => candidate.id === rackId);
      if (rack) return rack;
    }
  }
  return undefined;
}

export function placementOf(
  layout: LabPhysicalLayout,
  deviceId: string,
): DevicePhysicalPlacement | undefined {
  return layout.devicePlacements.find((placement) => placement.deviceId === deviceId);
}

/** Devices that carry no placement. Being unplaced is normal, never an error. */
export function unplacedDeviceIds(document: LabDocument): string[] {
  const placed = new Set(physicalViewOf(document).devicePlacements.map((placement) => placement.deviceId));
  return document.topology.nodes.map((node) => node.id).filter((id) => !placed.has(id));
}

/** Rack-mounted devices of one rack, ordered top-down by rack unit. */
export function devicesInRack(layout: LabPhysicalLayout, rackId: string): DevicePhysicalPlacement[] {
  return layout.devicePlacements
    .filter((placement) => placement.rackId === rackId)
    .sort((a, b) => (a.rackUnit ?? 0) - (b.rackUnit ?? 0) || a.deviceId.localeCompare(b.deviceId));
}

/** Free-placed devices of one room: in the room, but not in any rack. */
export function freeDevicesInRoom(layout: LabPhysicalLayout, roomId: string): DevicePhysicalPlacement[] {
  return layout.devicePlacements
    .filter((placement) => placement.roomId === roomId && placement.rackId === undefined)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/**
 * Whether a device would overlap another one. A rack slot holds exactly one
 * device, so a collision is rejected instead of silently displacing anything.
 */
export function rackUnitsAvailable(
  layout: LabPhysicalLayout,
  rackId: string,
  rackUnit: number,
  rackUnitSpan: number,
  movingDeviceId?: string,
): boolean {
  const rack = findRack(layout, rackId);
  if (!rack) return false;
  if (rackUnit < 1 || rackUnit + rackUnitSpan - 1 > rack.rackUnits) return false;
  const last = rackUnit + rackUnitSpan - 1;
  return !devicesInRack(layout, rackId).some((placement) => {
    if (placement.deviceId === movingDeviceId) return false;
    return placement.rackUnit !== undefined
      && placement.rackUnit <= last
      && placementLastRackUnit(placement) >= rackUnit;
  });
}

/** The topmost free run of `rackUnitSpan` units, or undefined when the rack is full. */
export function firstFreeRackUnit(
  layout: LabPhysicalLayout,
  rackId: string,
  rackUnitSpan: number,
): number | undefined {
  const rack = findRack(layout, rackId);
  if (!rack) return undefined;
  for (let unit = 1; unit + rackUnitSpan - 1 <= rack.rackUnits; unit++) {
    if (rackUnitsAvailable(layout, rackId, unit, rackUnitSpan)) return unit;
  }
  return undefined;
}

function replacePlacement(
  layout: LabPhysicalLayout,
  placement: DevicePhysicalPlacement,
): LabPhysicalLayout {
  return {
    ...layout,
    devicePlacements: [
      ...layout.devicePlacements.filter((entry) => entry.deviceId !== placement.deviceId),
      placement,
    ],
  };
}

function mapSites(
  layout: LabPhysicalLayout,
  map: (site: PhysicalSite) => PhysicalSite,
): LabPhysicalLayout {
  return { ...layout, sites: layout.sites.map(map) };
}

function mapRoom(
  layout: LabPhysicalLayout,
  roomId: string,
  map: (room: PhysicalRoom) => PhysicalRoom,
): LabPhysicalLayout {
  return mapSites(layout, (site) => ({
    ...site,
    rooms: site.rooms.map((room) => room.id === roomId ? map(room) : room),
  }));
}

// --- structure ------------------------------------------------------------

export function addPhysicalSite(document: LabDocument, name: string): LabDocument {
  const layout = physicalViewOf(document);
  if (layout.sites.length >= MAX_PHYSICAL_SITES) {
    throw new PhysicalPlacementError(`A lab may contain at most ${MAX_PHYSICAL_SITES} sites.`);
  }
  const trimmed = name.trim();
  if (!trimmed) throw new PhysicalPlacementError("A site needs a name.");
  const id = allocateId("site", layout.sites.map((site) => site.id));
  return withLayout(document, { ...layout, sites: [...layout.sites, { id, name: trimmed, rooms: [] }] });
}

export function renamePhysicalSite(document: LabDocument, siteId: string, name: string): LabDocument {
  const trimmed = name.trim();
  if (!trimmed) return document;
  const layout = physicalViewOf(document);
  return withLayout(document, mapSites(layout, (site) => site.id === siteId ? { ...site, name: trimmed } : site));
}

/** Removing a site removes its rooms, racks and every placement inside them. */
export function removePhysicalSite(document: LabDocument, siteId: string): LabDocument {
  const layout = physicalViewOf(document);
  return withLayout(document, {
    sites: layout.sites.filter((site) => site.id !== siteId),
    devicePlacements: layout.devicePlacements.filter((placement) => placement.siteId !== siteId),
  });
}

export function addPhysicalRoom(document: LabDocument, siteId: string, name: string): LabDocument {
  const layout = physicalViewOf(document);
  const site = layout.sites.find((candidate) => candidate.id === siteId);
  if (!site) throw new PhysicalPlacementError(`Unknown site '${siteId}'.`);
  if (site.rooms.length >= MAX_PHYSICAL_ROOMS_PER_SITE) {
    throw new PhysicalPlacementError(`A site may contain at most ${MAX_PHYSICAL_ROOMS_PER_SITE} rooms.`);
  }
  const trimmed = name.trim();
  if (!trimmed) throw new PhysicalPlacementError("A room needs a name.");
  const id = allocateId("room", layout.sites.flatMap((entry) => entry.rooms.map((room) => room.id)));
  return withLayout(document, mapSites(layout, (entry) => entry.id === siteId
    ? { ...entry, rooms: [...entry.rooms, { id, name: trimmed, racks: [] }] }
    : entry));
}

export function renamePhysicalRoom(document: LabDocument, roomId: string, name: string): LabDocument {
  const trimmed = name.trim();
  if (!trimmed) return document;
  return withLayout(document, mapRoom(physicalViewOf(document), roomId, (room) => ({ ...room, name: trimmed })));
}

export function removePhysicalRoom(document: LabDocument, roomId: string): LabDocument {
  const layout = physicalViewOf(document);
  return withLayout(document, {
    sites: layout.sites.map((site) => ({ ...site, rooms: site.rooms.filter((room) => room.id !== roomId) })),
    devicePlacements: layout.devicePlacements.filter((placement) => placement.roomId !== roomId),
  });
}

/** Attach or clear a room floor plan. The asset must already exist in `diagram.assets`. */
export function withRoomBackground(
  document: LabDocument,
  roomId: string,
  assetId: string | undefined,
): LabDocument {
  if (assetId !== undefined && !(document.diagram?.assets ?? []).some((asset) => asset.id === assetId)) {
    throw new PhysicalPlacementError("Choose an image that is already stored with this lab.");
  }
  return withLayout(document, mapRoom(physicalViewOf(document), roomId, (room) => ({
    ...room,
    backgroundAssetId: assetId,
  })));
}

export function addPhysicalRack(
  document: LabDocument,
  roomId: string,
  name: string,
  rackUnits = DEFAULT_RACK_UNITS,
): LabDocument {
  const layout = physicalViewOf(document);
  const found = findRoom(layout, roomId);
  if (!found) throw new PhysicalPlacementError(`Unknown room '${roomId}'.`);
  if (found.room.racks.length >= MAX_PHYSICAL_RACKS_PER_ROOM) {
    throw new PhysicalPlacementError(`A room may contain at most ${MAX_PHYSICAL_RACKS_PER_ROOM} racks.`);
  }
  const trimmed = name.trim();
  if (!trimmed) throw new PhysicalPlacementError("A rack needs a name.");
  const id = allocateId(
    "rack",
    layout.sites.flatMap((site) => site.rooms.flatMap((room) => room.racks.map((rack) => rack.id))),
  );
  const rack: PhysicalRack = {
    id,
    name: trimmed,
    rackUnits,
    position: { x: 40 + found.room.racks.length * (DEFAULT_RACK_WIDTH + 40), y: 40 },
    width: DEFAULT_RACK_WIDTH,
  };
  return withLayout(document, mapRoom(layout, roomId, (room) => ({ ...room, racks: [...room.racks, rack] })));
}

export function renamePhysicalRack(document: LabDocument, rackId: string, name: string): LabDocument {
  const trimmed = name.trim();
  if (!trimmed) return document;
  const layout = physicalViewOf(document);
  return withLayout(document, mapSites(layout, (site) => ({
    ...site,
    rooms: site.rooms.map((room) => ({
      ...room,
      racks: room.racks.map((rack) => rack.id === rackId ? { ...rack, name: trimmed } : rack),
    })),
  })));
}

/** Removing a rack returns the devices it held to Unplaced. */
export function removePhysicalRack(document: LabDocument, rackId: string): LabDocument {
  const layout = physicalViewOf(document);
  return withLayout(document, {
    sites: layout.sites.map((site) => ({
      ...site,
      rooms: site.rooms.map((room) => ({ ...room, racks: room.racks.filter((rack) => rack.id !== rackId) })),
    })),
    devicePlacements: layout.devicePlacements.filter((placement) => placement.rackId !== rackId),
  });
}

export function movePhysicalRack(
  document: LabDocument,
  rackId: string,
  position: { x: number; y: number },
): LabDocument {
  const layout = physicalViewOf(document);
  return withLayout(document, mapSites(layout, (site) => ({
    ...site,
    rooms: site.rooms.map((room) => ({
      ...room,
      racks: room.racks.map((rack) => rack.id === rackId ? { ...rack, position } : rack),
    })),
  })));
}

// --- device placement -----------------------------------------------------

export function placeDeviceInRack(
  document: LabDocument,
  deviceId: string,
  rackId: string,
  rackUnit: number,
  options: { rackUnitSpan?: number; orientation?: DevicePhysicalPlacement["orientation"] } = {},
): LabDocument {
  const layout = physicalViewOf(document);
  const rack = findRack(layout, rackId);
  if (!rack) throw new PhysicalPlacementError(`Unknown rack '${rackId}'.`);
  const location = locationOfRack(layout, rackId);
  if (!location) throw new PhysicalPlacementError(`Rack '${rackId}' is not in a room.`);
  const current = placementOf(layout, deviceId);
  const rackUnitSpan = clampSpan(options.rackUnitSpan ?? current?.rackUnitSpan ?? MIN_DEVICE_RACK_UNIT_SPAN);
  if (!rackUnitsAvailable(layout, rackId, rackUnit, rackUnitSpan, deviceId)) {
    throw new PhysicalPlacementError(
      `U${rackUnit} of ${rack.name} cannot hold ${rackUnitSpan} unit(s) — the slots are occupied or out of range.`,
    );
  }
  return withLayout(document, replacePlacement(layout, {
    deviceId,
    siteId: location.siteId,
    roomId: location.roomId,
    rackId,
    rackUnit,
    rackUnitSpan,
    orientation: options.orientation ?? current?.orientation,
  }));
}

/** Place a device loose in a room — a PC, laptop, smartphone or AP on a desk. */
export function placeDeviceInRoom(
  document: LabDocument,
  deviceId: string,
  roomId: string,
  position: { x: number; y: number },
): LabDocument {
  const layout = physicalViewOf(document);
  const found = findRoom(layout, roomId);
  if (!found) throw new PhysicalPlacementError(`Unknown room '${roomId}'.`);
  const current = placementOf(layout, deviceId);
  return withLayout(document, replacePlacement(layout, {
    deviceId,
    siteId: found.site.id,
    roomId,
    rackUnitSpan: current?.rackUnitSpan ?? MIN_DEVICE_RACK_UNIT_SPAN,
    x: position.x,
    y: position.y,
    orientation: current?.orientation,
  }));
}

/** Return a device to the Unplaced tray. Its network identity is untouched. */
export function unplaceDevice(document: LabDocument, deviceId: string): LabDocument {
  const layout = physicalViewOf(document);
  if (!placementOf(layout, deviceId)) return document;
  return withLayout(document, {
    ...layout,
    devicePlacements: layout.devicePlacements.filter((placement) => placement.deviceId !== deviceId),
  });
}

export function withDeviceRackUnitSpan(
  document: LabDocument,
  deviceId: string,
  rackUnitSpan: number,
): LabDocument {
  const layout = physicalViewOf(document);
  const current = placementOf(layout, deviceId);
  if (!current) return document;
  const span = clampSpan(rackUnitSpan);
  if (current.rackId !== undefined
    && current.rackUnit !== undefined
    && !rackUnitsAvailable(layout, current.rackId, current.rackUnit, span, deviceId)) {
    throw new PhysicalPlacementError(`${span} rack units do not fit below U${current.rackUnit}.`);
  }
  return withLayout(document, replacePlacement(layout, { ...current, rackUnitSpan: span }));
}

/**
 * Drop every placement of a device. Called when the device itself is deleted,
 * so a stale placement can never survive its device.
 */
export function withoutDevicePlacements(document: LabDocument, deviceId: string): LabDocument {
  const layout = document.physical;
  if (!layout?.devicePlacements.some((placement) => placement.deviceId === deviceId)) return document;
  return withLayout(document, {
    ...layout,
    devicePlacements: layout.devicePlacements.filter((placement) => placement.deviceId !== deviceId),
  });
}

// --- connections overlay --------------------------------------------------

export interface PhysicalConnectionOverlay {
  /** Links whose two endpoints are both placed in the room being viewed. */
  inRoom: Array<{ linkId: string; a: string; b: string }>;
  /** Links leaving the room; summarized rather than drawn as a cable route. */
  offRoom: Array<{ linkId: string; deviceId: string; peerDeviceId: string; peerLocation: string }>;
}

/**
 * Derive the connection overlay for one room from the *logical* links. It is a
 * read-only projection: no physical connection exists as its own object and
 * `topology.links` is never modified.
 */
export function physicalConnectionOverlay(
  document: LabDocument,
  roomId: string,
): PhysicalConnectionOverlay {
  const layout = physicalViewOf(document);
  const placements = new Map(layout.devicePlacements.map((placement) => [placement.deviceId, placement]));
  const roomNames = new Map(layout.sites.flatMap((site) => site.rooms.map((room) => [room.id, room.name] as const)));
  const inRoom: PhysicalConnectionOverlay["inRoom"] = [];
  const offRoom: PhysicalConnectionOverlay["offRoom"] = [];
  for (const link of document.topology.links) {
    const a = placements.get(link.a.node);
    const b = placements.get(link.b.node);
    if (a?.roomId === roomId && b?.roomId === roomId) {
      inRoom.push({ linkId: link.id, a: link.a.node, b: link.b.node });
      continue;
    }
    for (const [near, far] of [[a, b], [b, a]] as const) {
      if (near?.roomId !== roomId) continue;
      const peerDeviceId = near === a ? link.b.node : link.a.node;
      offRoom.push({
        linkId: link.id,
        deviceId: near.deviceId,
        peerDeviceId,
        peerLocation: far ? roomNames.get(far.roomId) ?? far.roomId : "Unplaced",
      });
    }
  }
  return { inRoom, offRoom };
}

function locationOfRack(
  layout: LabPhysicalLayout,
  rackId: string,
): { siteId: string; roomId: string } | undefined {
  for (const site of layout.sites) {
    for (const room of site.rooms) {
      if (room.racks.some((rack) => rack.id === rackId)) return { siteId: site.id, roomId: room.id };
    }
  }
  return undefined;
}

function clampSpan(span: number): number {
  if (!Number.isInteger(span)) return MIN_DEVICE_RACK_UNIT_SPAN;
  return Math.min(MAX_DEVICE_RACK_UNIT_SPAN, Math.max(MIN_DEVICE_RACK_UNIT_SPAN, span));
}
