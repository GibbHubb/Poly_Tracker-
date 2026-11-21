/**
 * PT43 — the per-instance limiter: auth failures (per credential, and per IP
 * across many credentials) and writes. DB-free: a throwaway Express app with
 * the real middleware and a fake clock.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  FixedWindowCounter,
  clientIp,
  createRateLimiter,
  credentialKey,
  rateLimitFromEnv,
} from '../src/middleware/rateLimit.js';

function appWith(
  opts: { authFailuresMax: number; writesMax: number; authDistinctMax?: number },
  clock: { t: number },
) {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, authDistinctMax: 1000, ...opts, now: () => clock.t }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/auth/me', (_req, res) => res.status(401).json({ error: 'Not signed in.' }));
  app.post('/api/auth/session', (_req, res) => res.status(201).json({ ok: true }));
  // Stands in for the token gate: only "Bearer good" passes.
  app.all('/api/thing', (req, res) => {
    if (req.headers.authorization !== 'Bearer good') {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.status(req.method === 'GET' ? 200 : 201).json({ ok: true });
  });
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('rate limit — writes (PT43)', () => {
  it('allows writesMax writes per window, then 429 with Retry-After, then resets', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 1_000_000 };
    const app = appWith({ authFailuresMax: 100, writesMax: 3 }, clock);
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).post('/api/thing').set('Authorization', 'Bearer good');
      expect(ok.status).toBe(201);
    }
    const limited = await request(app).post('/api/thing').set('Authorization', 'Bearer good');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(limited.body.error).toMatch(/too many requests/i);
    // Reads are not write-limited.
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer good')).status).toBe(200);
    // Next window: writes work again.
    clock.t += 60_001;
    expect((await request(app).post('/api/thing').set('Authorization', 'Bearer good')).status).toBe(201);
  });

  it('logs a rate.limited security line with the ip and route shape, no headers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 5_000 };
    const app = appWith({ authFailuresMax: 100, writesMax: 1 }, clock);
    await request(app).post('/api/thing').set('Authorization', 'Bearer good');
    await request(app).post('/api/thing').set('Authorization', 'Bearer good');
    const lines = warn.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    const hit = lines.find((l) => l.event === 'rate.limited');
    expect(hit).toMatchObject({ msg: 'security', reason: 'writes', method: 'POST', path: '/api/thing' });
    expect(typeof hit?.ip).toBe('string');
    expect(JSON.stringify(lines)).not.toContain('good');
  });
});

describe('rate limit — auth failures (PT43)', () => {
  it('after authFailuresMax 401s for ONE credential, that credential gets 429 until the window ends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 3, writesMax: 100 }, clock);
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/thing').set('Authorization', 'Bearer stale')).status).toBe(401);
    }
    const blocked = await request(app).get('/api/thing').set('Authorization', 'Bearer stale');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    // The operator's probe is never limited.
    expect((await request(app).get('/api/health')).status).toBe(200);
    clock.t += 60_001;
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer stale')).status).toBe(401);
  });

  it('shared farm wifi: a stale-token device does not block another device\'s valid token at the same ip', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 3, writesMax: 100 }, clock);
    // loadFarm alone fires several requests: the stale device trips its own limit...
    for (let i = 0; i < 8; i++) await request(app).get('/api/thing').set('Authorization', 'Bearer rotated-away');
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer rotated-away')).status).toBe(429);
    // ...and the next device on the same NAT address is untouched, reads and writes.
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer good')).status).toBe(200);
    expect((await request(app).post('/api/thing').set('Authorization', 'Bearer good')).status).toBe(201);
  });

  it('never blocks sign-in (/api/auth/*), even for a cookie that is being refused elsewhere', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 2, writesMax: 100, authDistinctMax: 2 }, clock);
    for (let i = 0; i < 4; i++) await request(app).get('/api/thing').set('Cookie', 'pt_session=expired');
    expect((await request(app).get('/api/thing').set('Cookie', 'pt_session=expired')).status).toBe(429);
    // Offline replay was hammering with the expired cookie; the sign-in that fixes it still works.
    expect((await request(app).get('/api/auth/me').set('Cookie', 'pt_session=expired')).status).toBe(401);
    expect((await request(app).post('/api/auth/session').set('Cookie', 'pt_session=expired')).status).toBe(201);
  });

  it('brute force: many DIFFERENT wrong tokens from one ip hit the distinct-credential cap; proven devices keep working', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 10, writesMax: 1000, authDistinctMax: 5 }, clock);
    // A device that has already worked from this ip.
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer good')).status).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/thing').set('Authorization', `Bearer guess-${i}`)).status).toBe(401);
    }
    // Every new guess is now refused before it reaches the gate.
    const next = await request(app).get('/api/thing').set('Authorization', 'Bearer guess-99');
    expect(next.status).toBe(429);
    expect(next.headers['retry-after']).toBeDefined();
    // The device that had already succeeded here is not caught by it.
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer good')).status).toBe(200);
    // Window over: the cap starts again from zero.
    clock.t += 60_001;
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer guess-100')).status).toBe(401);
  });

  it('does not count 401s that carried no credential, or anything under /api/auth', async () => {
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 2, writesMax: 100, authDistinctMax: 2 }, clock);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get('/api/thing')).status).toBe(401); // signed-out browser, no credential
      expect((await request(app).get('/api/auth/me').set('Cookie', `pt_session=stale-${i}`)).status).toBe(401);
    }
    expect((await request(app).get('/api/thing')).status).toBe(401);
    expect((await request(app).get('/api/thing').set('Authorization', 'Bearer good')).status).toBe(200);
  });

  it('keys by client ip: on Vercel x-real-ip separates callers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('VERCEL', '1');
    const clock = { t: 0 };
    const app = appWith({ authFailuresMax: 2, writesMax: 100 }, clock);
    for (let i = 0; i < 2; i++) {
      await request(app).get('/api/thing').set('x-real-ip', '203.0.113.9').set('Authorization', 'Bearer guess');
    }
    const attacker = await request(app).get('/api/thing').set('x-real-ip', '203.0.113.9').set('Authorization', 'Bearer guess');
    expect(attacker.status).toBe(429);
    const sameTokenElsewhere = await request(app)
      .get('/api/thing')
      .set('x-real-ip', '198.51.100.7')
      .set('Authorization', 'Bearer guess');
    expect(sameTokenElsewhere.status).toBe(401);
  });

  it('keeps only a hash of the credential, never the credential', () => {
    const fake = (headers: Record<string, string>) => ({ headers }) as unknown as import('express').Request;
    const k = credentialKey(fake({ authorization: 'Bearer super-secret-token' }));
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain('super-secret');
    expect(credentialKey(fake({ authorization: 'Bearer other' }))).not.toBe(k);
    expect(credentialKey(fake({ cookie: 'pt_session=a' }))).not.toBe(credentialKey(fake({ cookie: 'pt_session=b' })));
    expect(credentialKey(fake({}))).toBeNull();
  });
});

describe('clientIp (PT43)', () => {
  const fakeReq = (headers: Record<string, string>, remote = '10.0.0.1') =>
    ({
      get: (h: string) => headers[h.toLowerCase()],
      socket: { remoteAddress: remote },
    }) as unknown as import('express').Request;

  it('ignores forwarding headers unless the platform (VERCEL) or TRUST_PROXY=1 vouches for them', () => {
    const req = fakeReq({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9' });
    expect(clientIp(req)).toBe('10.0.0.1');
    vi.stubEnv('TRUST_PROXY', '1');
    expect(clientIp(req)).toBe('1.2.3.4');
  });

  it('without x-real-ip, takes the RIGHT-most X-Forwarded-For hop (added by our proxy), not the client-chosen first', () => {
    vi.stubEnv('TRUST_PROXY', '1');
    // The client sent "X-Forwarded-For: 6.6.6.6"; nginx appended the real peer.
    expect(clientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(fakeReq({ 'x-forwarded-for': ' 9.9.9.9 ' }))).toBe('9.9.9.9');
    expect(clientIp(fakeReq({ 'x-forwarded-for': ' , ' }))).toBe('10.0.0.1');
  });
});

describe('rateLimitFromEnv (PT43)', () => {
  it('is off under Vitest unless RATE_LIMIT=on, and RATE_LIMIT=off always wins', () => {
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('RATE_LIMIT', '');
    expect(rateLimitFromEnv()).toBeNull();
    vi.stubEnv('RATE_LIMIT', 'on');
    expect(rateLimitFromEnv()).toEqual({ windowMs: 60_000, authFailuresMax: 10, authDistinctMax: 20, writesMax: 120 });
    vi.stubEnv('RATE_LIMIT', 'off');
    expect(rateLimitFromEnv()).toBeNull();
  });

  it('reads the tunables, ignoring nonsense', () => {
    vi.stubEnv('RATE_LIMIT', 'on');
    vi.stubEnv('RATE_LIMIT_WINDOW_SECONDS', '300');
    vi.stubEnv('RATE_LIMIT_AUTH_FAILURES', '5');
    vi.stubEnv('RATE_LIMIT_AUTH_DISTINCT', '40');
    vi.stubEnv('RATE_LIMIT_WRITES', 'lots');
    expect(rateLimitFromEnv()).toEqual({ windowMs: 300_000, authFailuresMax: 5, authDistinctMax: 40, writesMax: 120 });
  });
});

describe('FixedWindowCounter (PT43)', () => {
  it('counts per key inside a window and starts again after it', () => {
    let t = 0;
    const c = new FixedWindowCounter(1000, () => t);
    expect(c.hit('a').count).toBe(1);
    expect(c.hit('a').count).toBe(2);
    expect(c.hit('b').count).toBe(1);
    expect(c.peek('a').count).toBe(2);
    t = 1000;
    expect(c.peek('a').count).toBe(0);
    expect(c.hit('a')).toEqual({ count: 1, resetAt: 2000 });
  });
});
