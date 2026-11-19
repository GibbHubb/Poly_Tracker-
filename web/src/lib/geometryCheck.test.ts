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

// PT42 — the shared fixtures the API suite reads too (fixtures/geometry-cases.json).
import type { GeoJsonGeometry } from './api';
import sharedFixtures from '../../../fixtures/geometry-cases.json';

interface SharedCase { name: string; reason: string | null; geometry: GeoJsonGeometry }
const shared = (sharedFixtures as unknown as { cases: SharedCase[] }).cases;
const limits = (sharedFixtures as unknown as { limits: { maxPolygonPositions: number; maxPolygonRings: number } }).limits;

describe('shared geometry fixtures (draw tool)', () => {
  it.each(shared.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const problem = geometryProblem(c.geometry);
    if (c.reason === null) expect(problem).toBeNull();
    else expect(problem).toMatch(new RegExp(c.reason, 'i'));
  });
});

// PT45 — the same size cap as the API, from the same shared number.
import { MAX_POLYGON_POSITIONS } from './geometryCheck';

describe('polygon size cap (PT45, draw tool)', () => {
  const circle = (n: number): GeoJsonGeometry => {
    const r: number[][] = [];
    for (let i = 0; i < n - 1; i++) {
      const t = (i / (n - 1)) * 2 * Math.PI;
      r.push([150 + 0.01 * Math.cos(t), -26 + 0.01 * Math.sin(t)]);
    }
    r.push(r[0]!);
    return { type: 'Polygon', coordinates: [r] };
  };

  it('uses the shared limit', () => {
    expect(MAX_POLYGON_POSITIONS).toBe(limits.maxPolygonPositions);
  });

  it('accepts a real outline of exactly the limit', () => {
    expect(geometryProblem(circle(limits.maxPolygonPositions))).toBeNull();
  });

  it('refuses one position over the limit, for its size', () => {
    expect(geometryProblem(circle(limits.maxPolygonPositions + 1))).toMatch(/at most 5,000/i);
  });

  it('refuses a 150,000-position ring quickly', () => {
    const t0 = performance.now();
    expect(geometryProblem(circle(150_000))).toMatch(/at most 5,000/i);
    expect(performance.now() - t0).toBeLessThan(2_000);
  }, 10_000);
});

// PT44 review — the same ring-count cap as the API, from the same shared number.
import { MAX_POLYGON_RINGS } from './geometryCheck';

describe('polygon ring-count cap (PT44 review, draw tool)', () => {
  it('uses the shared limit', () => {
    expect(MAX_POLYGON_RINGS).toBe(limits.maxPolygonRings);
  });

  it('does not refuse exactly the limit for its ring count', () => {
    const rings = Array.from({ length: limits.maxPolygonRings }, () => SQUARE);
    expect(geometryProblem({ type: 'Polygon', coordinates: rings })).toBeNull();
  });

  it('refuses one ring over the limit', () => {
    const rings = Array.from({ length: limits.maxPolygonRings + 1 }, () => SQUARE);
    expect(geometryProblem({ type: 'Polygon', coordinates: rings })).toMatch(/at most 100 rings/i);
  });

  it('refuses 1.5M empty rings fast', () => {
    const g: GeoJsonGeometry = { type: 'Polygon', coordinates: Array.from({ length: 1_500_000 }, () => []) };
    const t0 = performance.now();
    expect(geometryProblem(g)).toMatch(/at most 100 rings/i);
    expect(performance.now() - t0).toBeLessThan(200);
  }, 30_000);
});
