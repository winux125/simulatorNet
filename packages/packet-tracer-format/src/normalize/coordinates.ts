/**
 * Canvas-coordinate normalization.
 *
 * Packet Tracer's logical canvas is much larger than a typical SimulatorNet
 * viewport and places devices anywhere in it, including far-flung ones — a
 * Power Distribution Device sits near (3900, 3900) in an otherwise 200-500
 * range lab. Importing raw coordinates would open a lab that looks empty.
 *
 * The transform is therefore: translate so the tightest bounding box starts at
 * a margin, then scale down only if the box is wider than the target canvas.
 * It never scales *up*, so a small lab keeps its real proportions, and it is
 * deterministic, so the same file always lands in the same place. Relative
 * placement is preserved exactly — this is a similarity transform, not a
 * re-layout.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface CoordinateTransformOptions {
  /** Largest width/height the imported topology should occupy. */
  readonly maxExtent?: number;
  /** Offset applied after translation, so nothing sits against the edge. */
  readonly margin?: number;
}

const DEFAULT_MAX_EXTENT = 1_600;
const DEFAULT_MARGIN = 80;

/** Packet Tracer coordinates beyond this are treated as unusable. */
const COORDINATE_BOUND = 1_000_000;

const isUsable = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && Math.abs(value) <= COORDINATE_BOUND;

export interface NormalizedCoordinates {
  /** Same order as the input; undefined where the source had no usable point. */
  readonly points: readonly (Point | undefined)[];
  /** True when the source supplied no usable coordinates at all. */
  readonly empty: boolean;
  readonly scale: number;
}

/**
 * Normalize a set of Packet Tracer positions into SimulatorNet canvas space.
 * Returns `empty` when the file carried no usable coordinates, which is the
 * caller's signal to fall back to the existing automatic layout rather than
 * piling every device at the origin.
 */
export function normalizeCoordinates(
  source: readonly ({ readonly x?: number; readonly y?: number } | undefined)[],
  options: CoordinateTransformOptions = {},
): NormalizedCoordinates {
  const maxExtent = options.maxExtent ?? DEFAULT_MAX_EXTENT;
  const margin = options.margin ?? DEFAULT_MARGIN;

  const usable = source.map((entry) =>
    entry !== undefined && isUsable(entry.x) && isUsable(entry.y)
      ? { x: entry.x, y: entry.y }
      : undefined,
  );
  const present = usable.filter((point): point is Point => point !== undefined);
  if (present.length === 0) {
    return { points: source.map(() => undefined), empty: true, scale: 1 };
  }

  const minX = Math.min(...present.map((point) => point.x));
  const minY = Math.min(...present.map((point) => point.y));
  const maxX = Math.max(...present.map((point) => point.x));
  const maxY = Math.max(...present.map((point) => point.y));
  const width = maxX - minX;
  const height = maxY - minY;
  const extent = Math.max(width, height);

  // Only ever shrink: scaling a compact lab up would exaggerate spacing that
  // the author chose deliberately.
  const scale = extent > maxExtent && extent > 0 ? maxExtent / extent : 1;

  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    points: usable.map((point) =>
      point === undefined
        ? undefined
        : { x: round((point.x - minX) * scale + margin), y: round((point.y - minY) * scale + margin) },
    ),
    empty: false,
    scale,
  };
}
