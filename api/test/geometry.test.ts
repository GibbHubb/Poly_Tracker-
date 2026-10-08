/**
 * PT41 — a shape must be a shape, and refusals must not quote the database.
 *
 * Found by PT35's probing: `POST /paddocks` with `[[0,0],[1,1]]` returned 201
 * and stored a polygon with area 0. Each route now takes only its own kind,
 * with rings and lines that can actually be drawn.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

let farmId = '';
beforeEach(async () => {
  farmId = (await request(app).post('/api/farms').send({ name: 'Geo' })).body.id;
});

const feat = (geometry: unknown, properties: Record<string, unknown>) => ({ type: 'Feature', geometry, properties });
const poly = (ring: number[][]) => ({ type: 'Polygon', coordinates: [ring] });
const SQUARE = [[150, -26], [150.01, -26], [150.01, -26.01], [150, -26.01], [150, -26]];

describe('paddocks — polygons only, and real ones', () => {
  it.each([
    ['the PT35 probe: two points', poly([[0, 0], [1, 1]]), /at least 4 positions/],
    ['an unclosed ring', poly([[150, -26], [150.01, -26], [150.01, -26.01], [150, -26.01]]), /must be closed/],
    ['all corners in a line', poly([[150, -26], [150.01, -26], [150.02, -26], [150, -26]]), /enclose an area/],
    ['the same corner repeated', poly([[150, -26], [150, -26], [150, -26], [150, -26]]), /3 different corners/],
    ['a Point', { type: 'Point', coordinates: [150, -26] }, /Polygon/],
    ['latitude out of range', poly([[150, -95], [150.01, -95], [150.01, -96], [150, -95]]), /within -180..180/],
  ])('refuses %s with a 400 that says why', async (_label, geometry, why) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).post(`/api/farms/${farmId}/paddocks`).send(feat(geometry, { name: 'P' }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(why);
    const list = await request(app).get(`/api/farms/${farmId}/paddocks`);
    expect(list.body.features).toHaveLength(0);
  });

  it('accepts a real polygon, and its area is not zero', async () => {
    const res = await request(app).post(`/api/farms/${farmId}/paddocks`).send(feat(poly(SQUARE), { name: 'P' }));
    expect(res.status).toBe(201);
    expect(Number(res.body.properties.area_m2)).toBeGreaterThan(1000);
  });

  it('a PATCH cannot sneak a degenerate shape in either', async () => {
    const made = await request(app).post(`/api/farms/${farmId}/paddocks`).send(feat(poly(SQUARE), { name: 'P' }));
    const res = await request(app)
      .patch(`/api/farms/${farmId}/paddocks/${made.body.id}`)
      .send({ geometry: poly([[0, 0], [1, 1]]) });
    expect(res.status).toBe(400);
  });
});

describe('poly runs and points', () => {
  it('a line needs two different points', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const coordinates of [[[150, -26]], [[150, -26], [150, -26]]]) {
      const res = await request(app)
        .post(`/api/farms/${farmId}/poly-runs`)
        .send(feat({ type: 'LineString', coordinates }, { name: 'L' }));
      expect(res.status).toBe(400);
    }
    const ok = await request(app)
      .post(`/api/farms/${farmId}/poly-runs`)
      .send(feat({ type: 'LineString', coordinates: [[150, -26], [150.01, -26]] }, { name: 'L' }));
    expect(ok.status).toBe(201);
  });

  it('a point must be a position on Earth, and not a polygon', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bad = await request(app)
      .post(`/api/farms/${farmId}/features`)
      .send(feat({ type: 'Point', coordinates: [200, -26] }, { type: 'trough' }));
    expect(bad.status).toBe(400);
    const wrongKind = await request(app).post(`/api/farms/${farmId}/features`).send(feat(poly(SQUARE), { type: 'trough' }));
    expect(wrongKind.status).toBe(400);
  });
});

describe('import report — our reasons, never the database text', () => {
  const importFile = (features: unknown[]) =>
    request(app)
      .post('/api/import/geojson?partial=true')
      .field('farm_id', farmId)
      .attach('file', Buffer.from(JSON.stringify({ type: 'FeatureCollection', features })), {
        filename: 'f.geojson',
        contentType: 'application/geo+json',
      });

  it('a degenerate polygon row is refused with the validation reason', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await importFile([feat(poly([[0, 0], [1, 1]]), { name: 'bad' }), feat(poly(SQUARE), { name: 'good' })]);
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    const bad = res.body.report.find((r: { status: string }) => r.status === 'error');
    expect(bad.error).toMatch(/at least 4 positions/);
  });

  it('a row Postgres refuses gets a generic line + code, and no table or column text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A 3-D point passes validation; the 2-D geometry column refuses it in Postgres.
    const res = await importFile([feat({ type: 'Point', coordinates: [150, -26, 12] }, { type: 'trough' })]);
    const row = res.body.report[0];
    expect(row.status).toBe('error');
    expect(row.error).toMatch(/^rejected by the database/);
    expect(row.error).not.toMatch(/dimension|column|features|geom/i);
  });
});
