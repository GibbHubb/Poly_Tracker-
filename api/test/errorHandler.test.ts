/**
 * PT35 — an unexpected error must not hand database text to the caller, and
 * every request must be traceable from the response to the log line.
 *
 * Before PT35, a POST against a farm id that does not exist returned
 *   {"error":"insert or update on table \"features\" violates foreign key constraint \"features_farm_id_fkey\""}
 * as a 500, to anyone, on an open endpoint. That case is now a 404. The generic
 * 500 is forced with a REAL Postgres error: the route's query is swapped, once,
 * for a SELECT on a table that does not exist, so the error object, its message
 * and its SQLSTATE all come from the server, not from a hand-made mock.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { resetHealthStats } from '../src/middleware/observability.js';
import { pool } from '../src/db.js';
import { truncateAll, closePool } from './helpers.js';

const GHOST_FARM = '00000000-0000-4000-8000-000000000000';
const point = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [150.1, -26.5] },
  properties: { name: 'Trough', type: 'trough' },
};

/** Every JSON line the server logged during the test. */
function capturedLines(...spies: ReturnType<typeof vi.spyOn>[]): Record<string, unknown>[] {
  return spies
    .flatMap((s) => s.mock.calls.map((c) => c[0]))
    .filter((x): x is string => typeof x === 'string' && x.startsWith('{'))
    .map((x) => JSON.parse(x) as Record<string, unknown>);
}

beforeEach(async () => {
  await truncateAll();
  resetHealthStats();
});
afterEach(() => vi.restoreAllMocks());
afterAll(closePool);

const SECRET_TABLE = 'poly_secret_table_pt35';

/** Make the next query the app sends fail inside Postgres, naming SECRET_TABLE. */
function failNextQuery(): void {
  const real = pool.query.bind(pool);
  vi.spyOn(pool, 'query').mockImplementationOnce((() =>
    real(`SELECT * FROM ${SECRET_TABLE}`)) as unknown as typeof pool.query);
}

describe('errorHandler — no database text reaches the caller', () => {
  it('a real Postgres error returns a generic 500 with a requestId, and no database text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    failNextQuery();

    const res = await request(app).get('/api/farms');

    expect(res.status).toBe(500);
    const body = JSON.stringify(res.body);
    for (const leak of [SECRET_TABLE, 'relation', 'does not exist', 'SELECT']) {
      expect(body).not.toContain(leak);
    }
    expect(res.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);

    // ...while the log keeps everything, under the same id.
    const lines = capturedLines(err);
    const detail = lines.find((l) => l.msg === 'unhandled error');
    expect(detail?.requestId).toBe(res.body.requestId);
    expect(String(detail?.error)).toContain(SECRET_TABLE);
    expect(detail?.code).toBe('42P01');
    expect(detail?.stack).toBeTruthy();
  });

  it('a foreign-key violation (farm deleted elsewhere) is a 404 naming no constraint', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).post(`/api/farms/${GHOST_FARM}/features`).send(point);
    expect(res.status).toBe(404);
    const body = JSON.stringify(res.body);
    for (const leak of ['features', 'farm_id', 'constraint', 'fkey', 'violates', 'insert']) {
      expect(body).not.toContain(leak);
    }
    expect(res.body.requestId).toBeTruthy();
  });

  it('a malformed uuid is the caller’s mistake: 400, not a 500 quoting the cast', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get('/api/farms/not-a-uuid');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/uuid|syntax/i);
    expect(res.body.requestId).toBeTruthy();
  });

  it('an unparseable JSON body is a 400, not a 500 quoting the parser', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app)
      .post('/api/farms')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Request body is not valid JSON.');
  });

  it('our own HttpError bodies are unchanged (they are UI text)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const res = await request(app).get(`/api/farms/${GHOST_FARM}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Farm not found' });
  });
});

describe('request id + access log', () => {
  it('every response carries x-request-id, and the access-log line has id, method, path, status, ms', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await request(app).get('/api/farms');
    expect(res.status).toBe(200);
    const id = res.headers['x-request-id'];
    expect(id).toBeTruthy();

    const line = capturedLines(info).find((l) => l.msg === 'request' && l.requestId === id);
    expect(line).toMatchObject({ method: 'GET', path: '/api/farms', status: 200 });
    expect(typeof line?.ms).toBe('number');
  });

  it('reuses a well-formed inbound x-request-id and replaces a hostile one', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const ok = await request(app).get('/api/farms').set('x-request-id', 'trace-abc.123');
    expect(ok.headers['x-request-id']).toBe('trace-abc.123');

    const bad = await request(app).get('/api/farms').set('x-request-id', 'x"} injected {"level":"info');
    expect(bad.headers['x-request-id']).not.toContain('injected');
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the access log folds record ids so it does not list them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await request(app).get(`/api/farms/${GHOST_FARM}?x=1`);
    const line = capturedLines(warn).find((l) => l.msg === 'request');
    expect(line?.path).toBe('/api/farms/:id');
  });
});

describe('/api/health — what has been failing, without the dashboard', () => {
  it('reports the 5xx with its requestId and SQLSTATE, but never the message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    failNextQuery();
    const failed = await request(app).get(`/api/farms/${GHOST_FARM}`);
    expect(failed.status).toBe(500);

    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.errors_5xx).toBe(1);
    expect(health.body.instance).toBeTruthy();
    expect(health.body.scope).toMatch(/instance/);
    expect(health.body.recent_errors[0]).toMatchObject({
      requestId: failed.body.requestId,
      method: 'GET',
      path: '/api/farms/:id',
      status: 500,
      code: '42P01',
    });
    expect(JSON.stringify(health.body)).not.toMatch(new RegExp(`${SECRET_TABLE}|relation|does not exist`));
  });
});
