/**
 * PT42 — the API's geometry rules against the shared fixtures in
 * fixtures/geometry-cases.json, which the draw tool's suite reads too. The routes
 * parse with these exact schemas (see geometry.test.ts for the HTTP side).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_POLYGON_POSITIONS, MAX_POLYGON_RINGS, lineGeometry, pointGeometry, polygonGeometry } from '../src/lib/geojson.js';

interface Case { name: string; reason: string | null; geometry: { type: string; coordinates: unknown } }
const { cases, limits } = JSON.parse(
  readFileSync(new URL('../../fixtures/geometry-cases.json', import.meta.url), 'utf8'),
) as { cases: Case[]; limits: { maxPolygonPositions: number; maxPolygonRings: number } };

const schemaFor = { Polygon: polygonGeometry, LineString: lineGeometry, Point: pointGeometry } as const;

describe('shared geometry fixtures (API)', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const res = schemaFor[c.geometry.type as keyof typeof schemaFor].safeParse(c.geometry);
    if (c.reason === null) {
      expect(res.success, res.success ? '' : JSON.stringify(res.error.issues)).toBe(true);
    } else {
      expect(res.success).toBe(false);
      const messages = res.success ? '' : res.error.issues.map((i) => i.message).join('; ');
      expect(messages).toMatch(new RegExp(c.reason, 'i'));
    }
  });
});

// PT45 — a ring long enough to hold the event loop is refused by its size, before the
// quadratic edge check ever sees it. The client suite runs the same three cases.
describe('polygon size cap (PT45, API)', () => {
  /** A closed, round outline of exactly `n` positions near lng 150. */
  const circle = (n: number) => {
    const r: number[][] = [];
    for (let i = 0; i < n - 1; i++) {
      const t = (i / (n - 1)) * 2 * Math.PI;
      r.push([150 + 0.01 * Math.cos(t), -26 + 0.01 * Math.sin(t)]);
    }
    r.push(r[0]!);
    return { type: 'Polygon', coordinates: [r] };
  };
  const messages = (g: unknown) => {
    const res = polygonGeometry.safeParse(g);
    return res.success ? null : res.error.issues.map((i) => i.message).join('; ');
  };

  it('uses the shared limit', () => {
    expect(MAX_POLYGON_POSITIONS).toBe(limits.maxPolygonPositions);
  });

  it('accepts a real outline of exactly the limit', () => {
    expect(messages(circle(limits.maxPolygonPositions))).toBeNull();
  });

  it('refuses one position over the limit, for its size', () => {
    expect(messages(circle(limits.maxPolygonPositions + 1))).toMatch(/at most 5,000/i);
  });

  it('counts every ring, not just the outer one', () => {
    const half = circle(Math.ceil(limits.maxPolygonPositions / 2) + 1).coordinates[0]!;
    expect(messages({ type: 'Polygon', coordinates: [half, half] })).toMatch(/at most 5,000/i);
  });

  it('refuses a 150,000-position ring (a 5 MB body) quickly instead of checking every edge pair', () => {
    const t0 = performance.now();
    expect(messages(circle(150_000))).toMatch(/at most 5,000/i);
    expect(performance.now() - t0).toBeLessThan(2_000);
  }, 10_000);
});

// PT44 review — the position cap counts positions, so a body of 1.5M EMPTY rings passed it and
// took ~11 s to parse. The ring count is checked on the raw array, before any ring is parsed.
describe('polygon ring-count cap (PT44 review, API)', () => {
  const SQUARE = [[150, -26], [150.01, -26], [150.01, -26.01], [150, -26.01], [150, -26]];
  const messages = (g: unknown) => {
    const res = polygonGeometry.safeParse(g);
    return res.success ? null : res.error.issues.map((i) => i.message).join('; ');
  };

  it('uses the shared limit', () => {
    expect(MAX_POLYGON_RINGS).toBe(limits.maxPolygonRings);
  });

  it('does not refuse exactly the limit for its ring count', () => {
    const rings = Array.from({ length: limits.maxPolygonRings }, () => SQUARE);
    expect(messages({ type: 'Polygon', coordinates: rings }) ?? '').not.toMatch(/rings/i);
  });

  it('refuses one ring over the limit, for its ring count, with one issue', () => {
    const res = polygonGeometry.safeParse({ type: 'Polygon', coordinates: Array.from({ length: limits.maxPolygonRings + 1 }, () => SQUARE) });
    expect(res.success).toBe(false);
    expect(res.success ? [] : res.error.issues.map((i) => i.message)).toEqual(['a polygon can have at most 100 rings']);
  });

  it('refuses 1.5M empty rings fast, without parsing a single ring', () => {
    const g = { type: 'Polygon', coordinates: Array.from({ length: 1_500_000 }, () => []) };
    const t0 = performance.now();
    const res = polygonGeometry.safeParse(g);
    const ms = performance.now() - t0;
    expect(res.success).toBe(false);
    expect(res.success ? 0 : res.error.issues.length).toBe(1); // was 3,000,000 (two per ring)
    expect(ms).toBeLessThan(200); // was ~11,000 ms on Node 22
  }, 30_000);
});
