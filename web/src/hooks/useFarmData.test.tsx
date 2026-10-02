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

/** Each farm's points come from `points[farmId]`, optionally delayed. */
function stubApi(points: Record<string, string[]>, delay: Record<string, number> = {}) {
  const wait = (id: string) => new Promise((r) => setTimeout(r, delay[id] ?? 0));
  vi.spyOn(api, 'getFarm').mockImplementation(async (id) => (await wait(id), farm(id)));
  vi.spyOn(api, 'listPaddocks').mockImplementation(async () => fc());
  vi.spyOn(api, 'listPolyRuns').mockImplementation(async () => fc());
  vi.spyOn(api, 'listFeatures').mockImplementation(async (id) => (await wait(id), fc(...(points[id] ?? []))));
}

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
    stubApi({ A: ['network'] });
    act(() => root.render(<Probe farmId="A" />));
    await flush(20);
    expect(names()).toEqual(['cached']);
    expect(latest!.source).toBe('cache');
    expect(latest!.fetchedAt).toBe(123);
    expect(api.listFeatures).not.toHaveBeenCalled();
  });

  it('offline, never seen: an explicit "no offline copy" message', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    vi.spyOn(api, 'getFarm').mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(api, 'listPaddocks').mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(api, 'listPolyRuns').mockRejectedValue(new TypeError('Failed to fetch'));
    vi.spyOn(api, 'listFeatures').mockRejectedValue(new TypeError('Failed to fetch'));
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
    vi.spyOn(api, 'getFarm').mockImplementation(async (id) => farm(id));
    vi.spyOn(api, 'listPaddocks').mockImplementation(async () => fc());
    vi.spyOn(api, 'listPolyRuns').mockImplementation(async () => fc());
    vi.spyOn(api, 'listFeatures').mockImplementation(async () => {
      call += 1;
      if (call === 2) return new Promise((r) => setTimeout(() => r(fc('stale')), 80));
      if (call === 3) return fc('fresh');
      return fc('initial');
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
    vi.spyOn(api, 'getFarm').mockRejectedValue(new ApiError(status, '{}'));
    vi.spyOn(api, 'listPaddocks').mockResolvedValue(fc());
    vi.spyOn(api, 'listPolyRuns').mockResolvedValue(fc());
    vi.spyOn(api, 'listFeatures').mockResolvedValue(fc());
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    expect(names()).toEqual(['cached']);
    expect(latest!.refreshError).toMatch(msg);
  });

  it('the queue draining triggers ONE refresh, after it settles', async () => {
    stubApi({ A: ['trough'] });
    await queueMutation({ id: 'q1', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/x', payload: null });
    await queueMutation({ id: 'q2', op: 'delete', method: 'DELETE', endpoint: '/farms/A/features/y', payload: null });
    act(() => root.render(<Probe farmId="A" />));
    await flush(30);
    const before = vi.mocked(api.listFeatures).mock.calls.length;
    await act(async () => {
      await db.pending.delete('q1');
    });
    await flush(50);
    await act(async () => {
      await db.pending.delete('q2');
    });
    await flush(DRAIN_REFRESH_MS + 100);
    expect(vi.mocked(api.listFeatures).mock.calls.length - before).toBe(1);
  });
});
