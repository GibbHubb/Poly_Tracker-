import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

const LINE_GEOM = {
  type: 'LineString',
  coordinates: [
    [152.0, -27.0],
    [152.05, -27.02],
  ],
};

async function createFarm() {
  return (await request(app).post('/api/farms').send({ name: 'Runs Farm' })).body;
}

describe('poly-runs CRUD + geometry round-trip', () => {
  it('POST creates a poly-run and returns length_m', async () => {
    const farm = await createFarm();
    const res = await request(app)
      .post(`/api/farms/${farm.id}/poly-runs`)
      .send({
        type: 'Feature',
        geometry: LINE_GEOM,
        properties: { name: 'Main Run', diameter_mm: 100 },
      });
    expect(res.status).toBe(201);
    expect(res.body.properties.name).toBe('Main Run');
    expect(Number(res.body.properties.length_m)).toBeGreaterThan(0);
  });

  it('LineString geometry round-trips correctly', async () => {
    const farm = await createFarm();
    const post = (
      await request(app)
        .post(`/api/farms/${farm.id}/poly-runs`)
        .send({ type: 'Feature', geometry: LINE_GEOM, properties: { name: 'Round Trip' } })
    ).body;

    const list = await request(app).get(`/api/farms/${farm.id}/poly-runs`);
    expect(list.status).toBe(200);
    const found = list.body.features.find((f: { id?: string }) => f.id === post.id);
    expect(found).toBeDefined();
    expect(found.geometry.type).toBe('LineString');
    const c = found.geometry.coordinates[0];
    expect(c[0]).toBeCloseTo(152.0, 3);
    expect(c[1]).toBeCloseTo(-27.0, 3);
  });

  it('PATCH updates notes; length recomputed from existing geometry', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/poly-runs`)
        .send({ type: 'Feature', geometry: LINE_GEOM, properties: { name: 'Run A' } })
    ).body;

    const patch = await request(app)
      .patch(`/api/farms/${farm.id}/poly-runs/${created.id}`)
      .send({ type: 'Feature', properties: { name: 'Run A', notes: 'Updated' } });
    expect(patch.status).toBe(200);
    expect(patch.body.properties.notes).toBe('Updated');
    expect(Number(patch.body.properties.length_m)).toBeGreaterThan(0);
  });

  it('DELETE removes the poly-run', async () => {
    const farm = await createFarm();
    const created = (
      await request(app)
        .post(`/api/farms/${farm.id}/poly-runs`)
        .send({ type: 'Feature', geometry: LINE_GEOM, properties: { name: 'Gone' } })
    ).body;

    expect((await request(app).delete(`/api/farms/${farm.id}/poly-runs/${created.id}`)).status).toBe(204);
    const list = await request(app).get(`/api/farms/${farm.id}/poly-runs`);
    expect(list.body.features).toHaveLength(0);
  });
});
