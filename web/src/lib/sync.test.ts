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
