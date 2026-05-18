import type { FeatureCollection, Geometry } from 'geojson';
import type { GeoJsonFeatureCollection, GeoJsonGeometry } from './api';

type LngLat = [number, number];

/**
 * Flatten any geometry to its coordinate pairs so callers can fit/centre
 * the map on a feature. Returns [] for null/empty geometry.
 */
export function geometryCoords(g: GeoJsonGeometry | null): LngLat[] {
  if (!g) return [];
  if (g.type === 'Point') return [g.coordinates as LngLat];
  if (g.type === 'LineString') return g.coordinates as LngLat[];
  if (g.type === 'Polygon') return (g.coordinates as LngLat[][]).flat();
  return [];
}

/**
 * Narrow our loose API collection (geometry may be null) to a strict GeoJSON
 * FeatureCollection for MapLibre sources. Null-geometry rows can't render and
 * are dropped. Runtime shape is already valid GeoJSON (from ST_AsGeoJSON).
 */
export function toSource(fc: GeoJsonFeatureCollection): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: fc.features
      .filter((f) => f.geometry !== null)
      .map((f) => ({
        type: 'Feature',
        geometry: f.geometry as Geometry,
        properties: f.properties,
      })),
  };
}
