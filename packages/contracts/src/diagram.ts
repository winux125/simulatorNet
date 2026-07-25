import { z } from "zod";

export const MAX_DIAGRAM_ASSET_BYTES = 2 * 1_024 * 1_024;
export const MAX_DIAGRAM_ASSET_TOTAL_BYTES = 8 * 1_024 * 1_024;
export const MAX_DIAGRAM_ASSETS = 20;
export const MAX_DIAGRAM_ASSET_DIMENSION = 4_096;
export const MIN_DIAGRAM_ASSET_DIMENSION = 1;
/** Includes base64 expansion plus the rest of the academic request envelope. */
export const MAX_DIAGRAM_DOCUMENT_JSON_BYTES = 12 * 1_024 * 1_024;

export const DiagramPointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
}).strict();
export type DiagramPoint = z.infer<typeof DiagramPointSchema>;

export const DiagramColorSchema = z.union([
  z.string().regex(/^#[0-9a-f]{6}$/i, "Diagram colors must use six-digit hexadecimal notation"),
  z.literal("transparent"),
]);
export type DiagramColor = z.infer<typeof DiagramColorSchema>;

export const DiagramStrokeDashSchema = z.enum(["solid", "dashed", "dotted"]);
export type DiagramStrokeDash = z.infer<typeof DiagramStrokeDashSchema>;

export const DiagramLineMarkerSchema = z.enum(["none", "arrow", "circle", "diamond"]);
export type DiagramLineMarker = z.infer<typeof DiagramLineMarkerSchema>;

const DiagramBaseSchema = z.object({
  id: z.string().min(1),
  zIndex: z.number().int().default(0),
  rotation: z.number().finite().default(0),
  locked: z.boolean().optional(),
});

export const TextDiagramAnnotationSchema = DiagramBaseSchema.extend({
  type: z.literal("text"),
  position: DiagramPointSchema,
  width: z.number().positive().default(180),
  height: z.number().positive().optional(),
  autoHeight: z.boolean().optional(),
  content: z.string().max(4_096),
  fontSize: z.number().min(8).max(72).default(16),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  alignment: z.enum(["left", "center", "right"]).default("left"),
  foreground: z.union([DiagramColorSchema, z.literal("auto")]).default("#203247"),
  background: DiagramColorSchema.optional(),
  border: DiagramColorSchema.optional(),
  borderWidth: z.number().min(0).max(12).optional(),
  opacity: z.number().min(0.05).max(1).optional(),
}).strict();

const ShapeDiagramAnnotationBaseSchema = DiagramBaseSchema.extend({
  position: DiagramPointSchema,
  width: z.number().positive().default(180),
  height: z.number().positive().default(100),
  fill: DiagramColorSchema.optional(),
  stroke: DiagramColorSchema.default("#4d7fa9"),
  strokeWidth: z.number().min(0.5).max(12).default(1.5),
  strokeDash: DiagramStrokeDashSchema.optional(),
  opacity: z.number().min(0.05).max(1).optional(),
}).strict();

export const RectangleDiagramAnnotationSchema = ShapeDiagramAnnotationBaseSchema.extend({
  type: z.literal("rectangle"),
  radius: z.number().min(0).max(200).optional(),
}).strict();

export const EllipseDiagramAnnotationSchema = ShapeDiagramAnnotationBaseSchema.extend({
  type: z.literal("ellipse"),
}).strict();

const LineDiagramAnnotationBaseSchema = DiagramBaseSchema.omit({ rotation: true }).extend({
  start: DiagramPointSchema,
  end: DiagramPointSchema,
  bend: DiagramPointSchema.optional(),
  stroke: DiagramColorSchema.default("#4d7fa9"),
  strokeWidth: z.number().min(0.5).max(12).default(1.5),
  strokeDash: DiagramStrokeDashSchema.optional(),
  startMarker: DiagramLineMarkerSchema.optional(),
  endMarker: DiagramLineMarkerSchema.optional(),
  opacity: z.number().min(0.05).max(1).optional(),
  label: z.string().max(512).optional(),
}).strict();

export const LineDiagramAnnotationSchema = LineDiagramAnnotationBaseSchema.extend({
  type: z.literal("line"),
}).strict();

export const ArrowDiagramAnnotationSchema = LineDiagramAnnotationBaseSchema.extend({
  type: z.literal("arrow"),
  endMarker: DiagramLineMarkerSchema.optional(),
}).strict();

export const ImageDiagramAnnotationSchema = DiagramBaseSchema.extend({
  type: z.literal("image"),
  assetId: z.string().min(1),
  position: DiagramPointSchema,
  width: z.number().min(8).max(MAX_DIAGRAM_ASSET_DIMENSION),
  height: z.number().min(8).max(MAX_DIAGRAM_ASSET_DIMENSION),
  opacity: z.number().min(0.05).max(1).default(1),
  preserveAspectRatio: z.boolean().default(true),
  alt: z.string().max(512).optional(),
}).strict();

export const DiagramAnnotationSchema = z.discriminatedUnion("type", [
  TextDiagramAnnotationSchema,
  RectangleDiagramAnnotationSchema,
  EllipseDiagramAnnotationSchema,
  LineDiagramAnnotationSchema,
  ArrowDiagramAnnotationSchema,
  ImageDiagramAnnotationSchema,
]);
export type DiagramAnnotation = z.infer<typeof DiagramAnnotationSchema>;

export const DiagramAssetMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type DiagramAssetMime = z.infer<typeof DiagramAssetMimeSchema>;

export const DiagramAssetSchema = z.object({
  id: z.string().min(1),
  mime: DiagramAssetMimeSchema,
  originalName: z.string().min(1).max(255)
    .refine((value) => !/[\/\\\u0000-\u001f]/.test(value), "Image name must not contain paths or control characters"),
  dataBase64: z.string()
    .min(4)
    .max(Math.ceil(MAX_DIAGRAM_ASSET_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "Invalid base64 image data"),
  width: z.number().int().min(MIN_DIAGRAM_ASSET_DIMENSION).max(MAX_DIAGRAM_ASSET_DIMENSION),
  height: z.number().int().min(MIN_DIAGRAM_ASSET_DIMENSION).max(MAX_DIAGRAM_ASSET_DIMENSION),
}).strict();
export type DiagramAsset = z.infer<typeof DiagramAssetSchema>;

export const DiagramLinkLabelSchema = z.object({
  linkId: z.string().min(1),
  text: z.string().max(512),
  position: z.number().min(0).max(1).default(0.5),
  followLink: z.boolean().default(true),
  offset: z.number().finite().default(-12),
  visible: z.boolean().default(true),
}).strict();
export type DiagramLinkLabel = z.infer<typeof DiagramLinkLabelSchema>;

export const DiagramLinkRouteSchema = z.enum(["straight", "orthogonal"]);
export type DiagramLinkRoute = z.infer<typeof DiagramLinkRouteSchema>;

/**
 * Presentation-only route data for a physical topology link. Device and
 * interface identity remains in Topology.links; these values never affect
 * forwarding, grading, or verification.
 */
export const DiagramLinkStyleSchema = z.object({
  linkId: z.string().min(1),
  route: DiagramLinkRouteSchema.default("straight"),
  vertices: z.array(DiagramPointSchema).max(32).default([]),
}).strict();
export type DiagramLinkStyle = z.infer<typeof DiagramLinkStyleSchema>;

export const LabDiagramSchema = z.object({
  assets: z.array(DiagramAssetSchema).max(MAX_DIAGRAM_ASSETS).optional(),
  annotations: z.array(DiagramAnnotationSchema).default([]),
  linkLabels: z.array(DiagramLinkLabelSchema).default([]),
  linkStyles: z.array(DiagramLinkStyleSchema).max(2_000).default([]),
}).strict();
export type LabDiagram = z.infer<typeof LabDiagramSchema>;
