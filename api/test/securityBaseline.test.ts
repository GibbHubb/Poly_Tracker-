/**
 * PT43 — the security baseline, through the REAL app: headers on every API
 * response, a security line for a 401, the limiter's default, and the photo
 * upload's type check. Nothing here reaches the database (the 401 and both
 * 415s are decided before any query), so it runs without PostGIS too.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../src/index.js';
import { API_CSP } from '../src/middleware/securityHeaders.js';
import { MAX_PHOTO_BYTES } from '../src/routes/photos.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectSecurityHeaders(res: request.Response) {
  expect(res.headers['content-security-policy']).toBe(API_CSP);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
}

describe('security headers (PT43)', () => {
  it('are on a normal API response', async () => {
    const res = await request(app).get('/api/auth/config');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
  });

  it('are on a refusal too (401 from the token gate)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('API_WRITE_TOKEN', 'the-real-write-token');
    const res = await request(app).post('/api/farms').send({ name: 'nope' });
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
  });

  it('the API CSP is deny-all and forbids framing', () => {
    expect(API_CSP).toContain("default-src 'none'");
    expect(API_CSP).toContain("frame-ancestors 'none'");
  });
});

describe('auth failure is a security event (PT43)', () => {
  it('a wrong write token logs auth.failure with the route shape, never the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('API_WRITE_TOKEN', 'the-real-write-token');
    await request(app)
      .delete('/api/farms/3f2b8c1e-9a7d-4e21-b0c4-5d6e7f8a9b0c')
      .set('Authorization', 'Bearer a-wrong-guess');
    const out = warn.mock.calls.map((c) => String(c[0]));
    const sec = out.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'security');
    expect(sec).toHaveLength(1);
    expect(sec[0]).toMatchObject({ event: 'auth.failure', method: 'DELETE', path: '/api/farms/:id', status: 401, credential: 'bearer' });
    expect(out.join('\n')).not.toContain('a-wrong-guess');
    expect(out.join('\n')).not.toContain('the-real-write-token');
  });
});

describe('rate limiting default (PT43)', () => {
  it('is off for the test suites (they send hundreds of writes from one ip): 30 bad tokens are all plain 401s', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('API_WRITE_TOKEN', 'the-real-write-token');
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post('/api/farms').set('Authorization', 'Bearer guess').send({ name: 'x' });
      expect(res.status).toBe(401);
    }
  });
});

describe('photo upload type check (PT43)', () => {
  it('refuses a declared non-image type with 415 before reading the bytes', async () => {
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'x.html', contentType: 'text/html' });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/only photos/i);
  });

  it('refuses an image label on bytes that are not an image (415), and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'cat.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(415);
    const refused = warn.mock.calls
      .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
      .find((l) => l.msg === 'photo upload refused: not an image');
    expect(refused).toMatchObject({ declared: 'image/jpeg' });
  });

  it('refuses an SVG (script-capable) even when labelled as octet-stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', svg, { filename: 'x.svg', contentType: 'application/octet-stream' });
    expect(res.status).toBe(415);
  });

  it('still refuses an over-cap photo with 413 (PT26) — the size limit and the type filter coexist', async () => {
    const big = Buffer.alloc(MAX_PHOTO_BYTES + 1, 0x41);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const res = await request(app)
      .post('/api/photos')
      .attach('photo', big, { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
  });
});
