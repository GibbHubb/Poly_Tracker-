import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

const POINT_GEOM = {
  type: 'Point',
  coordinates: [152.0, -27.0],
};

async function createFarm() {
  return (await request(app).post('/api/farms').send({ name: 'Features Farm' })).body;
}

describe('features CRUD + geometry round-trip', () => {
  it('POST creates a Point feature', async () => {
    const farm = await createFarm();
    const res = await request(app)
      .post(`/api/farms/${farm.id}/features`)
      .send({
        type: 'Feature',
        geometry: POINT_GEOM,
        properties: { type: 'bore', name: 'Bore 1' },
      });
    expect(res.status).toBe(201);
    expect(res.body.properties.name).toBe('Bore 1');
    expect(res.body.properties.type).toBe('bore');
  });

  it('Point geometry round-trips correctly', async () => {
    const farm = await createFarm();
    const post = (
      await request(app)
        .post(`/api/farms/${farm.id}/features`)
        .send({ type: 'Feature', geometry: POINT_GEOM, properties: { type: 'trough' } })
    ).body;

    const list = await request(app).get(`/api/farms/${farm.id}/features`);
    expect(list.status).toBe(200);
    const found = list.body.features.find((f: { id?: string }) => f.id === post.id);
    expect(found).toBeDefined();
    expect(found.geometry.type).toBe('Point');
    expect(found.geometry.coordinates[0]).toBeCloseTo(152.0, 4);
    expect(found.geometry.coordinates[1]).toBeCloseTo(-27.0, 4);
  });

  it('PATCH full-replace: emptied notes becomes null, geometry survives', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/features`)
        .send({
          type: 'Feature',
          geometry: POINT_GEOM,
          properties: { type: 'gate', name: 'Main Gate', notes: 'Initial note' },
        })
    ).body;

    // PATCH without notes (omitted) — should clear it.
    const patch = await request(app)
      .patch(`/api/farms/${farm.id}/features/${created.id}`)
      .send({
        type: 'Feature',
        properties: { type: 'gate', name: 'Main Gate' },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.properties.notes).toBeNull();

    // Geometry must survive the attribute-only PATCH.
    expect(patch.body.geometry.type).toBe('Point');
    expect(patch.body.geometry.coordinates[0]).toBeCloseTo(152.0, 4);
  });

  it('PATCH with bogus length_m does NOT persist it', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/features`)
        .send({ type: 'Feature', geometry: POINT_GEOM, properties: { type: 'bore' } })
    ).body;

    const patch = await request(app)
      .patch(`/api/farms/${farm.id}/features/${created.id}`)
      .send({ type: 'Feature', properties: { type: 'bore', length_m: 99999 } });
    // length_m is not a column on features — it should just be ignored.
    expect(patch.status).toBe(200);
  });

  it('DELETE removes the feature', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/features`)
        .send({ type: 'Feature', geometry: POINT_GEOM, properties: { type: 'tap', name: 'X' } })
    ).body;

    expect((await request(app).delete(`/api/farms/${farm.id}/features/${created.id}`)).status).toBe(204);
    const list = await request(app).get(`/api/farms/${farm.id}/features`);
    expect(list.body.features).toHaveLength(0);
  });
});
