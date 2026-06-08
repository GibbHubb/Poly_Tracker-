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
