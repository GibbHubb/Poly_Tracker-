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
  .refine((r) => samePos(r[0]!, r[r.length - 1]!), { message: 'a polygon ring must be closed (first point = last point)' })
  .refine((r) => distinctCount(r) >= 3, { message: 'a polygon needs at least 3 different corners' });

export const polygonGeometry = z.object({
  type: z.literal('Polygon'),
  coordinates: z
    .array(ring)
    .min(1, 'a polygon needs an outer ring')
    .refine((rings) => ringArea(rings[0]!) > 1e-12, { message: 'a polygon must enclose an area (its corners are in a line)' }),
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
