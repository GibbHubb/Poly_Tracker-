import type { GeoJsonFeature, GeoJsonFeatureCollection } from './api';

export type FeatureKind = 'paddock' | 'polyRun' | 'feature';

/** Merge all three collections into one FeatureCollection, tagging each feature with `_kind`. */
export function mergeFarmGeoJson(
  farmName: string,
  paddocks: GeoJsonFeatureCollection,
  polyRuns: GeoJsonFeatureCollection,
  features: GeoJsonFeatureCollection,
): { geojson: string; filename: string } {
  const tagged = (coll: GeoJsonFeatureCollection, kind: FeatureKind): GeoJsonFeature[] =>
    coll.features.map((f) => ({
      ...f,
      properties: { ...f.properties, _kind: kind },
    }));

  const merged: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: [
      ...tagged(paddocks, 'paddock'),
      ...tagged(polyRuns, 'polyRun'),
      ...tagged(features, 'feature'),
    ],
  };

  return {
    geojson: JSON.stringify(merged, null, 2),
    filename: `${slugify(farmName)}.geojson`,
  };
}

/** Export Point features to a CSV with columns: name,type,lat,lng,notes */
export function pointsToCsv(
  farmName: string,
  features: GeoJsonFeatureCollection,
): { csv: string; filename: string } {
  const BOM = '﻿';
  const header = 'name,type,lat,lng,notes';
  const rows: string[] = [header];

  for (const f of features.features) {
    if (f.geometry?.type !== 'Point') continue;
    const coords = f.geometry.coordinates as [number, number];
    const lng = coords[0];
    const lat = coords[1];
    const p = f.properties;
    rows.push(
      [
        csvEscape(String(p.name ?? '')),
        csvEscape(String(p.type ?? '')),
        String(lat ?? ''),
        String(lng ?? ''),
        csvEscape(String(p.notes ?? '')),
      ].join(','),
    );
  }

  return {
    csv: BOM + rows.join('\r\n'),
    filename: `${slugify(farmName)}_points.csv`,
  };
}

/** Trigger a client-side file download via a temporary object URL. */
export function downloadBlob(filename: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function slugify(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '_') || 'farm';
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
