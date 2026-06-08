import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

// A simple square polygon in Queensland, approx 1km x 1km.
const POLYGON_GEOM = {
  type: 'Polygon',
  coordinates: [
    [
      [152.0, -27.0],
      [152.01, -27.0],
      [152.01, -27.01],
      [152.0, -27.01],
      [152.0, -27.0],
    ],
  ],
};

async function createFarm() {
  return (await request(app).post('/api/farms').send({ name: 'Test Farm' })).body;
}

describe('paddocks CRUD + geometry round-trip', () => {
  it('POST creates a paddock and returns area_m2', async () => {
    const farm = await createFarm();
    const res = await request(app)
      .post(`/api/farms/${farm.id}/paddocks`)
      .send({ type: 'Feature', geometry: POLYGON_GEOM, properties: { name: 'North Paddock' } });
    expect(res.status).toBe(201);
    expect(res.body.properties.name).toBe('North Paddock');
    expect(Number(res.body.properties.area_m2)).toBeGreaterThan(0);
  });

  it('Polygon geometry round-trips correctly', async () => {
    const farm = await createFarm();
    const post = (
      await request(app)
        .post(`/api/farms/${farm.id}/paddocks`)
        .send({ type: 'Feature', geometry: POLYGON_GEOM, properties: { name: 'Round' } })
    ).body;

    const list = await request(app).get(`/api/farms/${farm.id}/paddocks`);
    expect(list.status).toBe(200);
    const found = list.body.features.find((f: { id?: string }) => f.id === post.id);
    expect(found).toBeDefined();
    expect(found.geometry.type).toBe('Polygon');
    // First coordinate of first ring should be close to our input.
    const c = found.geometry.coordinates[0][0];
    expect(c[0]).toBeCloseTo(152.0, 3);
    expect(c[1]).toBeCloseTo(-27.0, 3);
  });

  it('PATCH updates name; area recomputed from existing geometry', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/paddocks`)
        .send({ type: 'Feature', geometry: POLYGON_GEOM, properties: { name: 'Old' } })
    ).body;

    const patch = await request(app)
      .patch(`/api/farms/${farm.id}/paddocks/${created.id}`)
      .send({ type: 'Feature', properties: { name: 'New' } });
    expect(patch.status).toBe(200);
    expect(patch.body.properties.name).toBe('New');
    expect(Number(patch.body.properties.area_m2)).toBeGreaterThan(0);
  });

  it('DELETE removes the paddock', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/paddocks`)
        .send({ type: 'Feature', geometry: POLYGON_GEOM, properties: { name: 'Bye' } })
    ).body;

    const del = await request(app).delete(`/api/farms/${farm.id}/paddocks/${created.id}`);
    expect(del.status).toBe(204);

    const list = await request(app).get(`/api/farms/${farm.id}/paddocks`);
    expect(list.body.features).toHaveLength(0);
  });
});
