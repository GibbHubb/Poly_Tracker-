// @vitest-environment node
/** PT36 — every branch of PT18's field-level merge (conflictMerge.test.ts covers bookkeeping). */
import { describe, expect, it } from 'vitest';
import { buildMergedPatch, deriveRecordUrl, diffFields, GEOMETRY_FIELD } from './conflictMerge';

const pt = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] });

describe('deriveRecordUrl', () => {
  it('only a PATCH has a server record to diff against', () => {
    expect(deriveRecordUrl('/farms/f/paddocks/p', 'PATCH')).toBe('/farms/f/paddocks/p');
    expect(deriveRecordUrl('/farms/f/paddocks', 'POST')).toBeNull();
    expect(deriveRecordUrl('/farms/f/paddocks/p', 'DELETE')).toBeNull();
  });
});

describe('diffFields', () => {
  it('reports a property only one side has, and one both have with different values', () => {
    const d = diffFields(
      { properties: { name: 'mine', notes: 'only mine' } },
      { properties: { name: 'theirs', color: '#fff' } },
    );
    expect(d.map((x) => x.field).sort()).toEqual(['color', 'name', 'notes']);
  });

  it('treats missing and null the same, and equal values as no diff', () => {
    expect(diffFields({ properties: { notes: null, name: 'a' } }, { properties: { name: 'a' } })).toEqual([]);
  });

  it('copes with null/absent property bags', () => {
    expect(diffFields({ properties: null }, {})).toEqual([]);
  });

  it('geometry: a sub-1e-7 coordinate wobble is not a diff, a real move is', () => {
    expect(diffFields({ geometry: pt(150.00000001, -26) }, { geometry: pt(150, -26) })).toEqual([]);
    const d = diffFields({ geometry: pt(150.1, -26) }, { geometry: pt(150, -26) });
    expect(d).toEqual([{ field: GEOMETRY_FIELD, mine: pt(150.1, -26), server: pt(150, -26) }]);
  });

  it('geometry: no geometry in MY edit means geometry is not in question', () => {
    expect(diffFields({ properties: {} }, { geometry: pt(1, 1) })).toEqual([]);
    expect(diffFields({ geometry: null }, { geometry: pt(1, 1) })).toEqual([]);
  });

  it('geometry: mine vs a server row with none is a diff', () => {
    expect(diffFields({ geometry: pt(1, 1) }, { geometry: null })).toHaveLength(1);
  });
});

describe('buildMergedPatch', () => {
  it('keeps mine by default, takes the server value for chosen fields', () => {
    const p = buildMergedPatch(
      { properties: { name: 'mine', notes: 'mine' } },
      { properties: { name: 'theirs', notes: 'theirs' } },
      new Set(['notes']),
    );
    expect(p.properties).toEqual({ name: 'mine', notes: 'theirs' });
  });

  it('coerces a numeric string from the server back to a number when mine was a number', () => {
    const p = buildMergedPatch(
      { properties: { diameter_mm: 50, depth_m: 'deep' } },
      { properties: { diameter_mm: '63', depth_m: '0.6' } },
      new Set(['diameter_mm', 'depth_m']),
    );
    expect(p.properties).toEqual({ diameter_mm: 63, depth_m: '0.6' });
  });

  it('sends my geometry unless the server geometry was chosen', () => {
    const mine = { properties: {}, geometry: pt(2, 2) };
    expect(buildMergedPatch(mine, { geometry: pt(1, 1) }, new Set()).geometry).toEqual(pt(2, 2));
    expect(buildMergedPatch(mine, { geometry: pt(1, 1) }, new Set([GEOMETRY_FIELD])).geometry).toBeUndefined();
    expect(buildMergedPatch({ properties: {} }, {}, new Set()).geometry).toBeUndefined();
  });

  it('keepServer on a geometry field never writes it into properties', () => {
    const p = buildMergedPatch({ properties: { name: 'a' } }, { properties: {} }, new Set([GEOMETRY_FIELD]));
    expect(p.properties).toEqual({ name: 'a' });
  });
});
