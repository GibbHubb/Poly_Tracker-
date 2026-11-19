/**
 * PT27 — the orphan sweep: what it removes, what it must leave alone, and when it refuses.
 * PT44 — the four ways it could remove a live photo: a store/DB mismatch, files `put` never made,
 * a missing timestamp read as "old", and a file vanishing mid-listing.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// PT44 — lets a test delete a file in the window between readdir() and stat(), the way a
// concurrent DELETE /api/photos/:id would. Every other stat() is the real one.
const vanishOnStat = new Set<string>();
vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...real,
    stat: async (p: Parameters<typeof real.stat>[0]) => {
      if (vanishOnStat.has(String(p))) await real.unlink(p);
      return real.stat(p);
    },
  };
});

import {
  BackendMismatchRefusal,
  EmptyTableRefusal,
  MostlyUnclaimedRefusal,
  sweepOrphanPhotos,
} from '../src/lib/photoSweep.js';
import { createDiskStore } from '../src/storage/disk.js';
import { createSupabaseStore } from '../src/storage/supabase.js';
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

afterEach(() => {
  vanishOnStat.clear();
  vi.unstubAllGlobals();
});

describe('sweepOrphanPhotos (PT27)', () => {
  // PT44: enough claimed objects that the two unclaimed ones are not a majority.
  const objects = [
    { key: 'claimed.jpg', modifiedAt: daysAgo(30) },
    { key: 'claimed-2.jpg', modifiedAt: daysAgo(30) },
    { key: 'claimed-3.jpg', modifiedAt: daysAgo(30) },
    { key: 'old-orphan.jpg', modifiedAt: daysAgo(3) },
    { key: 'fresh-upload.jpg', modifiedAt: daysAgo(0.01) }, // its INSERT may still be on the way
  ];
  const claimed = ['claimed.jpg', 'claimed-2.jpg', 'claimed-3.jpg'];

  it('a dry run lists the old orphan and removes nothing', async () => {
    const store = fakeStore(objects);
    const r = await sweepOrphanPhotos(store, claimed, { apply: false, now: NOW });
    expect(r).toMatchObject({ stored: 5, claimed: 3, orphans: ['old-orphan.jpg'], tooNew: 1, removed: 0, applied: false });
    expect(store.removed).toEqual([]);
  });

  it('--apply removes only the unclaimed object older than the floor', async () => {
    const store = fakeStore(objects);
    const r = await sweepOrphanPhotos(store, claimed, { apply: true, now: NOW });
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
    expect(store.removed).toEqual(['claimed.jpg', 'claimed-2.jpg', 'claimed-3.jpg', 'old-orphan.jpg']);
  });

  it('the disk backend lists real files under the same keys put() returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pt27-'));
    const store = createDiskStore({ PHOTO_STORAGE_PATH: root });
    const kept = await store.put(Buffer.from('a'), '.jpg', 'image/jpeg');
    // PT44: an orphan is something put() wrote, so it has put()'s name shape.
    const orphan = join(root, `${randomUUID()}.jpg`);
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

describe('sweepOrphanPhotos refuses a sweep that would remove live photos (PT44)', () => {
  it('a disk store against a DB of Supabase keys (no key in common) is refused, not swept', async () => {
    const store = fakeStore([
      { key: '/data/photos/a.jpg', modifiedAt: daysAgo(5) },
      { key: '/data/photos/b.jpg', modifiedAt: daysAgo(5) },
    ]);
    const supabaseKeys = ['11111111-1111-4111-8111-111111111111.jpg'];
    await expect(sweepOrphanPhotos(store, supabaseKeys, { apply: true, now: NOW })).rejects.toBeInstanceOf(
      BackendMismatchRefusal,
    );
    // Not overridable by the majority flag: no overlap at all is never a clean-up.
    await expect(
      sweepOrphanPhotos(store, supabaseKeys, { apply: true, allowMostlyUnclaimed: true, now: NOW }),
    ).rejects.toBeInstanceOf(BackendMismatchRefusal);
    expect(store.removed).toEqual([]);
  });

  it('more than half the store unclaimed is refused unless explicitly allowed', async () => {
    const store = fakeStore([
      { key: 'kept.jpg', modifiedAt: daysAgo(5) },
      { key: 'o1.jpg', modifiedAt: daysAgo(5) },
      { key: 'o2.jpg', modifiedAt: daysAgo(5) },
    ]);
    await expect(sweepOrphanPhotos(store, ['kept.jpg'], { apply: true, now: NOW })).rejects.toBeInstanceOf(
      MostlyUnclaimedRefusal,
    );
    expect(store.removed).toEqual([]);

    const r = await sweepOrphanPhotos(store, ['kept.jpg'], { apply: true, allowMostlyUnclaimed: true, now: NOW });
    expect(store.removed).toEqual(['o1.jpg', 'o2.jpg']);
    expect(r.applied).toBe(true);
  });

  it('exactly half unclaimed is still a normal sweep', async () => {
    const store = fakeStore([
      { key: 'kept.jpg', modifiedAt: daysAgo(5) },
      { key: 'o1.jpg', modifiedAt: daysAgo(5) },
    ]);
    await sweepOrphanPhotos(store, ['kept.jpg'], { apply: true, now: NOW });
    expect(store.removed).toEqual(['o1.jpg']);
  });

  it('a dry run says which refusal --apply would hit', async () => {
    const store = fakeStore([
      { key: 'kept.jpg', modifiedAt: daysAgo(5) },
      { key: 'o1.jpg', modifiedAt: daysAgo(5) },
      { key: 'o2.jpg', modifiedAt: daysAgo(5) },
    ]);
    const r = await sweepOrphanPhotos(store, ['kept.jpg'], { apply: false, now: NOW });
    expect(r.wouldRefuse).toMatch(/more than half/i);
    expect(store.removed).toEqual([]);
  });

  it('a missing or unparseable timestamp is too new, never an orphan', async () => {
    const store = fakeStore([
      { key: 'kept-1.jpg', modifiedAt: daysAgo(5) },
      { key: 'kept-2.jpg', modifiedAt: daysAgo(5) },
      { key: 'kept-3.jpg', modifiedAt: daysAgo(5) },
      { key: 'no-time.jpg', modifiedAt: new Date(Number.NaN) },
      { key: 'garbage-time.jpg', modifiedAt: new Date('not a date') },
    ]);
    const r = await sweepOrphanPhotos(store, ['kept-1.jpg', 'kept-2.jpg', 'kept-3.jpg'], { apply: true, now: NOW });
    expect(r.orphans).toEqual([]);
    expect(r.tooNew).toBe(2);
    expect(store.removed).toEqual([]);
  });

  it('the disk backend lists only names put() generates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pt44-'));
    const store = createDiskStore({ PHOTO_STORAGE_PATH: root });
    const kept = await store.put(Buffer.from('a'), '.png', 'image/png');
    const noExt = await store.put(Buffer.from('a'), '', 'image/jpeg'); // put() falls back to .jpg
    for (const name of [
      '.gitkeep',
      `${randomUUID()}.jpg.bak`,
      'notes.txt',
      randomUUID(),
      `${randomUUID().toUpperCase()}.jpg`,
    ]) {
      writeFileSync(join(root, name), 'x');
    }
    expect((await store.list()).map((o) => o.key).sort()).toEqual([kept, noExt].sort());
  });

  it('a file deleted between readdir and stat is skipped, and the listing still finishes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pt44-'));
    const store = createDiskStore({ PHOTO_STORAGE_PATH: root });
    const kept = await store.put(Buffer.from('a'), '.jpg', 'image/jpeg');
    const gone = await store.put(Buffer.from('b'), '.jpg', 'image/jpeg');
    vanishOnStat.add(gone);
    expect((await store.list()).map((o) => o.key)).toEqual([kept]);
  });

  it('the supabase backend lists only put()-shaped names, and a missing timestamp is not "old"', async () => {
    const dated = `${randomUUID()}.jpg`;
    const undated = `${randomUUID()}.jpg`;
    const page = [
      { name: dated, id: 'a', updated_at: daysAgo(5).toISOString() },
      { name: undated, id: 'b' }, // no updated_at / created_at
      { name: '.emptyFolderPlaceholder', id: 'c', updated_at: daysAgo(5).toISOString() },
      { name: 'folder', id: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page), { status: 200 })));
    const store = createSupabaseStore({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
    const listed = await store.list();
    expect(listed.map((o) => o.key).sort()).toEqual([dated, undated].sort());
    const missing = listed.find((o) => o.key === undated)!;
    expect(Number.isFinite(missing.modifiedAt.getTime())).toBe(false);
  });
});
