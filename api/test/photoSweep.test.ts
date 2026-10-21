/**
 * PT27 — the orphan sweep: what it removes, what it must leave alone, and when it refuses.
 */
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EmptyTableRefusal, sweepOrphanPhotos } from '../src/lib/photoSweep.js';
import { createDiskStore } from '../src/storage/disk.js';
import type { StoredObject } from '../src/storage/index.js';

const NOW = new Date('2026-10-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function fakeStore(objects: StoredObject[]) {
  const removed: string[] = [];
  return {
    removed,
    list: async () => objects,
    remove: async (key: string) => {
      removed.push(key);
    },
  };
}

describe('sweepOrphanPhotos (PT27)', () => {
  const objects = [
    { key: 'claimed.jpg', modifiedAt: daysAgo(30) },
    { key: 'old-orphan.jpg', modifiedAt: daysAgo(3) },
    { key: 'fresh-upload.jpg', modifiedAt: daysAgo(0.01) }, // its INSERT may still be on the way
  ];

  it('a dry run lists the old orphan and removes nothing', async () => {
    const store = fakeStore(objects);
    const r = await sweepOrphanPhotos(store, ['claimed.jpg'], { apply: false, now: NOW });
    expect(r).toMatchObject({ stored: 3, claimed: 1, orphans: ['old-orphan.jpg'], tooNew: 1, removed: 0, applied: false });
    expect(store.removed).toEqual([]);
  });

  it('--apply removes only the unclaimed object older than the floor', async () => {
    const store = fakeStore(objects);
    const r = await sweepOrphanPhotos(store, ['claimed.jpg'], { apply: true, now: NOW });
    expect(store.removed).toEqual(['old-orphan.jpg']);
    expect(r).toMatchObject({ removed: 1, applied: true });
  });

  it('refuses to apply when the table claims nothing but the store is not empty', async () => {
    const store = fakeStore(objects);
    await expect(sweepOrphanPhotos(store, [], { apply: true, now: NOW })).rejects.toBeInstanceOf(EmptyTableRefusal);
    expect(store.removed).toEqual([]);
  });

  it('…unless told the table really is empty', async () => {
    const store = fakeStore(objects);
    await sweepOrphanPhotos(store, [], { apply: true, allowEmptyTable: true, now: NOW });
    expect(store.removed).toEqual(['claimed.jpg', 'old-orphan.jpg']);
  });

  it('the disk backend lists real files under the same keys put() returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pt27-'));
    const store = createDiskStore({ PHOTO_STORAGE_PATH: root });
    const kept = await store.put(Buffer.from('a'), '.jpg', 'image/jpeg');
    const orphan = join(root, 'orphan.jpg');
    writeFileSync(orphan, 'b');
    const old = daysAgo(2);
    utimesSync(orphan, old, old);
    utimesSync(kept, old, old);

    expect((await store.list()).map((o) => o.key).sort()).toEqual([kept, orphan].sort());
    const r = await sweepOrphanPhotos(store, [kept], { apply: true, now: NOW });
    expect(r.removed).toBe(1);
    expect((await store.list()).map((o) => o.key)).toEqual([kept]);
  });
});
