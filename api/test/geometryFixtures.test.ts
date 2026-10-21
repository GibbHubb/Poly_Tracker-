/**
 * PT42 — the API's geometry rules against the shared fixtures in
 * fixtures/geometry-cases.json, which the draw tool's suite reads too. The routes
 * parse with these exact schemas (see geometry.test.ts for the HTTP side).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineGeometry, pointGeometry, polygonGeometry } from '../src/lib/geojson.js';

interface Case { name: string; reason: string | null; geometry: { type: string; coordinates: unknown } }
const { cases } = JSON.parse(
  readFileSync(new URL('../../fixtures/geometry-cases.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

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
