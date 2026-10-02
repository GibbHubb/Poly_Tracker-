import { describe, expect, it, vi } from 'vitest';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { withClustersOff } from './clusters';

function fakeMap(loadedAfterCalls = 1) {
  const calls: Array<{ id: string; opts: unknown }> = [];
  let checks = 0;
  const map = {
    getSource: (id: string) => ({ setClusterOptions: (opts: unknown) => calls.push({ id, opts }) }),
    isSourceLoaded: () => ++checks > loadedAfterCalls,
  } as unknown as MapLibreMap;
  return { map, calls };
}

// PT32 — the PDF export draws every marker, then the map clusters again.
describe('withClustersOff', () => {
  it('turns clustering off around the export and back on after, toggling `cluster` only', async () => {
    const { map, calls } = fakeMap();
    const seen: unknown[] = [];
    const out = await withClustersOff(map, async () => {
      seen.push(...calls.map((c) => c.opts));
      return 'pdf';
    });
    expect(out).toBe('pdf');
    expect(seen).toEqual([{ cluster: false }, { cluster: false }]);
    // Never re-sends clusterRadius: MapLibre 3.6 would apply it unscaled.
    expect(calls.slice(2).map((c) => c.opts)).toEqual([{ cluster: true }, { cluster: true }]);
  });

  it('restores clustering when the export throws', async () => {
    const { map, calls } = fakeMap();
    await expect(withClustersOff(map, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(calls.at(-1)?.opts).toEqual({ cluster: true });
  });

  it('fails loudly, and restores, when the map never finishes redrawing', async () => {
    vi.useFakeTimers();
    const { map, calls } = fakeMap(Number.POSITIVE_INFINITY);
    const p = withClustersOff(map, async () => 'never');
    const assertion = expect(p).rejects.toThrow(/did not finish redrawing/);
    await vi.advanceTimersByTimeAsync(21000);
    await assertion;
    expect(calls.at(-1)?.opts).toEqual({ cluster: true });
    vi.useRealTimers();
  });
});
