// @vitest-environment node
/**
 * PT36 — the Dexie upgrade path must not eat a field user's queue.
 *
 * A phone that last ran a v4 bundle (PT15) has queued edits and conflict
 * records in IndexedDB. The current bundle opens the same database at a higher
 * version; this opens a REAL v4 database first (fake-indexeddb), writes rows the
 * way that bundle did, closes it, then lets the current schema upgrade it.
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';

describe('Dexie upgrade v4 → current', () => {
  it('keeps pending + conflict rows and adds the new stores', async () => {
    const old = new Dexie('poly_tracker');
    old.version(4).stores({
      pending: 'id, createdAt',
      farms: 'id',
      conflicts: 'id, resolvedAt',
      offlineAreas: 'id, createdAt',
    });
    await old.open();
    await old.table('pending').bulkPut([
      { id: 'p1', op: 'create', method: 'POST', endpoint: '/farms/f/features', payload: { a: 1 }, createdAt: 1 },
      { id: 'p2', op: 'update', method: 'PATCH', endpoint: '/farms/f/paddocks/x', payload: {}, createdAt: 2, baseVersion: 3 },
    ]);
    await old.table('conflicts').put({ id: 'c1', op: 'update', endpoint: '/farms/f/paddocks/y', method: 'PATCH', status: 412, resolvedAt: 5, payload: { b: 2 } });
    await old.table('offlineAreas').put({ id: 'a1', name: 'Home', createdAt: 9 });
    old.close();

    // Import AFTER the v4 database exists, so the current schema upgrades it.
    const { db, pendingCount } = await import('./db');
    expect(db.verno).toBeGreaterThan(4);

    const pending = await db.pending.orderBy('createdAt').toArray();
    expect(pending.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(pending[1]!.baseVersion).toBe(3);
    expect(await db.conflicts.get('c1')).toMatchObject({ status: 412, payload: { b: 2 } });
    expect(await db.offlineAreas.count()).toBe(1);

    // Stores added since v4 exist and work.
    await db.farmData.put({
      farmId: 'f',
      farm: { id: 'f', name: 'F', owner: null, created_at: '' },
      paddocks: { type: 'FeatureCollection', features: [] },
      polyRuns: { type: 'FeatureCollection', features: [] },
      features: { type: 'FeatureCollection', features: [] },
      fetchedAt: 1,
    });
    expect(await db.farmData.count()).toBe(1);
    expect(await db.photoQueue.count()).toBe(0);
    expect(await pendingCount()).toBe(2);
  });
});
