import type { GeoJsonFeature, GeoJsonFeatureCollection } from './api';

export type ImportKind = 'paddock' | 'polyRun' | 'feature';

export interface ImportPlan {
  paddocks: GeoJsonFeature[];
  polyRuns: GeoJsonFeature[];
  features: GeoJsonFeature[];
  skipped: number;
}

/** Parse uploaded file text. Throws a descriptive string on invalid input. */
export function parseImport(text: string): GeoJsonFeatureCollection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>).type !== 'FeatureCollection' ||
    !Array.isArray((parsed as Record<string, unknown>).features)
  ) {
    throw new Error('File must be a GeoJSON FeatureCollection.');
  }
  return parsed as GeoJsonFeatureCollection;
}

/** Route features by geometry type and build a dry-run plan. */
export function buildImportPlan(fc: GeoJsonFeatureCollection): ImportPlan {
  const plan: ImportPlan = { paddocks: [], polyRuns: [], features: [], skipped: 0 };

  for (const f of fc.features) {
    const kind = routeByGeometry(f.geometry);
    if (!kind) {
      plan.skipped++;
      continue;
    }
    // Strip server-managed keys before queuing.
    const clean: GeoJsonFeature = {
      type: 'Feature',
      geometry: f.geometry,
      properties: stripServerKeys(f.properties ?? {}),
    };
    plan[kind === 'paddock' ? 'paddocks' : kind === 'polyRun' ? 'polyRuns' : 'features'].push(clean);
  }

  return plan;
}

function routeByGeometry(
  geometry: GeoJsonFeature['geometry'] | null | undefined,
): ImportKind | null {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return 'paddock';
  if (geometry.type === 'LineString') return 'polyRun';
  if (geometry.type === 'Point') return 'feature';
  return null; // Multi*, GeometryCollection, etc.
}

function stripServerKeys(props: Record<string, unknown>): Record<string, unknown> {
  const { id, _kind, length_m, area_m2, ...rest } = props as Record<string, unknown>;
  void id; void _kind; void length_m; void area_m2;
  return rest;
}
