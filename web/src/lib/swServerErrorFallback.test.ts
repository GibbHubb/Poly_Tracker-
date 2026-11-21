import { describe, it, expect } from 'vitest';
import { createServerErrorFallbackPlugin, isServerTrouble, ServerTroubleError } from './swServerErrorFallback';

const req = (path: string) => new Request(`https://app.test${path}`);

describe('service worker: 429/5xx fall back to the cache (PT43 review)', () => {
  it('treats 429 and 5xx as trouble, everything else as an answer', () => {
    expect([429, 500, 502, 503].every(isServerTrouble)).toBe(true);
    expect([200, 204, 304, 401, 404, 409, 412].some(isServerTrouble)).toBe(false);
  });

  it('passes a normal response straight through', async () => {
    const p = createServerErrorFallbackPlugin();
    const ok = new Response('[]', { status: 200 });
    expect(await p.fetchDidSucceed({ request: req('/api/farms'), response: ok })).toBe(ok);
    const notFound = new Response('{}', { status: 404 });
    expect(await p.fetchDidSucceed({ request: req('/api/farms/x'), response: notFound })).toBe(notFound);
  });

  it('throws on a 429 so NetworkFirst tries the cache', async () => {
    const p = createServerErrorFallbackPlugin();
    await expect(
      p.fetchDidSucceed({ request: req('/api/farms'), response: new Response('{}', { status: 429 }) }),
    ).rejects.toBeInstanceOf(ServerTroubleError);
  });

  it('with no cached copy, hands back the real server response (status, body) instead of a network error', async () => {
    const p = createServerErrorFallbackPlugin();
    const limited = new Response('{"error":"Too many requests","requestId":"r1"}', { status: 429 });
    await p.fetchDidSucceed({ request: req('/api/farms'), response: limited }).catch(() => {});
    // Workbox passes a different Request object for the same URL.
    const back = await p.handlerDidError({ request: req('/api/farms') });
    expect(back?.status).toBe(429);
    expect(await back?.json()).toEqual({ error: 'Too many requests', requestId: 'r1' });
    // Used once.
    expect(await p.handlerDidError({ request: req('/api/farms') })).toBeUndefined();
  });

  it('a later success for the URL drops a stale stashed error', async () => {
    const p = createServerErrorFallbackPlugin();
    await p.fetchDidSucceed({ request: req('/api/farms'), response: new Response('', { status: 503 }) }).catch(() => {});
    await p.fetchDidSucceed({ request: req('/api/farms'), response: new Response('[]', { status: 200 }) });
    expect(await p.handlerDidError({ request: req('/api/farms') })).toBeUndefined();
  });
});
