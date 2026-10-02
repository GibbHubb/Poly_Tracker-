// @vitest-environment node
/** PT35 — failures reach the user, and "offline" reads differently from "refused". */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { db, queueMutation } from './db';
import { describeError, requestIdOf, shouldQueue, useNotices } from './notify';
import { replayQueue } from './sync';

beforeEach(async () => {
  useNotices.setState({ notices: [] });
  await db.pending.clear();
  await db.conflicts.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('describeError', () => {
  it('names the action and says "no connection" for a network failure', () => {
    expect(describeError('Saving the new point', new TypeError('Failed to fetch'))).toBe(
      'Saving the new point failed: no connection to the server.',
    );
  });

  it('never shows a 500 body, but quotes its request id', () => {
    const e = new ApiError(500, '{"error":"Something went wrong","requestId":"abcd1234-0000"}');
    const text = describeError('Loading this farm', e);
    expect(text).toBe('Loading this farm failed: the server had a problem (ref abcd1234).');
    expect(requestIdOf(e)).toBe('abcd1234-0000');
  });

  it("shows our own 4xx/503 message, which is written for users", () => {
    expect(describeError('Saving', new ApiError(400, '{"error":"Malformed identifier or value."}'))).toBe(
      'Saving failed: Malformed identifier or value.',
    );
    expect(
      describeError('Saving', new ApiError(503, '{"error":"Writes are disabled: API_WRITE_TOKEN is not configured on this deployment."}')),
    ).toMatch(/Writes are disabled/);
  });

  it('points a 401 at Settings', () => {
    expect(describeError('Saving', new ApiError(401, '{"error":"Unauthorized"}'))).toMatch(/Settings/);
  });
});

describe('shouldQueue — only what waiting can fix', () => {
  it.each([
    ['network error', new TypeError('Failed to fetch'), true],
    ['500', new ApiError(500, ''), true],
    ['503', new ApiError(503, ''), true],
    ['401 (fix the token, then it replays)', new ApiError(401, ''), true],
    ['400 refused', new ApiError(400, ''), false],
    ['404 gone', new ApiError(404, ''), false],
    ['422 invalid', new ApiError(422, ''), false],
  ])('%s → %s', (_label, err, expected) => {
    expect(shouldQueue(err)).toBe(expected);
  });
});

describe('notices', () => {
  it('errors persist; a repeat of the same text replaces rather than stacks', () => {
    vi.useFakeTimers();
    const { push } = useNotices.getState();
    push({ kind: 'error', text: 'x failed' });
    push({ kind: 'error', text: 'x failed' });
    push({ kind: 'success', text: 'done' });
    expect(useNotices.getState().notices.map((n) => n.text)).toEqual(['x failed', 'done']);
    vi.advanceTimersByTime(6000);
    expect(useNotices.getState().notices.map((n) => n.text)).toEqual(['x failed']);
    vi.useRealTimers();
  });
});

describe('replayQueue reports a refusal instead of stalling silently', () => {
  it('a refused row (404) is set aside and no longer blocks the edits behind it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"The farm or record this refers to does not exist (it may have been deleted)."}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await queueMutation({ id: 'q-1', op: 'create', method: 'POST', endpoint: '/farms/gone/features', payload: {} });
    await new Promise((r) => setTimeout(r, 2));
    await queueMutation({ id: 'q-2', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });

    const r = await replayQueue();

    expect(r.replayed).toBe(1); // the edit behind it went through
    expect(await db.pending.count()).toBe(0);
    expect(await db.conflicts.get('q-1')).toMatchObject({ status: 404, endpoint: '/farms/gone/features' });
    const [n] = useNotices.getState().notices;
    expect(n?.kind).toBe('error');
    expect(n?.text).toMatch(/^1 saved edit was refused by the server and set aside \(Settings → Sync conflicts\)\. First refusal failed: it no longer exists/);
  });

  it('a 500 stops the run, keeps the queue, and says it will try again', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x","requestId":"abcdef12-0"}', { status: 500 })));
    await queueMutation({ id: 'q-1', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });
    await queueMutation({ id: 'q-2', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });

    await replayQueue();

    expect(await db.pending.count()).toBe(2);
    expect(await db.conflicts.count()).toBe(0);
    const [n] = useNotices.getState().notices;
    expect(n?.text).toBe(
      'Syncing 2 saved edits failed: the server had a problem (ref abcdef12). They stay on this device and sync will try again.',
    );
  });

  it('a network drop stays silent (that is the normal offline case)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    await queueMutation({ id: 'q-3', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: {} });
    await replayQueue();
    expect(await db.pending.count()).toBe(1);
    expect(useNotices.getState().notices).toHaveLength(0);
  });
});
