// @vitest-environment node
/** PT41 — the draw tool's check agrees with the API's rules. */
import { describe, expect, it } from 'vitest';
import { geometryProblem } from './geometryCheck';

const poly = (ring: number[][]) => ({ type: 'Polygon' as const, coordinates: [ring] });
const SQUARE = [[150, -26], [150.01, -26], [150.01, -26.01], [150, -26.01], [150, -26]];

describe('geometryProblem', () => {
  it('passes real shapes', () => {
    expect(geometryProblem({ type: 'Point', coordinates: [150, -26] })).toBeNull();
    expect(geometryProblem({ type: 'LineString', coordinates: [[150, -26], [150.1, -26]] })).toBeNull();
    expect(geometryProblem(poly(SQUARE))).toBeNull();
  });

  it.each([
    ['two-point polygon (the PT35 probe)', poly([[0, 0], [1, 1]]), /3 different corners/],
    ['collinear polygon', poly([[150, -26], [150.01, -26], [150.02, -26], [150, -26]]), /enclose an area/],
    ['unclosed polygon', poly([[150, -26], [150.01, -26], [150.01, -26.01], [150, -26.01]]), /closed/],
    ['one-point line', { type: 'LineString' as const, coordinates: [[150, -26], [150, -26]] }, /2 different points/],
    ['point off the planet', { type: 'Point' as const, coordinates: [200, -26] }, /not a valid position/],
    ['nothing', null, /Nothing was drawn/],
  ])('refuses %s', (_l, g, why) => {
    expect(geometryProblem(g)).toMatch(why);
  });
});

// PT41 review: shapes the app itself produces must pass.
import { circleRing } from './circleMode';
import { normaliseLongitudes, wrapLng } from './geometryCheck';

describe('shapes the app produces', () => {
  it.each([
    [0, 0],
    [150.123, -26.456],
    [0.000001, -0.000001],
  ])('a circle drawn at (%f, %f) is closed and valid', (lng, lat) => {
    const ring = circleRing([lng, lat], 120);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(geometryProblem({ type: 'Polygon', coordinates: [ring] })).toBeNull();
  });

  it('a 1 m² paddock near lng 150 is not mistaken for a line', () => {
    const d = 0.00001; // ~1 m
    expect(geometryProblem(poly([[150, -26], [150 + d, -26], [150 + d, -26 + d], [150, -26]]))).toBeNull();
  });

  it('longitudes from a panned-onto world copy are wrapped back into range', () => {
    expect(wrapLng(510)).toBe(150);
    expect(wrapLng(-210)).toBe(150);
    expect(wrapLng(150)).toBe(150);
    const g = normaliseLongitudes({ type: 'LineString', coordinates: [[510, -26], [510.1, -26]] });
    expect((g.coordinates as number[][])[0]![0]).toBeCloseTo(150, 9);
    expect(geometryProblem(g)).toBeNull();
  });
});
