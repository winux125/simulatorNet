import { z } from "zod";

/**
 * Serializable *physical placement* metadata: which site, room and rack a device
 * is drawn in.
 *
 * This is presentation only, exactly like canvas positions and diagram
 * annotations. Nothing here may reach the data plane: it never changes a
 * DeviceType, an interface, a link, routing, wireless reachability, latency,
 * QoS or grading, and it never triggers a runtime rebuild. It deliberately
 * models no power, cooling, weight, physical dimension, cable length, patch
 * panel or PDU, so the workspace never shows an invented value.
 */

export const MAX_PHYSICAL_SITES = 16;
export const MAX_PHYSICAL_ROOMS_PER_SITE = 32;
export const MAX_PHYSICAL_RACKS_PER_ROOM = 32;
export const MAX_PHYSICAL_PLACEMENTS = 2_000;

export const MIN_RACK_UNITS = 1;
export const MAX_RACK_UNITS = 60;
export const DEFAULT_RACK_UNITS = 42;
/** A device may span 1-4 rack units. This is drawing height, not a hardware claim. */
export const MIN_DEVICE_RACK_UNIT_SPAN = 1;
export const MAX_DEVICE_RACK_UNIT_SPAN = 4;
export const DEFAULT_RACK_WIDTH = 240;

export const PhysicalPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
export type PhysicalPoint = z.infer<typeof PhysicalPointSchema>;

/** Which face the device is drawn on. Purely a label; no airflow is modelled. */
export const PhysicalOrientationSchema = z.enum(["front", "rear"]);
export type PhysicalOrientation = z.infer<typeof PhysicalOrientationSchema>;

export const PhysicalRackSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /** Number of drawn U slots, numbered 1..rackUnits from the top. */
  rackUnits: z.number().int().min(MIN_RACK_UNITS).max(MAX_RACK_UNITS).default(DEFAULT_RACK_UNITS),
  position: PhysicalPointSchema,
  width: z.number().min(80).max(1_200).default(DEFAULT_RACK_WIDTH),
  /** Drawn height; omitted means "derive it from rackUnits". */
  height: z.number().min(80).max(4_000).optional(),
}).strict();
export type PhysicalRack = z.infer<typeof PhysicalRackSchema>;

export const PhysicalRoomSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  /**
   * Optional floor plan, referencing an id in `diagram.assets` so background
   * images reuse the diagram editor's validated PNG/JPEG/WebP asset rules —
   * no SVG, no remote URL, no executable content, one shared size budget.
   */
  backgroundAssetId: z.string().min(1).max(64).optional(),
  racks: z.array(PhysicalRackSchema).max(MAX_PHYSICAL_RACKS_PER_ROOM).default([]),
}).strict();
export type PhysicalRoom = z.infer<typeof PhysicalRoomSchema>;

export const PhysicalSiteSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  rooms: z.array(PhysicalRoomSchema).max(MAX_PHYSICAL_ROOMS_PER_SITE).default([]),
}).strict();
export type PhysicalSite = z.infer<typeof PhysicalSiteSchema>;

/**
 * Where one device is drawn. A rack-mounted device carries `rackId` plus its
 * starting `rackUnit`; a free-placed device carries `x`/`y` inside the room.
 * A device with no placement at all is simply "Unplaced", which is a normal
 * state and never blocks Start Lab.
 */
export const DevicePhysicalPlacementSchema = z.object({
  deviceId: z.string().min(1).max(64),
  siteId: z.string().min(1).max(64),
  roomId: z.string().min(1).max(64),
  rackId: z.string().min(1).max(64).optional(),
  /** 1-based U of the topmost occupied slot. Required with `rackId`. */
  rackUnit: z.number().int().min(1).max(MAX_RACK_UNITS).optional(),
  rackUnitSpan: z.number().int()
    .min(MIN_DEVICE_RACK_UNIT_SPAN)
    .max(MAX_DEVICE_RACK_UNIT_SPAN)
    .default(MIN_DEVICE_RACK_UNIT_SPAN),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  orientation: PhysicalOrientationSchema.optional(),
}).strict();
export type DevicePhysicalPlacement = z.infer<typeof DevicePhysicalPlacementSchema>;

export const LabPhysicalLayoutSchema = z.object({
  sites: z.array(PhysicalSiteSchema).max(MAX_PHYSICAL_SITES).default([]),
  devicePlacements: z.array(DevicePhysicalPlacementSchema).max(MAX_PHYSICAL_PLACEMENTS).default([]),
}).strict();
export type LabPhysicalLayout = z.infer<typeof LabPhysicalLayoutSchema>;

/** Absent-equivalent, so an untouched lab round-trips without a `physical` block. */
export function isDefaultPhysicalLayout(layout: LabPhysicalLayout | undefined): boolean {
  if (!layout) return true;
  return layout.sites.length === 0 && layout.devicePlacements.length === 0;
}

/** The last U a placement occupies, inclusive. */
export function placementLastRackUnit(placement: DevicePhysicalPlacement): number {
  return (placement.rackUnit ?? 1) + placement.rackUnitSpan - 1;
}
