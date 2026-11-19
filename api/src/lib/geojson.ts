import { z } from 'zod';

/**
 * Minimal GeoJSON geometry schema. We only accept the geometry types the
 * app draws (Point, LineString, Polygon). Coordinates are validated loosely
 * as nested number arrays — PostGIS does the authoritative validation via
 * ST_GeomFromGeoJSON.
 */
export const geometrySchema = z.object({
  type: z.enum(['Point', 'LineString', 'Polygon']),
  coordinates: z.any(),
});

export type Geometry = z.infer<typeof geometrySchema>;

// ---------------------------------------------------------------------------
// PT41 — per-kind geometry that is actually a shape.
//
// `geometrySchema` above checks only the type name; PostGIS then accepted a
// polygon of two points (`[[0,0],[1,1]]`) and stored it with area 0, and a
// paddock could be a Point. Each route now takes only its own kind, with rings
// and lines that can be drawn. Validation lives here so the import route
// reports the same reasons per row.
// ---------------------------------------------------------------------------

const position = z
  .tuple([z.number().finite(), z.number().finite()])
  .rest(z.number().finite())
  .refine(([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90, {
    message: 'coordinates must be [longitude, latitude] within -180..180 and -90..90',
  });
type Position = z.infer<typeof position>;

const samePos = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];
const distinctCount = (ps: Position[]) => new Set(ps.map((p) => `${p[0]},${p[1]}`)).size;

/**
 * Planar shoelace area in degrees²; only its being non-zero matters here.
 * Taken about the first corner: at lng ~150 the raw products carry ~1e-12 of
 * rounding noise, the same size as the threshold.
 */
function ringArea(ring: Position[]): number {
  const [x0, y0] = ring[0]!;
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += (ring[i]![0] - x0) * (ring[i + 1]![1] - y0) - (ring[i + 1]![0] - x0) * (ring[i]![1] - y0);
  }
  return Math.abs(a / 2);
}

// PT42 — a ring that crosses itself (a bow-tie) is not a paddock. Its shoelace area can be
// exactly 0, so without this it was refused for the wrong reason ("corners are in a line"),
// and any other crossing shape was stored. Mirrored in web/src/lib/geometryCheck.ts;
// both suites read fixtures/geometry-cases.json.
//
// PT45 — the pairwise check is O(n²) and runs synchronously inside request parsing, and
// express.json takes 5 MB (~150k positions), so one request could hold the event loop for
// minutes. Three changes, all mirrored in the client:
//   - a polygon may have at most MAX_POLYGON_POSITIONS positions across its rings, refused
//     BEFORE any ring is examined (fixtures/geometry-cases.json `limits` pins the number);
//   - the check runs once per ring (it ran in the ring refine AND the area refine);
//   - edges are compared only when their x-ranges overlap (sorted by min x), which gives the
//     same answer (two edges that touch share a point, so their x-ranges overlap) at a
//     fraction of the pairs for any real outline.

/**
 * PT45 — the most positions a polygon may carry, all rings together. Same number in the client.
 * 5,000, not 10,000: drawn paddocks are tens of corners (a drawn circle is 64) and imported ones
 * "tens to a few thousand", and the worst case is quadratic. Measured on a dev laptop (Node 22):
 * a 10,000-corner outline built so every edge's box overlaps every other took ~3.5 s; at 5,000,
 * ~0.9 s; a real (round) 10,000-corner outline ~0.25 s.
 */
export const MAX_POLYGON_POSITIONS = 5_000;

/**
 * PT44 review — the most rings (outer + holes) a polygon may carry. Same number in the client;
 * fixtures/geometry-cases.json `limits` pins both. The position cap counts positions, so 1.5M
 * EMPTY rings passed it, and parsing each one (and building two issues per ring) took ~11 s on
 * Node 22. Checked on the raw array before any ring is parsed: zod's `.max()` on z.array still
 * parses every element first, so it would not help.
 */
export const MAX_POLYGON_RINGS = 100;

function orient(a: Position, b: Position, c: Position): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** c lies within the bounding box of a–b (only asked when a, b, c are collinear). */
function within(a: Position, b: Position, c: Position): boolean {
  return (
    Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1])
  );
}

function segmentsTouch(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const o1 = orient(p1, p2, p3), o2 = orient(p1, p2, p4), o3 = orient(p3, p4, p1), o4 = orient(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  return (
    (o1 === 0 && within(p1, p2, p3)) || (o2 === 0 && within(p1, p2, p4)) ||
    (o3 === 0 && within(p3, p4, p1)) || (o4 === 0 && within(p3, p4, p2))
  );
}

/** True when two non-neighbouring edges of a closed ring touch or cross. */
function ringSelfIntersects(ring: Position[]): boolean {
  // A repeated corner makes a zero-length edge whose neighbours would look like they touch.
  const r = ring.filter((p, i) => i === 0 || !samePos(p, ring[i - 1]!));
  const n = Math.max(r.length - 1, 0); // edges r[i] → r[i+1]
  // Each edge's bounding box, and the edges in order of their left end: edge j can only touch
  // edge i if j starts (in x) no further right than i ends, and their y-ranges overlap.
  // (Flat typed arrays: the pair loop is the hot path, and it stays monomorphic.)
  const x0 = new Float64Array(n), x1 = new Float64Array(n), y0 = new Float64Array(n), y1 = new Float64Array(n);
  for (let e = 0; e < n; e++) {
    const [ax, ay] = r[e]!, [bx, by] = r[e + 1]!;
    x0[e] = Math.min(ax, bx); x1[e] = Math.max(ax, bx);
    y0[e] = Math.min(ay, by); y1[e] = Math.max(ay, by);
  }
  const order = Uint32Array.from({ length: n }, (_, e) => e).sort((a, b) => x0[a]! - x0[b]!);
  for (let a = 0; a < n; a++) {
    const i = order[a]!;
    const ix1 = x1[i]!, iy0 = y0[i]!, iy1 = y1[i]!;
    for (let b = a + 1; b < n; b++) {
      const j = order[b]!;
      if (x0[j]! > ix1) break; // every later edge starts further right still
      if (y1[j]! < iy0 || y0[j]! > iy1) continue;
      const lo = i < j ? i : j, hi = i < j ? j : i;
      if (hi - lo < 2) continue; // neighbours share a corner
      if (lo === 0 && hi === n - 1) continue; // first and last edge share the closing corner
      if (segmentsTouch(r[i]!, r[i + 1]!, r[j]!, r[j + 1]!)) return true;
    }
  }
  return false;
}

export const pointGeometry = z.object({
  type: z.literal('Point'),
  coordinates: position,
});

export const lineGeometry = z.object({
  type: z.literal('LineString'),
  coordinates: z
    .array(position)
    .min(2, 'a line needs at least 2 points')
    .refine((ps) => distinctCount(ps) >= 2, { message: 'a line needs 2 different points' }),
});

const ring = z
  .array(position)
  .min(4, 'a polygon ring needs at least 4 positions (3 corners + the closing point)')
  // `r.length === 0`: an empty ring has already failed min(4), and zod still runs refines on
  // it; r[0] would be undefined and the request a 500 instead of a 400.
  .refine((r) => r.length === 0 || samePos(r[0]!, r[r.length - 1]!), {
    message: 'a polygon ring must be closed (first point = last point)',
  })
  .refine((r) => distinctCount(r) >= 3, { message: 'a polygon needs at least 3 different corners' });

const tooManyPositions = `a polygon can have at most ${MAX_POLYGON_POSITIONS.toLocaleString('en-US')} positions`;
const tooManyRings = `a polygon can have at most ${MAX_POLYGON_RINGS} rings`;

export const polygonGeometry = z.object({
  type: z.literal('Polygon'),
  coordinates: z
    // PT44 review — ring count first, O(1) on the raw value. A refusal here is "dirty", so the
    // pipe below never parses a single ring. (Not an array: the pipe's z.array says so.)
    .unknown()
    .superRefine((v, ctx) => {
      if (Array.isArray(v) && v.length > MAX_POLYGON_RINGS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: tooManyRings });
      }
    })
    .pipe(
      // PT45 — then size, on the raw arrays: a refusal here is "dirty" too, and the pipe does
      // not run the per-position parse or the edge check on it at all.
      z
        .array(z.array(z.unknown()))
        .min(1, 'a polygon needs an outer ring')
        .refine((rings) => rings.reduce((sum, r) => sum + r.length, 0) <= MAX_POLYGON_POSITIONS, {
          message: tooManyPositions,
        })
        .pipe(
          z.array(ring).superRefine((rings, ctx) => {
            rings.forEach((r, i) => {
              if (r.length < 4) return; // already refused; nothing here can cross
              // PT45 — once per ring (this used to run in the ring refine and again for the area).
              if (ringSelfIntersects(r)) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i], message: 'a polygon outline must not cross itself' });
              } else if (i === 0 && ringArea(r) <= 1e-12) {
                // A crossing ring already has its reason; its area says nothing more.
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a polygon must enclose an area (its corners are in a line)' });
              }
            });
          }),
        ),
    ),
});

/** One-line, user-facing summary of a geometry/properties validation failure. */
export function describeZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Loose FeatureCollection schema for bulk import (PT19). Geometry is validated
 * only enough to route by type here (any geometry type is allowed through so
 * unsupported ones can be reported as "skipped" rather than rejecting the whole
 * file); per-feature properties are validated later with each kind's own schema.
 */
export const importFeatureSchema = z.object({
  type: z.literal('Feature').optional(),
  geometry: z
    .object({ type: z.string(), coordinates: z.any() })
    .nullable(),
  properties: z.record(z.unknown()).nullish(),
});

export const featureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(importFeatureSchema),
});

export type ImportFeature = z.infer<typeof importFeatureSchema>;

export interface GeoJsonFeature<P extends Record<string, unknown>> {
  type: 'Feature';
  id: string;
  geometry: Geometry | null;
  properties: P;
}

export interface GeoJsonFeatureCollection<P extends Record<string, unknown>> {
  type: 'FeatureCollection';
  features: GeoJsonFeature<P>[];
}

/**
 * Build a GeoJSON Feature from a DB row that has an `id`, a `geojson` text
 * column (produced by ST_AsGeoJSON), and arbitrary other property columns.
 */
export function rowToFeature<R extends { id: string; geojson: string | null }>(
  row: R,
): GeoJsonFeature<Record<string, unknown>> {
  const { id, geojson, ...properties } = row;
  return {
    type: 'Feature',
    id,
    geometry: geojson ? (JSON.parse(geojson) as Geometry) : null,
    properties: properties as Record<string, unknown>,
  };
}

export function rowsToCollection<R extends { id: string; geojson: string | null }>(
  rows: R[],
): GeoJsonFeatureCollection<Record<string, unknown>> {
  return { type: 'FeatureCollection', features: rows.map(rowToFeature) };
}

/**
 * PT31 — optional `?bbox=west,south,east,north` query param shared by the
 * three list routes (features/paddocks/poly_runs).
 *
 * Absent bbox must be byte-identical to today's behaviour (PT31 acceptance
 * criterion), so this stays a plain string→array parse: `z.coerce.number()`
 * would turn `?bbox=` (present, empty) into `[NaN,NaN,NaN,NaN]` instead of
 * "not provided", and the caller needs to tell those two apart.
 *
 * Malformed input (wrong count, non-finite number, or west/south not less
 * than east/north) throws a ZodError, which the app's error handler already
 * turns into a 400 `ValidationError` — never a 500, never a silent full scan.
 */
export const bboxSchema = z
  .string()
  .transform((raw, ctx) => {
    const parts = raw.split(',').map((p) => Number(p.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox must be "west,south,east,north" — four finite numbers',
      });
      return z.NEVER;
    }
    const [west, south, east, north] = parts as [number, number, number, number];
    if (west >= east || south >= north) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bbox must have west < east and south < north',
      });
      return z.NEVER;
    }
    return { west, south, east, north };
  })
  .optional();

export type Bbox = { west: number; south: number; east: number; north: number };

/**
 * SQL fragment + full params array for an `ST_Intersects` predicate against a
 * bbox envelope, answered directly by the existing GIST index on `geom`.
 * Returns the base params UNCHANGED, with '' as the sql fragment, when `bbox`
 * is undefined — so absent-bbox callers get exactly today's query.
 *
 * Takes the base params (everything the route already bound, e.g. `[farmId]`)
 * rather than a bare index: the $N placeholders are derived from
 * `baseParams.length`, so a route that later adds another bound filter before
 * the bbox predicate can't desync the two without ALSO changing this call
 * (code-review finding, PT31 — a hardcoded index here silently mis-binds the
 * moment a route's placeholder count changes).
 */
export function bboxPredicate(
  bbox: Bbox | undefined,
  geomColumn: string,
  baseParams: unknown[],
): { sql: string; params: unknown[] } {
  if (!bbox) return { sql: '', params: baseParams };
  const i = baseParams.length + 1;
  return {
    sql: ` AND ST_Intersects(${geomColumn}, ST_MakeEnvelope($${i},$${i + 1},$${i + 2},$${i + 3}, 4326))`,
    params: [...baseParams, bbox.west, bbox.south, bbox.east, bbox.north],
  };
}
