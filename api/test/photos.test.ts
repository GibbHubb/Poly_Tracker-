import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterAll(closePool);

describe('photos — upload lat/lng persistence', () => {
  it('POST /api/photos uploads and persists lat/lng', async () => {
    // Minimal 1×1 JPEG bytes (smallest valid JPEG).
    const jpegBytes = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc00b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000003f0007fffd9',
      'hex',
    );

    const res = await request(app)
      .post('/api/photos')
      .field('lat', '-27.5')
      .field('lng', '152.3')
      .field('taken_at', '2026-06-01T10:00:00Z')
      .attach('photo', jpegBytes, { filename: 'test.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(Number(res.body.lat)).toBeCloseTo(-27.5, 4);
    expect(Number(res.body.lng)).toBeCloseTo(152.3, 4);
    expect(typeof res.body.id).toBe('string');
  });

  it('POST without lat/lng stores null coords', async () => {
    const jpegBytes = Buffer.from(
      'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc00b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000003f0007fffd9',
      'hex',
    );

    const res = await request(app)
      .post('/api/photos')
      .attach('photo', jpegBytes, { filename: 'no-gps.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.lat).toBeNull();
    expect(res.body.lng).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PT36 — the rest of the photo route's behaviour (it had 2 cases for a route
// with three storage outcomes and two scoping paths).
// ---------------------------------------------------------------------------
import { existsSync } from 'node:fs';
import { vi } from 'vitest';
import pg from 'pg';

const JPEG = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc00b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080101000003f0007fffd9',
  'hex',
);

async function farmWithPoint(name: string): Promise<{ farmId: string; featureId: string }> {
  const farm = await request(app).post('/api/farms').send({ name });
  const feat = await request(app)
    .post(`/api/farms/${farm.body.id}/features`)
    .send({ type: 'Feature', geometry: { type: 'Point', coordinates: [150, -26] }, properties: { name: 'T', type: 'trough' } });
  return { farmId: farm.body.id, featureId: feat.body.id };
}

async function upload(featureId: string | null) {
  const r = request(app).post('/api/photos');
  if (featureId) r.field('feature_id', featureId).field('feature_type', 'feature');
  return r.attach('photo', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
}

async function photoCount(): Promise<number> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query<{ n: string }>('SELECT count(*) AS n FROM photos');
  await c.end();
  return Number(rows[0]!.n);
}

describe('photos — behaviour', () => {
  it('POST with no file is a 400 and stores nothing', async () => {
    const res = await request(app).post('/api/photos').field('lat', '1');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photo file is required/);
    expect(await photoCount()).toBe(0);
  });

  it('GET ?feature_id= returns only that record’s photos', async () => {
    const a = await farmWithPoint('A');
    const b = await farmWithPoint('B');
    await upload(a.featureId);
    await upload(a.featureId);
    await upload(b.featureId);
    const res = await request(app).get(`/api/photos?feature_id=${a.featureId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.every((p: { feature_id: string }) => p.feature_id === a.featureId)).toBe(true);
  });

  it('GET ?farm_id= joins through features and excludes other farms and unattached photos', async () => {
    const a = await farmWithPoint('A');
    const b = await farmWithPoint('B');
    await upload(a.featureId);
    await upload(b.featureId);
    await upload(null);
    const res = await request(app).get(`/api/photos?farm_id=${a.farmId}`);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].feature_id).toBe(a.featureId);
    expect(await photoCount()).toBe(3);
  });

  it('DELETE removes the row AND the stored object; the file URL then 404s', async () => {
    const a = await farmWithPoint('A');
    const up = await upload(a.featureId);
    expect(up.status).toBe(201);
    const path: string = up.body.path;
    expect(existsSync(path)).toBe(true); // disk backend in tests
    const file = await request(app).get(`/api/photos/file/${up.body.id}`);
    expect(file.status).toBe(200);

    const del = await request(app).delete(`/api/photos/${up.body.id}`);
    expect(del.status).toBe(204);
    expect(await photoCount()).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect((await request(app).get(`/api/photos/file/${up.body.id}`)).status).toBe(404);
  });
});

describe('photos — storage unavailable', () => {
  it('POST is refused with a 503 BEFORE anything is stored', async () => {
    vi.resetModules();
    vi.stubEnv('PHOTO_BACKEND', 'supabase');
    vi.stubEnv('SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    try {
      const fresh = (await import('../src/index.js')).app;
      const res = await request(fresh)
        .post('/api/photos')
        .attach('photo', JPEG, { filename: 'p.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/Photo storage is unavailable/);
      expect(await photoCount()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
