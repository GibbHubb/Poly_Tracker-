// @vitest-environment node
/** PT40 — a replayed edit the server refuses is logged AND announced on screen. */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, queueMutation } from './db';
import { replayQueue } from './sync';
import { conflictReviewPath, recordKind, useConflictNotice } from './conflictNotice';

beforeEach(async () => {
  await db.pending.clear();
  await db.conflicts.clear();
  useConflictNotice.getState().dismiss();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('replayQueue conflict notice', () => {
  it('raises a notice for a 412 and keeps the conflict for review', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"version_mismatch"}', { status: 412 })),
    );
    await queueMutation({
      id: 'm-1',
      op: 'update',
      method: 'PATCH',
      endpoint: '/farms/f/paddocks/p-1',
      payload: { properties: { name: 'x' } },
      baseVersion: 2,
    });

    const r = await replayQueue();

    expect(r.conflicts).toHaveLength(1);
    expect(await db.conflicts.get('m-1')).toMatchObject({
      status: 412,
      endpoint: '/farms/f/paddocks/p-1',
    });
    expect(useConflictNotice.getState().notice).toEqual({
      conflictId: 'm-1',
      endpoint: '/farms/f/paddocks/p-1',
      count: 1,
    });
  });

  it('raises nothing when the replay succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    await queueMutation({
      id: 'm-2',
      op: 'update',
      method: 'PATCH',
      endpoint: '/farms/f/poly-runs/r',
      payload: {},
    });
    await replayQueue();
    expect(useConflictNotice.getState().notice).toBeNull();
  });
});

describe('notice helpers', () => {
  it('counts repeated conflicts and points at the latest', () => {
    const { notify } = useConflictNotice.getState();
    notify('a', '/farms/f/poly-runs/1');
    notify('b', '/farms/f/paddocks/2');
    expect(useConflictNotice.getState().notice).toEqual({
      conflictId: 'b',
      endpoint: '/farms/f/paddocks/2',
      count: 2,
    });
  });

  it('names the record kind and builds the review link', () => {
    expect(recordKind('/farms/f/poly-runs/1')).toBe('poly run');
    expect(recordKind('/farms/f/paddocks/1')).toBe('paddock');
    expect(recordKind('/farms/f/features/1')).toBe('feature');
    expect(conflictReviewPath('a b')).toBe('/settings?conflict=a%20b');
  });
});

// PT36 — the replay's own contract: drains in order, replays against the
// version the edit was made on, and keeps the queue when the network drops.
describe('replayQueue contract', () => {
  it('drains oldest-first, emits If-Match only for edits with a base version, and empties the queue', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 200 });
      }),
    );
    await queueMutation({ id: 'a', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: { n: 1 } });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation({ id: 'b', op: 'update', method: 'PATCH', endpoint: '/farms/f/paddocks/p', payload: {}, baseVersion: 7 });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation({ id: 'c', op: 'delete', method: 'DELETE', endpoint: '/farms/f/features/x', payload: null });

    const r = await replayQueue();

    expect(r.replayed).toBe(3);
    expect(await db.pending.count()).toBe(0);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST /api/farms/f/features',
      'PATCH /api/farms/f/paddocks/p',
      'DELETE /api/farms/f/features/x',
    ]);
    const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
    expect(h(0)['If-Match']).toBeUndefined();
    expect(h(1)['If-Match']).toBe('"7"');
    expect(calls[2]!.init.body).toBeUndefined();
  });

  it('a network drop mid-queue keeps the rest, in order', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1;
        if (n === 2) throw new TypeError('Failed to fetch');
        return new Response('{}', { status: 200 });
      }),
    );
    await queueMutation({ id: 'a', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation({ id: 'b', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation({ id: 'c', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });
    const r = await replayQueue();
    expect(r.replayed).toBe(1);
    expect((await db.pending.orderBy('createdAt').toArray()).map((p) => p.id)).toEqual(['b', 'c']);
  });
});
