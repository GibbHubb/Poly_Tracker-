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
