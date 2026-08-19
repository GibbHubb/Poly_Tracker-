/**
 * PT23 — the write gate must fail CLOSED in production.
 *
 * The bug these pin: the gate was wired in from day one and switched off by
 * simply not setting `API_WRITE_TOKEN`, so the live deployment served
 * unauthenticated CRUD and looked completely healthy doing it. An unset secret
 * must not be indistinguishable from a configured one.
 *
 * `requireToken` reads process.env per request, so stubEnv is enough — the app
 * does not need re-importing between cases.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterEach(() => vi.unstubAllEnvs());
afterAll(closePool);

describe('auth gate — production without a write token', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_WRITE_TOKEN', '');
    vi.stubEnv('API_TOKEN', '');
    vi.stubEnv('API_READ_TOKEN', '');
  });

  it('refuses POST with 503 rather than creating the row', async () => {
    const res = await request(app).post('/api/farms').send({ name: 'Should not exist' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/API_WRITE_TOKEN is not configured/);

    // The refusal has to be real, not cosmetic: nothing may have landed.
    vi.stubEnv('NODE_ENV', 'test');
    const list = await request(app).get('/api/farms');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(0);
  });

  it('refuses DELETE and PATCH the same way', async () => {
    const del = await request(app).delete('/api/farms/00000000-0000-0000-0000-000000000000/paddocks/x');
    expect(del.status).toBe(503);
    const patch = await request(app)
      .patch('/api/farms/00000000-0000-0000-0000-000000000000/paddocks/x')
      .send({});
    expect(patch.status).toBe(503);
  });

  it('still allows reads — the map is meant to be public', async () => {
    const res = await request(app).get('/api/farms');
    expect(res.status).toBe(200);
  });

  it('does not intercept the health check', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, db: 'up' });
  });
});

describe('auth gate — production with a write token', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_WRITE_TOKEN', 'test-write-token');
  });

  it('401s an unauthenticated write (wrong token ≠ misconfigured server)', async () => {
    const res = await request(app).post('/api/farms').send({ name: 'No token' });
    expect(res.status).toBe(401);
  });

  it('401s a wrong token', async () => {
    const res = await request(app)
      .post('/api/farms')
      .set('Authorization', 'Bearer not-the-token')
      .send({ name: 'Bad token' });
    expect(res.status).toBe(401);
  });

  it('accepts the write when the token matches', async () => {
    const res = await request(app)
      .post('/api/farms')
      .set('Authorization', 'Bearer test-write-token')
      .send({ name: 'Authorised' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Authorised');
  });
});

describe('auth gate — outside production', () => {
  // Local dev and this suite rely on open mode; PT23 must not change it.
  it('leaves writes open when nothing is configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('API_WRITE_TOKEN', '');
    vi.stubEnv('API_TOKEN', '');
    const res = await request(app).post('/api/farms').send({ name: 'Dev open mode' });
    expect(res.status).toBe(201);
  });
});
