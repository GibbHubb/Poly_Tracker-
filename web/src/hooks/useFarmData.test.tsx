// @vitest-environment jsdom
/**
 * PT29 — the farm on screen: device copy first, network second, queued edits on
 * top; only the latest load lands; a failed refresh with a copy is reported.
 */
import 'fake-indexeddb/auto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, type GeoJsonFeature } from '../lib/api';
import { db, queueMutation } from '../lib/db';
import { DRAIN_REFRESH_MS, useFarmData, type FarmData } from './useFarmData';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fc = (...names: string[]) => ({
  type: 'FeatureCollection' as const,
  features: names.map(
    (n, i): GeoJsonFeature => ({
      type: 'Feature',
      id: `${n}-${i}`,
      geometry: { type: 'Point', coordinates: [150, -26] },
      properties: { name: n },
    }),
  ),
});
const farm = (id: string) => ({ id, name: `Farm ${id}`, owner: null, created_at: '' });

let latest: FarmData | null = null;
function Probe({ farmId }: { farmId: string }) {
  latest = useFarmData(farmId);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const flush = async (ms = 0) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
};

const bundle = (id: string, points: string[], fromCache = false) => ({
  farm: farm(id),
  paddocks: fc(),
  polyRuns: fc(),
  features: fc(...points),
  fromCache,
});

/** Each farm's points come from `points[farmId]`, optionally delayed. */
function stubApi(points: Record<string, string[]>, delay: Record<string, number> = {}) {
  return vi.spyOn(api, 'loadFarm').mockImplementation(async (id) => {
    await new Promise((r) => setTimeout(r, delay[id] ?? 0));
    return bundle(id, points[id] ?? []);
  });
}
const failLoad = (err: unknown) => vi.spyOn(api, 'loadFarm').mockRejectedValue(err);

beforeEach(async () => {
  await db.farmData.clear();
  await db.pending.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = null;
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const names = () => latest!.features.features.map((f) => f.properties.name);

describe('useFarmData', () => {
  it('online: loads from the network and keeps a device copy', async () => {
    stubApi({ A: ['trough'] });
    act(() => root.render(<Probe farmId="A" />));
    await flush(20);
    expect(latest!.source).toBe('network');
    expect(names()).toEqual(['trough']);
    expect((await db.farmData.get('A'))?.features.features).toHaveLength(1);
  });

  it('offline with a device copy: shows it, never calls the network', async () => {
    await db.farmData.put({ farmId: 'A', farm: farm('A'), paddocks: fc(), polyRuns: fc(), features: fc('cached'), fetchedAt: 123 });
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    const load = stubApi({ A: ['network'] });
    act(() => root.render(<Probe farmId="A" />));
    await flush(20);
    expect(names()).toEqual(['cached']);
    expect(latest!.source).toBe('cache');
    expect(latest!.fetchedAt).toBe(123);
    expect(load).not.toHaveBeenCalled();
  });

  it('offline, never seen: an explicit "no offline copy" message', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    failLoad(new TypeError('Failed to fetch'));
    act(() => root.render(<Probe farmId="Z" />));
    await flush(20);
    expect(latest!.loadError).toMatch(/No offline copy of this farm/);
  });

  it('queued edits are drawn on top of the copy', async () => {
    stubApi({ A: ['trough'] });
    act(() => root.render(<Probe farmId="A" />));
    await flush(20);
    await act(async () => {
      await queueMutation({
        id: 'q1', op: 'create', method: 'POST', endpoint: '/farms/A/features',
        payload: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { name: 'new' } },
      });
    });
    await flush(50);
    expect(names()).toEqual(['trough', 'new']);
    expect(latest!.pendingCount).toBe(1);
  });

  // Review finding 1: a slow load for farm A must not land on farm B.
  it('navigating A → B mid-load: A’s late answer is ignored', async () => {
    stubApi({ A: ['from-A'], B: ['from-B'] }, { A: 80, B: 0 });
    act(() => root.render(<Probe farmId="A" />));
    await flush(5);
    act(() => root.render(<Probe farmId="B" />));
    await flush(150);
    expect(latest!.farm?.id).toBe('B');
    expect(names()).toEqual(['from-B']);
  });

  // Review finding 2: two reloads finishing out of order — only the newest lands.
  it('out-of-order reloads: the older answer does not overwrite the newer one', async () => {
    let call = 0;
    vi.spyOn(api, 'loadFarm').mockImplementation(async (id) => {
      call += 1;
      if (call === 2) return new Promise((r) => setTimeout(() => r(bundle(id, ['stale'])), 80));
      if (call === 3) return bundle(id, ['fresh']);
      return bundle(id, ['initial']);
    });
    act(() => root.render(<Probe farmId="A" />));
    await flush(20);
    await act(async () => {
      const slow = latest!.reload(); // call 2, slow
      const fast = latest!.reload(); // call 3, fast
      await Promise.all([slow, fast]);
    });
    await flush(100);
    expect(names()).toEqual(['fresh']);
    expect((await db.farmData.get('A'))?.features.features[0]?.properties.name).toBe('fresh');
  });

  // Review finding 3: a copy in hand must not hide a refusal.
  it.each([
    [404, /no longer exists/],
    [401, /not allowed/],
  ])('a %i on refresh with a device copy is reported, the copy still shown', async (status, msg) => {
    await db.farmData.put({ farmId: 'A', farm: farm('A'), paddocks: fc(), polyRuns: fc(), features: fc('cached'), fetchedAt: 1 });
    failLoad(new ApiError(status, '{}'));
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    expect(names()).toEqual(['cached']);
    expect(latest!.refreshError).toMatch(msg);
  });

  it('the queue draining triggers ONE refresh, after it settles', async () => {
    const load = stubApi({ A: ['trough'] });
    await queueMutation({ id: 'q1', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/x', payload: null });
    await queueMutation({ id: 'q2', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/y', payload: null });
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    const before = load.mock.calls.length;
    await act(async () => {
      await db.pending.delete('q1');
    });
    await flush(50);
    await act(async () => {
      await db.pending.delete('q2');
    });
    await flush(DRAIN_REFRESH_MS + 100);
    expect(load.mock.calls.length - before).toBe(1);
  });

  // Re-review finding 2: a new edit queued inside the debounce window must not
  // cancel the refresh owed to the rows that already drained.
  it('drain, then a new edit queued within the window: the refresh still happens', async () => {
    const load = stubApi({ A: ['trough'] });
    await queueMutation({ id: 'q1', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/x', payload: null });
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    const before = load.mock.calls.length;
    await act(async () => {
      await db.pending.delete('q1');
    });
    await flush(50);
    await act(async () => {
      await queueMutation({ id: 'q3', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/z', payload: null });
    });
    await flush(DRAIN_REFRESH_MS + 100);
    expect(load.mock.calls.length - before).toBe(1);
  });

  // Re-review finding 3: a cache fallback while online is not "refreshing".
  it('online, but the service worker answered from cache: labelled cache, reported, not stored', async () => {
    vi.spyOn(api, 'loadFarm').mockResolvedValue(bundle('A', ['sw-copy'], true));
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    expect(names()).toEqual(['sw-copy']);
    expect(latest!.source).toBe('cache');
    expect(latest!.refreshError).toMatch(/Could not reach the server/);
    expect(await db.farmData.get('A')).toBeUndefined();
  });
});

// Re-review finding 1: the cache flag is per load, not a global counter.
describe('api.loadFarm cache flag', () => {
  const respond = (body: unknown, cached: boolean) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: cached
        ? { 'x-pt-from-cache': '1', 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
    });
  const answer = (cachedPart: string) =>
    vi.fn(async (url: string) =>
      url.endsWith('/farms/A') ? respond(farm('A'), cachedPart === 'farm') : respond(url.includes('/photos') ? [] : fc(), url.includes(cachedPart)),
    );

  it('a concurrent CACHED photo answer does not mark a fresh farm load as cached', async () => {
    vi.stubGlobal('fetch', answer('/photos'));
    const [loaded] = await Promise.all([api.loadFarm('A'), api.listPhotos({ farmId: 'A' })]);
    expect(loaded.fromCache).toBe(false);
    vi.unstubAllGlobals();
  });

  it('any of its own four answers from cache marks it cached', async () => {
    vi.stubGlobal('fetch', answer('/features'));
    expect((await api.loadFarm('A')).fromCache).toBe(true);
    vi.unstubAllGlobals();
  });
});
