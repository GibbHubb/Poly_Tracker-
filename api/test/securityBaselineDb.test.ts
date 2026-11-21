/**
 * PT43 — the parts of the security baseline that need the database: an
 * accepted upload is stored under the type its BYTES say (never the client's
 * filename), and a real delete leaves an audit line naming the record.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { truncateAll, closePool } from './helpers.js';

beforeEach(truncateAll);
afterEach(() => vi.restoreAllMocks());
afterAll(closePool);

const PNG = (() => {
  const b = Buffer.alloc(64, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  return b;
})();

const HEIC = (() => {
  const b = Buffer.alloc(64, 0);
  b.writeUInt32BE(24, 0);
  b.write('ftypheic', 4, 'latin1');
  b.write('mif1heic', 16, 'latin1');
  return b;
})();

describe('photo upload stores the sniffed type (PT43)', () => {
  it('a PNG named evil.html is stored as .png', async () => {
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', PNG, { filename: 'evil.html', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/\.png$/);
  });

  it('an iPhone HEIC the browser could not label (octet-stream) is accepted and stored as .heic', async () => {
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', HEIC, { filename: 'IMG_0001', contentType: 'application/octet-stream' });
    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/\.heic$/);
  });
});

describe('delete audit trail (PT43)', () => {
  it('deleting a farm logs an audit line with its id', async () => {
    const farm = await request(app).post('/api/farms').send({ name: 'Audit me' });
    expect(farm.status).toBe(201);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const del = await request(app).delete(`/api/farms/${farm.body.id}`);
    expect(del.status).toBe(204);
    const audit = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l.msg === 'audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ event: 'delete', path: `/api/farms/${farm.body.id}`, status: 204, actor: 'open' });
  });
});
