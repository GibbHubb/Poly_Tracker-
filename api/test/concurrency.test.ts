import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

/**
 * PT18-fu1 — optimistic concurrency.
 *
 * PT15's replay machinery and PT18's field-level merge both only trigger on a
 * 409/412, and the API never emitted one. These cover the two things that has
 * to mean: a stale write is refused with 412, and a request that opts out
 * (no If-Match) still behaves exactly as it did before.
 */

beforeEach(truncateAll);
afterAll(closePool);

async function makeFarm(name = 'Concurrency Farm') {
  return (await request(app).post('/api/farms').send({ name })).body;
}

const POLYGON = {
  type: 'Polygon',
  coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]],
};

describe('farms optimistic concurrency', () => {
  it('a new farm starts at version 1 and exposes it as an ETag', async () => {
    const res = await request(app).post('/api/farms').send({ name: 'Fresh' });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
    expect(res.headers.etag).toBe('"1"');
  });

  it('a successful PATCH bumps the version', async () => {
    const farm = await makeFarm();
    const res = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', `"${farm.version}"`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.headers.etag).toBe('"2"');
  });

  it('a stale If-Match is refused with 412', async () => {
    const farm = await makeFarm();
    // Someone else writes first, moving the row to version 2.
    await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'Theirs' });

    const stale = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'Mine' });

    expect(stale.status).toBe(412);
  });

  it('a refused write does not modify the row', async () => {
    const farm = await makeFarm();
    await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'Theirs' });

    await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'Mine' });

    const after = await request(app).get(`/api/farms/${farm.id}`);
    expect(after.body.name).toBe('Theirs');
    expect(after.body.version).toBe(2);
  });

  it('the 412 reports the current version so the client can merge', async () => {
    const farm = await makeFarm();
    await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'Theirs' });

    const stale = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', '"1"')
      .send({ name: 'Mine' });

    expect(stale.body.error).toMatch(/current is 2/);
  });

  it('omitting If-Match keeps last-write-wins (existing clients unaffected)', async () => {
    const farm = await makeFarm();
    await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'First' });
    const res = await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'Second' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Second');
    expect(res.body.version).toBe(3);
  });

  it('If-Match on a missing row is 404, not 412', async () => {
    // Gone and stale are different problems with different client responses.
    const res = await request(app)
      .patch('/api/farms/00000000-0000-0000-0000-000000000000')
      .set('If-Match', '"1"')
      .send({ name: 'Ghost' });
    expect(res.status).toBe(404);
  });

  it('a malformed If-Match is rejected rather than silently ignored', async () => {
    const farm = await makeFarm();
    const res = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', 'not-a-version')
      .send({ name: 'Nope' });
    expect(res.status).toBe(400);
  });

  it('accepts a weak ETag and a bare number', async () => {
    const farm = await makeFarm();
    const weak = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', 'W/"1"')
      .send({ name: 'Weak' });
    expect(weak.status).toBe(200);

    const bare = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', '2')
      .send({ name: 'Bare' });
    expect(bare.status).toBe(200);
  });

  it('If-Match: * only asserts existence', async () => {
    const farm = await makeFarm();
    await request(app).patch(`/api/farms/${farm.id}`).send({ name: 'Moved on' });

    const res = await request(app)
      .patch(`/api/farms/${farm.id}`)
      .set('If-Match', '*')
      .send({ name: 'Star' });
    expect(res.status).toBe(200);
  });
});

describe('paddocks optimistic concurrency', () => {
  it('refuses a stale write and leaves the row untouched', async () => {
    const farm = await makeFarm();
    const created = await request(app)
      .post(`/api/farms/${farm.id}/paddocks`)
      .send({ geometry: POLYGON, properties: { name: 'North' } });
    expect(created.status).toBe(201);
    const id = created.body.id;

    await request(app)
      .patch(`/api/farms/${farm.id}/paddocks/${id}`)
      .send({ properties: { name: 'Theirs' } });

    const stale = await request(app)
      .patch(`/api/farms/${farm.id}/paddocks/${id}`)
      .set('If-Match', '"1"')
      .send({ properties: { name: 'Mine' } });
    expect(stale.status).toBe(412);

    const after = await request(app).get(`/api/farms/${farm.id}/paddocks`);
    expect(after.body.features[0].properties.name).toBe('Theirs');
  });

  it('accepts a current If-Match and bumps the version', async () => {
    const farm = await makeFarm();
    const created = await request(app)
      .post(`/api/farms/${farm.id}/paddocks`)
      .send({ geometry: POLYGON, properties: { name: 'South' } });

    const res = await request(app)
      .patch(`/api/farms/${farm.id}/paddocks/${created.body.id}`)
      .set('If-Match', `"${created.body.properties.version}"`)
      .send({ properties: { name: 'South Renamed' } });

    expect(res.status).toBe(200);
    expect(res.body.properties.version).toBe(2);
  });
});

describe('features optimistic concurrency', () => {
  it('refuses a stale write', async () => {
    const farm = await makeFarm();
    const created = await request(app)
      .post(`/api/farms/${farm.id}/features`)
      .send({
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { type: 'trough', name: 'Trough 1' },
      });
    expect(created.status).toBe(201);
    const id = created.body.id;

    await request(app)
      .patch(`/api/farms/${farm.id}/features/${id}`)
      .send({ properties: { type: 'trough', name: 'Theirs' } });

    const stale = await request(app)
      .patch(`/api/farms/${farm.id}/features/${id}`)
      .set('If-Match', '"1"')
      .send({ properties: { type: 'trough', name: 'Mine' } });

    expect(stale.status).toBe(412);
  });

  it('a version is never accepted as client input', async () => {
    // `.strip()` on the properties schema must keep a spoofed version out of
    // the UPDATE — otherwise a client could pin itself to any version it liked.
    const farm = await makeFarm();
    const created = await request(app)
      .post(`/api/farms/${farm.id}/features`)
      .send({
        geometry: { type: 'Point', coordinates: [1, 2] },
        properties: { type: 'trough', name: 'T', version: 99 },
      });
    expect(created.status).toBe(201);
    expect(created.body.properties.version).toBe(1);
  });
});
