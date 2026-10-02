// @vitest-environment node
/** PT29 — the merge that decides what the user sees while edits are queued. */
import { describe, expect, it } from 'vitest';
import type { GeoJsonFeature } from './api';
import type { PendingMutation } from './db';
import {
  applyPending,
  isPendingFeature,
  PENDING_ID_PREFIX,
  pendingForFarm,
  targetOf,
  type FarmCollections,
} from './pendingOverlay';

const F = 'farm-1';
const fc = (...features: GeoJsonFeature[]) => ({ type: 'FeatureCollection' as const, features });
const pt = (id: string, name: string): GeoJsonFeature => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [150, -26] },
  properties: { name, version: 1 },
});
const base = (): FarmCollections => ({
  paddocks: fc(),
  polyRuns: fc(),
  features: fc(pt('a', 'Trough A'), pt('b', 'Trough B')),
});
let t = 0;
const m = (over: Partial<PendingMutation>): PendingMutation => ({
  id: `m${++t}`,
  op: 'create',
  method: 'POST',
  endpoint: `/farms/${F}/features`,
  payload: null,
  createdAt: t,
  ...over,
});

describe('applyPending', () => {
  it('no queue → the snapshot, unchanged', () => {
    const b = base();
    expect(applyPending(b, [], F)).toEqual(b);
  });

  it('a queued create appears, marked pending, with a temp id that is NOT in its properties', () => {
    const q = m({
      payload: { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 2] }, properties: { name: 'New' } },
    });
    const out = applyPending(base(), [q], F);
    expect(out.features.features).toHaveLength(3);
    const added = out.features.features[2]!;
    expect(added.id).toBe(`${PENDING_ID_PREFIX}${q.id}`);
    expect(isPendingFeature(added)).toBe(true);
    expect(JSON.stringify(added.properties)).not.toContain(PENDING_ID_PREFIX);
    // ...and the queued payload itself was not mutated (it is what gets replayed).
    expect(q.payload).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: { name: 'New' },
    });
  });

  it('routes creates by endpoint: paddocks and poly runs land in their own collection', () => {
    const geom = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    const out = applyPending(
      base(),
      [
        m({ endpoint: `/farms/${F}/paddocks`, payload: { type: 'Feature', geometry: geom, properties: {} } }),
        m({
          endpoint: `/farms/${F}/poly-runs`,
          payload: { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} },
        }),
      ],
      F,
    );
    expect(out.paddocks.features).toHaveLength(1);
    expect(out.polyRuns.features).toHaveLength(1);
    expect(out.features.features).toHaveLength(2);
  });

  it('a queued rename shows the new name and keeps the row id', () => {
    const out = applyPending(
      base(),
      [m({ op: 'update', method: 'PATCH', endpoint: `/farms/${F}/features/a`, payload: { properties: { name: 'Renamed' } } })],
      F,
    );
    const a = out.features.features.find((f) => f.id === 'a')!;
    expect(a.properties.name).toBe('Renamed');
    expect(a.properties.version).toBe(1);
    expect(isPendingFeature(a)).toBe(true);
  });

  it('a queued delete removes the row', () => {
    const out = applyPending(
      base(),
      [m({ op: 'delete', method: 'DELETE', endpoint: `/farms/${F}/features/b`, payload: null })],
      F,
    );
    expect(out.features.features.map((f) => f.id)).toEqual(['a']);
  });

  it('applies in createdAt order: rename then delete leaves nothing', () => {
    const del = m({ op: 'delete', method: 'DELETE', endpoint: `/farms/${F}/features/a` });
    const ren = m({ op: 'update', method: 'PATCH', endpoint: `/farms/${F}/features/a`, payload: { properties: { name: 'x' } } });
    ren.createdAt = 0; // older than the delete
    const out = applyPending(base(), [del, ren], F);
    expect(out.features.features.map((f) => f.id)).toEqual(['b']);
  });

  it('ignores other farms, unknown rows and malformed payloads (no-op, no throw)', () => {
    const out = applyPending(
      base(),
      [
        m({ endpoint: '/farms/other/features', payload: { geometry: { type: 'Point', coordinates: [0, 0] } } }),
        m({ method: 'PATCH', endpoint: `/farms/${F}/features/zzz`, payload: { properties: { name: 'x' } } }),
        m({ payload: 'garbage' }),
        m({ endpoint: '/photos' }),
      ],
      F,
    );
    expect(out).toEqual(base());
  });

  it('does not mutate the snapshot it was given', () => {
    const b = base();
    const before = JSON.stringify(b);
    applyPending(b, [m({ method: 'DELETE', endpoint: `/farms/${F}/features/a` })], F);
    expect(JSON.stringify(b)).toBe(before);
  });
});

describe('targetOf / pendingForFarm', () => {
  it('parses collection and id', () => {
    expect(targetOf(`/farms/${F}/poly-runs/r1`, F)).toEqual({ key: 'polyRuns', id: 'r1' });
    expect(targetOf(`/farms/${F}/paddocks`, F)).toEqual({ key: 'paddocks', id: null });
    expect(targetOf(`/farms/${F}`, F)).toBeNull();
  });
  it('counts only this farm', () => {
    expect(pendingForFarm([m({}), m({ endpoint: '/farms/x/features' })], F)).toBe(1);
  });
});
