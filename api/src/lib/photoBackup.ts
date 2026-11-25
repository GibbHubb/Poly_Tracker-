import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import type { PhotoStore, StoredObject } from '../storage/index.js';
import { isStoredObjectName } from '../storage/objectName.js';

/**
 * PT47 — back up the photo BYTES (the `poly` dump only holds the `photos` rows), and put them
 * back into a throwaway bucket to prove the backup restores.
 *
 * Backup layout, one folder per run:
 *
 *   <out>/objects/<uuid>.<ext>   every object the store lists, under its bare name
 *   <out>/manifest.json          key, file, bytes and sha256 per object, plus the DB check
 *
 * The backup only calls `list()` and `read()`: nothing in the store is created, moved, signed
 * or removed. It is resumable: a file already in `objects/` with the listed size is kept, and a
 * download is written to `<name>.partial` and renamed, so a killed run never leaves a short file
 * under a real name. It is verified against the database: every `photos.path` must have a file.
 */

export const MANIFEST = 'manifest.json';
export const OBJECTS_DIR = 'objects';

export interface ManifestEntry {
  /** The key as the store listed it (an absolute path for disk, the object name for supabase). */
  key: string;
  /** The file under objects/. */
  file: string;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  createdAt: string;
  backend: string;
  objects: ManifestEntry[];
  /** `photos` rows at backup time. */
  dbRows: number;
  /** Rows whose object could not be backed up (absent from the store, or failed). Must be empty. */
  missing: string[];
  /** Objects no row claims (orphans, PT27). Backed up anyway; reported, not a failure. */
  unclaimed: string[];
}

export interface BackupResult {
  manifest: Manifest;
  listed: number;
  downloaded: number;
  skipped: number;
  failed: { key: string; error: string }[];
  /** Bytes in objects/ after the run, measured on disk. */
  bytesOnDisk: number;
  filesOnDisk: number;
  ok: boolean;
}

/** The bare file name of a key, whichever backend wrote it. */
export function objectFileName(key: string): string {
  return posix.basename(win32.basename(key));
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

async function sizeOf(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

export async function backupPhotos(
  store: Pick<PhotoStore, 'kind' | 'list' | 'read'>,
  dbPaths: Iterable<string>,
  opts: { outDir: string; now?: Date; log?: (line: string) => void },
): Promise<BackupResult> {
  const log = opts.log ?? (() => {});
  const objectsDir = join(opts.outDir, OBJECTS_DIR);
  await mkdir(objectsDir, { recursive: true });

  const listed: StoredObject[] = await store.list();
  const entries: ManifestEntry[] = [];
  const failed: BackupResult['failed'] = [];
  let downloaded = 0;
  let skipped = 0;

  for (const o of listed) {
    const file = objectFileName(o.key);
    // list() only returns names `put` wrote, but this name becomes a path: check it here too.
    if (!isStoredObjectName(file)) {
      failed.push({ key: o.key, error: 'not a stored-object name; not written' });
      continue;
    }
    const target = join(objectsDir, file);
    try {
      const have = await sizeOf(target);
      let buf: Buffer;
      // Resume trusts a local file of the listed size (or any size, when the store lists none):
      // its bytes are NOT compared with the store's, only hashed into the manifest. A same-size
      // file that is wrong stays wrong. For a clean backup, point --out at a new, empty folder.
      if (have !== null && (o.size === undefined || have === o.size)) {
        buf = await readFile(target);
        skipped++;
      } else {
        buf = await store.read(o.key);
        if (o.size !== undefined && buf.length !== o.size) {
          throw new Error(`read ${buf.length} bytes, the store lists ${o.size}`);
        }
        await writeFile(`${target}.partial`, buf);
        await rename(`${target}.partial`, target);
        downloaded++;
        log(`  ↓ ${file} (${buf.length} bytes)`);
      }
      entries.push({ key: o.key, file, bytes: buf.length, sha256: sha256(buf) });
    } catch (err) {
      failed.push({ key: o.key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const backedUp = new Set(entries.map((e) => e.key));
  const claimed = new Set(dbPaths);
  const missing = [...claimed].filter((p) => !backedUp.has(p)).sort();
  const unclaimed = entries.map((e) => e.key).filter((k) => !claimed.has(k)).sort();

  // Measure what is really on disk, not what the loop believes it wrote.
  let bytesOnDisk = 0;
  let filesOnDisk = 0;
  for (const name of await readdir(objectsDir)) {
    if (!isStoredObjectName(name)) continue; // a leftover .partial is not a backed-up object
    const size = await sizeOf(join(objectsDir, name));
    if (size === null) continue;
    filesOnDisk++;
    bytesOnDisk += size;
  }

  const manifest: Manifest = {
    createdAt: (opts.now ?? new Date()).toISOString(),
    backend: store.kind,
    objects: entries,
    dbRows: claimed.size,
    missing,
    unclaimed,
  };
  await writeFile(join(opts.outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);

  const manifestBytes = entries.reduce((n, e) => n + e.bytes, 0);
  const ok =
    failed.length === 0 &&
    missing.length === 0 &&
    filesOnDisk === entries.length &&
    bytesOnDisk === manifestBytes;
  return { manifest, listed: listed.length, downloaded, skipped, failed, bytesOnDisk, filesOnDisk, ok };
}

// ── Restore ─────────────────────────────────────────────────────────────────

/** Where a restore writes. Must never overwrite: an object already there is reported, not replaced. */
export interface RestoreTarget {
  readonly description: string;
  upload(name: string, bytes: Buffer, contentType: string): Promise<'created' | 'exists'>;
  /**
   * Every object now in the target with the byte size the target reports (undefined when it
   * reports none), to prove the restore landed with the right bytes, not just the right names.
   */
  sizes(): Promise<Map<string, number | undefined>>;
}

export interface RestoreResult {
  created: number;
  /** Already in the target and left as they were; counted only once their size matched too. */
  existed: number;
  corrupt: string[];
  failed: { file: string; error: string }[];
  /** Manifest objects not in the target after the run. Must be empty. */
  absent: string[];
  /**
   * In the target, but its size there differs from the manifest (or the target reports none).
   * Covers objects that `existed` too: an older or different object under the same name is
   * not a restored photo. Must be empty.
   */
  sizeMismatch: { file: string; expected: number; actual: number | null }[];
  ok: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export function contentTypeFor(name: string): string {
  const ext = posix.extname(name).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The production bucket is only a restore target when the caller says so in as many words
 * (`--into-production`). A drill goes into a throwaway bucket; a slip of the flag must not
 * make it a write against the live one.
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9._-]{2,62}$/;

/**
 * A bucket name that is safe to put in a URL path: no slash, no `..`, nothing to encode.
 * Without this, `--bucket x/../poly-photos` passed the string compare below and fetch
 * normalised the URL into the production bucket.
 */
export function invalidBucketName(bucket: string): string | null {
  if (!BUCKET_NAME.test(bucket) || bucket.includes('..')) {
    return `"${bucket}" is not a bucket name: 3-63 of a-z 0-9 . _ - , starting with a letter or digit, no "..".`;
  }
  return null;
}

export function checkRestoreBucket(bucket: string, productionBucket: string, intoProduction: boolean): string | null {
  if (!bucket) return 'Name the target bucket with --bucket <name>.';
  const invalid = invalidBucketName(bucket);
  if (invalid) return invalid;
  if (bucket.toLowerCase() === productionBucket.toLowerCase() && !intoProduction) {
    return (
      `"${bucket}" is the production photo bucket. A drill restores into a throwaway bucket ` +
      '(e.g. poly-photos-restore-<date>). For a real recovery add --into-production; it still never overwrites.'
    );
  }
  return null;
}

export async function readManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Manifest;
}

export async function restorePhotos(
  target: RestoreTarget,
  opts: { fromDir: string; log?: (line: string) => void },
): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const manifest = await readManifest(opts.fromDir);
  const result: RestoreResult = {
    created: 0,
    existed: 0,
    corrupt: [],
    failed: [],
    absent: [],
    sizeMismatch: [],
    ok: false,
  };

  for (const e of manifest.objects) {
    if (!isStoredObjectName(e.file)) {
      result.failed.push({ file: e.file, error: 'not a stored-object name' });
      continue;
    }
    try {
      const buf = await readFile(join(opts.fromDir, OBJECTS_DIR, e.file));
      // Check the backup before trusting it: a bad copy restored is a broken photo shipped.
      if (buf.length !== e.bytes || sha256(buf) !== e.sha256) {
        result.corrupt.push(e.file);
        continue;
      }
      const outcome = await target.upload(e.file, buf, contentTypeFor(e.file));
      if (outcome === 'created') {
        result.created++;
        log(`  ↑ ${e.file}`);
      } else {
        result.existed++;
      }
    } catch (err) {
      result.failed.push({ file: e.file, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Prove every manifest object is in the target at the manifest's size, whether this run
  // created it or found it there.
  const present = await target.sizes();
  for (const e of manifest.objects) {
    if (!present.has(e.file)) {
      result.absent.push(e.file);
      continue;
    }
    const actual = present.get(e.file);
    if (actual !== e.bytes) result.sizeMismatch.push({ file: e.file, expected: e.bytes, actual: actual ?? null });
  }
  result.absent.sort();
  result.ok =
    result.corrupt.length === 0 &&
    result.failed.length === 0 &&
    result.absent.length === 0 &&
    result.sizeMismatch.length === 0;
  return result;
}

/** A local folder as the throwaway target: what a fully offline drill points a local API at. */
export function createDiskRestoreTarget(root: string): RestoreTarget {
  return {
    description: `folder ${root}`,
    async upload(name, bytes) {
      await mkdir(root, { recursive: true });
      try {
        await writeFile(join(root, name), bytes, { flag: 'wx' });
        return 'created';
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
        throw err;
      }
    },
    async sizes() {
      const out = new Map<string, number | undefined>();
      let names: string[];
      try {
        names = (await readdir(root)).filter(isStoredObjectName);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
        throw err;
      }
      for (const name of names) {
        const size = await sizeOf(join(root, name));
        if (size !== null) out.set(name, size);
      }
      return out;
    },
  };
}

/**
 * A Supabase Storage bucket as the target, over the same REST API as storage/supabase.ts.
 * `x-upsert: false`, so an object already there answers a conflict and is left as it is.
 */
export function createSupabaseRestoreTarget(cfg: { url: string; serviceKey: string; bucket: string }): RestoreTarget {
  // Checked here as well as in checkRestoreBucket: this is where the name becomes a URL.
  const invalid = invalidBucketName(cfg.bucket);
  if (invalid) throw new Error(invalid);
  const bucket = encodeURIComponent(cfg.bucket);
  const url = cfg.url.replace(/\/+$/, '');
  const auth = { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` };
  return {
    description: `Supabase bucket ${cfg.bucket}`,
    async upload(name, bytes, contentType) {
      const res = await fetch(`${url}/storage/v1/object/${bucket}/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'false' },
        body: new Uint8Array(bytes),
      });
      if (res.ok) return 'created';
      const body = await res.text();
      // Storage answers a duplicate with 409, or with 400 and statusCode "409" in the body.
      if (res.status === 409 || /"statusCode"\s*:\s*"409"|Duplicate|already exists/i.test(body)) return 'exists';
      // Status only: the body can name buckets and policies.
      throw new Error(`upload failed: HTTP ${res.status}`);
    },
    async sizes() {
      const PAGE = 1000;
      const out = new Map<string, number | undefined>();
      for (let offset = 0; ; offset += PAGE) {
        const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: '', limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!res.ok) throw new Error(`list failed: HTTP ${res.status}`);
        const page = (await res.json()) as { name: string; id: string | null; metadata?: { size?: number } | null }[];
        for (const o of page) {
          if (o.id === null || !isStoredObjectName(o.name)) continue;
          const size = o.metadata?.size;
          out.set(o.name, typeof size === 'number' ? size : undefined);
        }
        if (page.length < PAGE) break;
      }
      return out;
    },
  };
}
