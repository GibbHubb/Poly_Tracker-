/**
 * PT47 — the photo-bucket backup and its restore, against the real disk backend in a temp dir
 * and a stubbed fetch for the Supabase calls. No database and no network: the `photos` paths
 * are passed in, as the script passes them from `SELECT path FROM photos`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupPhotos,
  checkRestoreBucket,
  contentTypeFor,
  createDiskRestoreTarget,
  createSupabaseRestoreTarget,
  objectFileName,
  readManifest,
  restorePhotos,
} from '../src/lib/photoBackup.js';
import { createDiskStore } from '../src/storage/disk.js';
import { createSupabaseStore } from '../src/storage/supabase.js';
import type { PhotoStore } from '../src/storage/index.js';

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A disk store holding `n` photos of distinct sizes; returns their keys and bytes. */
async function seededStore(n: number) {
  const store = createDiskStore({ PHOTO_STORAGE_PATH: tmp('pt47-store-') } as NodeJS.ProcessEnv);
  const photos: { key: string; bytes: Buffer }[] = [];
  for (let i = 0; i < n; i++) {
    const bytes = Buffer.from(`photo-${i}-`.repeat(i + 3));
    photos.push({ key: await store.put(bytes, '.jpg', 'image/jpeg'), bytes });
  }
  return { store, photos };
}

/** Only list() and read() exist; any other call is a write the backup must never make. */
function readOnly(store: PhotoStore) {
  const calls: string[] = [];
  return {
    calls,
    view: {
      kind: store.kind,
      list: () => (calls.push('list'), store.list()),
      read: (k: string) => (calls.push('read'), store.read(k)),
      put: () => Promise.reject(new Error('backup wrote to the store')),
      remove: () => Promise.reject(new Error('backup removed from the store')),
    } as unknown as PhotoStore,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('backupPhotos (PT47)', () => {
  it('downloads every object, writes a manifest with sizes and hashes, and passes the DB check', async () => {
    const { store, photos } = await seededStore(3);
    const outDir = tmp('pt47-out-');
    const { view, calls } = readOnly(store);

    const r = await backupPhotos(view, photos.map((p) => p.key), { outDir });

    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ listed: 3, downloaded: 3, skipped: 0, failed: [], filesOnDisk: 3 });
    expect(r.bytesOnDisk).toBe(photos.reduce((n, p) => n + p.bytes.length, 0));
    expect(new Set(calls)).toEqual(new Set(['list', 'read']));
    for (const p of photos) {
      const file = objectFileName(p.key);
      expect(readFileSync(join(outDir, 'objects', file))).toEqual(p.bytes);
    }
    const m = await readManifest(outDir);
    expect(m).toMatchObject({ backend: 'disk', dbRows: 3, missing: [], unclaimed: [] });
    expect(m.objects.map((o) => o.sha256).sort()).toEqual(photos.map((p) => sha(p.bytes)).sort());
  });

  it('resumes: a second run downloads nothing and keeps what is there', async () => {
    const { store, photos } = await seededStore(3);
    const outDir = tmp('pt47-out-');
    await backupPhotos(store, photos.map((p) => p.key), { outDir });

    const { view, calls } = readOnly(store);
    const r = await backupPhotos(view, photos.map((p) => p.key), { outDir });
    expect(r).toMatchObject({ ok: true, downloaded: 0, skipped: 3 });
    expect(calls).toEqual(['list']);
  });

  it('re-downloads a file left short by a killed run, and ignores a stray .partial', async () => {
    const { store, photos } = await seededStore(2);
    const outDir = tmp('pt47-out-');
    await backupPhotos(store, photos.map((p) => p.key), { outDir });
    const short = join(outDir, 'objects', objectFileName(photos[0]!.key));
    writeFileSync(short, 'trunc');
    writeFileSync(join(outDir, 'objects', `${randomUUID()}.jpg.partial`), 'half a photo');

    const r = await backupPhotos(store, photos.map((p) => p.key), { outDir });
    expect(r).toMatchObject({ ok: true, downloaded: 1, skipped: 1, filesOnDisk: 2 });
    expect(readFileSync(short)).toEqual(photos[0]!.bytes);
  });

  it('fails when a photos row has no object in the store', async () => {
    const { store, photos } = await seededStore(2);
    const ghost = join('/data/photos', `${randomUUID()}.jpg`);
    const r = await backupPhotos(store, [...photos.map((p) => p.key), ghost], { outDir: tmp('pt47-out-') });
    expect(r.ok).toBe(false);
    expect(r.manifest.missing).toEqual([ghost]);
  });

  it('backs up an orphan object too, and reports it as unclaimed rather than failing', async () => {
    const { store, photos } = await seededStore(3);
    const r = await backupPhotos(store, photos.slice(1).map((p) => p.key), { outDir: tmp('pt47-out-') });
    expect(r.ok).toBe(true);
    expect(r.filesOnDisk).toBe(3);
    expect(r.manifest.unclaimed).toEqual([photos[0]!.key]);
  });

  it('carries on past an object it cannot read, fails the run, and a re-run fetches only that one', async () => {
    const { store, photos } = await seededStore(3);
    const outDir = tmp('pt47-out-');
    const bad = photos[1]!.key;
    let broken = true;
    const flaky = {
      kind: store.kind,
      list: () => store.list(),
      read: (k: string) => (broken && k === bad ? Promise.reject(new Error('HTTP 503')) : store.read(k)),
    };

    const first = await backupPhotos(flaky, photos.map((p) => p.key), { outDir });
    expect(first.ok).toBe(false);
    expect(first.failed).toEqual([{ key: bad, error: 'HTTP 503' }]);
    expect(first.manifest.missing).toEqual([bad]);
    expect(first.downloaded).toBe(2);

    broken = false;
    const second = await backupPhotos(flaky, photos.map((p) => p.key), { outDir });
    expect(second).toMatchObject({ ok: true, downloaded: 1, skipped: 2 });
  });

  it('refuses a download whose length differs from the listed size', async () => {
    const { store, photos } = await seededStore(1);
    const lying = {
      kind: store.kind,
      list: async () => (await store.list()).map((o) => ({ ...o, size: (o.size ?? 0) + 10 })),
      read: (k: string) => store.read(k),
    };
    const outDir = tmp('pt47-out-');
    const r = await backupPhotos(lying, photos.map((p) => p.key), { outDir });
    expect(r.ok).toBe(false);
    expect(r.failed[0]!.error).toMatch(/bytes, the store lists/);
    expect(readdirSync(join(outDir, 'objects'))).toEqual([]);
  });

  it('never writes a listed key that is not a stored-object name (no path escapes)', async () => {
    const outDir = tmp('pt47-out-');
    const evil = {
      kind: 'supabase' as const,
      list: async () => [{ key: '../../etc/passwd', modifiedAt: new Date() }],
      read: async () => Buffer.from('x'),
    };
    const r = await backupPhotos(evil, [], { outDir });
    expect(r.ok).toBe(false);
    expect(r.filesOnDisk).toBe(0);
  });
});

describe('restorePhotos (PT47)', () => {
  it('round-trips: backup then restore into a throwaway folder gives back identical bytes', async () => {
    const { store, photos } = await seededStore(3);
    const outDir = tmp('pt47-out-');
    await backupPhotos(store, photos.map((p) => p.key), { outDir });
    const throwaway = tmp('pt47-restore-');

    const r = await restorePhotos(createDiskRestoreTarget(throwaway), { fromDir: outDir });
    expect(r).toMatchObject({ ok: true, created: 3, existed: 0, corrupt: [], failed: [], absent: [] });
    for (const p of photos) expect(readFileSync(join(throwaway, objectFileName(p.key)))).toEqual(p.bytes);
  });

  it('never overwrites: an object already in the target is counted and left as it was', async () => {
    const { store, photos } = await seededStore(2);
    const outDir = tmp('pt47-out-');
    await backupPhotos(store, photos.map((p) => p.key), { outDir });
    const throwaway = tmp('pt47-restore-');
    const already = join(throwaway, objectFileName(photos[0]!.key));
    writeFileSync(already, 'newer bytes');

    const r = await restorePhotos(createDiskRestoreTarget(throwaway), { fromDir: outDir });
    expect(r).toMatchObject({ ok: true, created: 1, existed: 1 });
    expect(readFileSync(already, 'utf8')).toBe('newer bytes');
  });

  it('refuses to restore a file whose bytes no longer match the manifest', async () => {
    const { store, photos } = await seededStore(2);
    const outDir = tmp('pt47-out-');
    await backupPhotos(store, photos.map((p) => p.key), { outDir });
    const damaged = objectFileName(photos[1]!.key);
    writeFileSync(join(outDir, 'objects', damaged), 'bit rot');
    const throwaway = tmp('pt47-restore-');

    const r = await restorePhotos(createDiskRestoreTarget(throwaway), { fromDir: outDir });
    expect(r.ok).toBe(false);
    expect(r.corrupt).toEqual([damaged]);
    expect(r.absent).toEqual([damaged]);
    expect(existsSync(join(throwaway, damaged))).toBe(false);
  });
});

describe('restore target guard (PT47)', () => {
  it('refuses the production bucket without --into-production, and allows a throwaway one', () => {
    expect(checkRestoreBucket('poly-photos', 'poly-photos', false)).toMatch(/production photo bucket/);
    expect(checkRestoreBucket('poly-photos', 'poly-photos', true)).toBeNull();
    expect(checkRestoreBucket('poly-photos-restore-2026-11-25', 'poly-photos', false)).toBeNull();
    expect(checkRestoreBucket('', 'poly-photos', false)).toMatch(/--bucket/);
  });

  it('names content types for every extension put() writes', () => {
    expect(contentTypeFor('a.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('a.HEIC')).toBe('image/heic');
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream');
  });

  it('takes the bare file name from POSIX and Windows keys alike', () => {
    const name = `${randomUUID()}.jpg`;
    expect(objectFileName(name)).toBe(name);
    expect(objectFileName(`/data/photos/${name}`)).toBe(name);
    expect(objectFileName(`C:\\data\\photos\\${name}`)).toBe(name);
  });
});

describe('Supabase calls behind the backup (PT47, fetch stubbed)', () => {
  const env = {
    SUPABASE_URL: 'https://example.supabase.co/',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  } as NodeJS.ProcessEnv;
  const name = `${randomUUID()}.jpg`;

  it('read() is one authenticated GET and returns the bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from('jpeg bytes'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const buf = await createSupabaseStore(env).read(name);
    expect(buf.toString()).toBe('jpeg bytes');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://example.supabase.co/storage/v1/object/authenticated/poly-photos/${name}`);
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer service-role-key');
  });

  it('read() throws with the status only, never the response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('policy "secret_policy" denied', { status: 403 })));
    await expect(createSupabaseStore(env).read(name)).rejects.toThrow(/HTTP 403$/);
  });

  it('list() carries the object size from metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([{ name, id: 'x', updated_at: '2026-11-01T00:00:00Z', metadata: { size: 1234 } }]),
      ),
    );
    expect(await createSupabaseStore(env).list()).toEqual([
      { key: name, modifiedAt: new Date('2026-11-01T00:00:00Z'), size: 1234 },
    ]);
  });

  it('the restore target uploads with x-upsert false and treats a duplicate as "exists"', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response('{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const target = createSupabaseRestoreTarget({
      url: 'https://example.supabase.co',
      serviceKey: 'service-role-key',
      bucket: 'poly-photos-restore-2026-11-25',
    });

    await expect(target.upload(name, Buffer.from('x'), 'image/jpeg')).resolves.toBe('created');
    await expect(target.upload(name, Buffer.from('x'), 'image/jpeg')).resolves.toBe('exists');
    await expect(target.upload(name, Buffer.from('x'), 'image/jpeg')).rejects.toThrow(/HTTP 500$/);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://example.supabase.co/storage/v1/object/poly-photos-restore-2026-11-25/${name}`);
    expect((init.headers as Record<string, string>)['x-upsert']).toBe('false');
  });
});
