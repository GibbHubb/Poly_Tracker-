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
