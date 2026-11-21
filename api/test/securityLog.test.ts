/**
 * PT43 — security events (401/403) and the delete audit trail.
 * DB-free: a throwaway Express app with the real middleware.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createSecurityLog } from '../src/middleware/observability.js';

const FARM = '3f2b8c1e-9a7d-4e21-b0c4-5d6e7f8a9b0c';

function lines(...spies: ReturnType<typeof vi.spyOn>[]): Record<string, unknown>[] {
  return spies
    .flatMap((s) => s.mock.calls.map((c) => c[0]))
    .filter((x): x is string => typeof x === 'string' && x.startsWith('{'))
    .map((x) => JSON.parse(x) as Record<string, unknown>);
}

function appWith(identity?: unknown) {
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = 'req-1';
    next();
  });
  app.use(createSecurityLog(() => '203.0.113.5'));
  app.use((_req, res, next) => {
    if (identity) res.locals.identity = identity;
    next();
  });
  app.delete('/api/farms/:id', (req, res) => {
    if (req.params.id === 'missing') res.status(404).json({ error: 'Farm not found' });
    else res.status(204).end();
  });
  app.delete('/api/auth/session', (_req, res) => res.status(204).end());
  app.get('/api/private', (_req, res) => res.status(401).json({ error: 'Unauthorized' }));
  app.get('/api/auth/me', (_req, res) => res.status(401).json({ error: 'Not signed in.' }));
  app.post('/api/farms/:id/members', express.json(), (req, res, next) => {
    if (req.body?.role === 'refuse') res.status(403).json({ error: 'Only a farm owner can do that.' });
    else if (req.body?.user_id) res.status(201).json({ ok: true });
    else next();
  });
  app.get('/api/ok', (_req, res) => res.json({ ok: true }));
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('security log — auth failures (PT43)', () => {
  it('a 401 emits one security line: event, method, route shape, status, request id, ip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(appWith()).get('/api/private?x=1').set('Authorization', 'Bearer s3cret-token-value');
    expect(res.status).toBe(401);
    const sec = lines(warn).filter((l) => l.msg === 'security');
    expect(sec).toHaveLength(1);
    expect(sec[0]).toMatchObject({
      level: 'warn',
      event: 'auth.failure',
      method: 'GET',
      path: '/api/private',
      status: 401,
      requestId: 'req-1',
      ip: '203.0.113.5',
      credential: 'bearer',
    });
  });

  it('never logs the credential itself, bearer or cookie', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(appWith()).get('/api/private').set('Authorization', 'Bearer s3cret-token-value');
    await request(appWith()).get('/api/private').set('Cookie', 'pt_session=c00kie-secret');
    const out = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
    expect(out).not.toContain('s3cret-token-value');
    expect(out).not.toContain('c00kie-secret');
    expect(lines(warn).map((l) => l.credential)).toEqual(['bearer', 'cookie']);
  });

  it('the signed-out "am I signed in?" probe is not a security event; a stale cookie on it is', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await request(appWith()).get('/api/auth/me');
    expect(lines(warn)).toHaveLength(0);
    await request(appWith()).get('/api/auth/me').set('Cookie', 'pt_session=stale');
    expect(lines(warn)).toEqual([expect.objectContaining({ event: 'auth.failure', credential: 'cookie' })]);
  });

  it('a 403 is an auth.forbidden event; a 200 logs nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(appWith()).post(`/api/farms/${FARM}/members`).send({ user_id: 'x', role: 'refuse' });
    await request(appWith()).get('/api/ok');
    const all = lines(warn, log);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ event: 'auth.forbidden', status: 403, path: '/api/farms/:id/members', credential: 'none' });
  });
});

describe('audit trail — deletes (PT43)', () => {
  it('a successful DELETE emits an audit line with the exact path (ids kept) and the actor', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await request(appWith({ kind: 'user', userId: 'u-42', email: 'max@example.com', via: 'cookie' }))
      .delete(`/api/farms/${FARM}`);
    expect(res.status).toBe(204);
    const audit = lines(log).filter((l) => l.msg === 'audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      level: 'info',
      event: 'delete',
      path: `/api/farms/${FARM}`,
      status: 204,
      requestId: 'req-1',
      actor: 'user',
      userId: 'u-42',
    });
    // Who, not their email.
    expect(JSON.stringify(audit[0])).not.toContain('max@example.com');
  });

  it('names the shared token or open mode when there is no signed-in person', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('API_WRITE_TOKEN', 'w');
    await request(appWith({ kind: 'open' })).delete(`/api/farms/${FARM}`);
    vi.stubEnv('API_WRITE_TOKEN', '');
    vi.stubEnv('API_TOKEN', '');
    await request(appWith({ kind: 'open' })).delete(`/api/farms/${FARM}`);
    await request(appWith({ kind: 'legacy', canWrite: true })).delete(`/api/farms/${FARM}`);
    expect(lines(log).map((l) => l.actor)).toEqual(['write-token', 'open', 'legacy-write-token']);
  });

  it('granting a role is an audit event naming the member, the role and the actor', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const member = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    await request(appWith({ kind: 'user', userId: 'owner-1', email: null, via: 'cookie' }))
      .post(`/api/farms/${FARM}/members`)
      .send({ user_id: member, role: 'viewer' });
    const audit = lines(log).filter((l) => l.msg === 'audit');
    expect(audit).toEqual([
      expect.objectContaining({ event: 'member.grant', path: `/api/farms/${FARM}/members`, member, role: 'viewer', actor: 'user', userId: 'owner-1', status: 201 }),
    ]);
  });

  it('a refused or failed DELETE, and signing out, are not audit events', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await request(appWith()).delete('/api/farms/missing');
    await request(appWith()).delete('/api/auth/session');
    expect(lines(log).filter((l) => l.msg === 'audit')).toHaveLength(0);
  });
});
