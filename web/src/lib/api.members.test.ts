// PT33 — the farm-membership calls the Settings account panel makes. They only
// matter in users mode, which is why nothing exercised them before: pin the
// URL, method and body each one sends, and that a refusal surfaces as ApiError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from './api';

function reply(status: number, body?: unknown) {
  return vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('farm membership api (PT33)', () => {
  it('listMembers GETs the farm members', async () => {
    const rows = [{ user_id: 'u1', role: 'owner', created_at: '2026-11-19T00:00:00Z' }];
    const fetchMock = reply(200, rows);
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.listMembers('f1')).resolves.toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(url).toMatch(/\/farms\/f1\/members$/);
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('addMember POSTs the user id and role', async () => {
    const fetchMock = reply(201, { user_id: 'u2', role: 'editor', created_at: 't' });
    vi.stubGlobal('fetch', fetchMock);
    await api.addMember('f1', 'u2', 'editor');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/farms\/f1\/members$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ user_id: 'u2', role: 'editor' });
  });

  it('removeMember DELETEs that member and treats 204 as done', async () => {
    const fetchMock = reply(204);
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.removeMember('f1', 'u2')).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/farms\/f1\/members\/u2$/);
    expect(init.method).toBe('DELETE');
  });

  it('a refused change surfaces as ApiError with the status', async () => {
    vi.stubGlobal('fetch', reply(403, { error: 'owners only' }));
    const err = await api.addMember('f1', 'u3', 'viewer').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(403);
  });
});
