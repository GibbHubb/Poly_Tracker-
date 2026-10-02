// @vitest-environment node
/** PT36 — the pure helpers: geometry, units, GeoJSON import/export round trip. */
import { describe, expect, it } from 'vitest';
import type { GeoJsonFeature, GeoJsonFeatureCollection } from './api';
import { geometryCoords, toSource } from './geo';
import { formatArea, formatLength } from './units';
import { buildImportPlan, parseImport } from './importData';
import { mergeFarmGeoJson, pointsToCsv } from './exportData';

const fc = (...features: GeoJsonFeature[]): GeoJsonFeatureCollection => ({ type: 'FeatureCollection', features });
const point = (name: string, c: [number, number] = [150.1, -26.5], extra: Record<string, unknown> = {}): GeoJsonFeature => ({
  type: 'Feature',
  id: `id-${name}`,
  geometry: { type: 'Point', coordinates: c },
  properties: { name, type: 'trough', ...extra },
});
const line: GeoJsonFeature = {
  type: 'Feature',
  id: 'l1',
  geometry: { type: 'LineString', coordinates: [[150, -26], [150.1, -26.1]] },
  properties: { name: 'Bore line', length_m: 1234 },
};
const poly: GeoJsonFeature = {
  type: 'Feature',
  id: 'p1',
  geometry: { type: 'Polygon', coordinates: [[[150, -26], [150.1, -26], [150.1, -26.1], [150, -26]]] },
  properties: { name: 'River paddock', area_m2: 50000 },
};

describe('geo', () => {
  it('geometryCoords flattens every supported type and returns [] for null', () => {
    expect(geometryCoords(point('a').geometry)).toEqual([[150.1, -26.5]]);
    expect(geometryCoords(line.geometry)).toHaveLength(2);
    expect(geometryCoords(poly.geometry)).toHaveLength(4);
    expect(geometryCoords(null)).toEqual([]);
  });

  it('toSource drops null-geometry rows (they cannot render) and keeps the rest', () => {
    const out = toSource(fc(point('a'), { type: 'Feature', geometry: null, properties: { name: 'ghost' } }, line));
    expect(out.features).toHaveLength(2);
    expect(out.features.map((f) => f.properties?.name)).toEqual(['a', 'Bore line']);
  });
});

describe('units', () => {
  it.each([
    [840, '840 m'],
    [999.4, '999 m'],
    [1000, '1.00 km'],
    ['1240', '1.24 km'],
    [null, ''],
    ['', ''],
    ['abc', ''],
  ])('formatLength(%j) = %j', (input, out) => expect(formatLength(input)).toBe(out));

  it.each([
    [850, '850 m²'],
    [10000, '1.00 ha'],
    ['124000', '12.40 ha'],
    [undefined, ''],
    [Number.NaN, ''],
  ])('formatArea(%j) = %j', (input, out) => expect(formatArea(input)).toBe(out));
});

describe('importData', () => {
  it('parseImport refuses non-JSON and non-FeatureCollections with a readable message', () => {
    expect(() => parseImport('{nope')).toThrow('File is not valid JSON.');
    expect(() => parseImport('{"type":"Feature"}')).toThrow('File must be a GeoJSON FeatureCollection.');
    expect(() => parseImport('{"type":"FeatureCollection","features":{}}')).toThrow(/FeatureCollection/);
  });

  it('buildImportPlan routes by geometry, skips the unsupported, strips server keys', () => {
    const multi = { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [] }, properties: {} } as unknown as GeoJsonFeature;
    const plan = buildImportPlan(
      fc(poly, line, point('t', undefined, { _kind: 'feature', id: 'server-id' }), multi, {
        type: 'Feature',
        geometry: null,
        properties: {},
      }),
    );
    expect(plan.paddocks).toHaveLength(1);
    expect(plan.polyRuns).toHaveLength(1);
    expect(plan.features).toHaveLength(1);
    expect(plan.skipped).toBe(2);
    expect(plan.paddocks[0]!.properties).toEqual({ name: 'River paddock' }); // area_m2 stripped
    expect(plan.polyRuns[0]!.properties).toEqual({ name: 'Bore line' }); // length_m stripped
    expect(plan.features[0]!.properties).toEqual({ name: 't', type: 'trough' });
    expect(plan.features[0]!.id).toBeUndefined();
  });

  it('export → import round trip keeps every feature and its user properties', () => {
    const { geojson, filename } = mergeFarmGeoJson('Smith Station #2', fc(poly), fc(line), fc(point('a'), point('b')));
    expect(filename).toMatch(/\.geojson$/);
    const plan = buildImportPlan(parseImport(geojson));
    expect([plan.paddocks.length, plan.polyRuns.length, plan.features.length, plan.skipped]).toEqual([1, 1, 2, 0]);
    expect(plan.features.map((f) => f.properties.name)).toEqual(['a', 'b']);
    // _kind is an export tag, not a property to write back
    expect(JSON.stringify(plan)).not.toContain('_kind');
  });
});

describe('exportData.pointsToCsv', () => {
  it('writes name,type,lat,lng,notes for points only, escaping commas and quotes', () => {
    const { csv } = pointsToCsv('x', fc(point('Trough, "north"', [150.5, -26.25], { notes: 'line1\nline2' }), line as GeoJsonFeature));
    const rows = csv.replace(/^﻿/, '').split('\r\n');
    expect(rows[0]).toBe('name,type,lat,lng,notes');
    expect(rows).toHaveLength(2); // the line is not a point
    expect(rows[1]).toContain('"Trough, ""north"""');
    expect(rows[1]).toContain('-26.25,150.5');
  });
});
