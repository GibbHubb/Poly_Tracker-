import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PhotoStore, ResolvedPhoto } from './index.js';

/**
 * The original behaviour, unchanged in effect: a UUID filename under
 * PHOTO_STORAGE_PATH, and `photos.path` holds the absolute path.
 *
 * The one difference from the pre-PT24 code is that bytes arrive as a Buffer
 * (multer.memoryStorage) and are written here, rather than multer streaming
 * them to disk itself. That is what lets one route serve both backends.
 */
export function createDiskStore(env: NodeJS.ProcessEnv): PhotoStore {
  const root = env.PHOTO_STORAGE_PATH ?? '/data/photos';

  // PT21 — record, never throw. See the note on PhotoStore.unavailable.
  let unavailable: string | null = null;
  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    unavailable =
      `${root}: ${err instanceof Error ? err.message : String(err)}. ` +
      'Photo upload needs object storage on a read-only host — set PHOTO_BACKEND=supabase.';
    console.warn(`[photos] disk storage unusable — uploads will be refused with 503:`, unavailable);
  }

  return {
    kind: 'disk',
    get unavailable() {
      return unavailable;
    },
    async put(buf, ext) {
      const path = join(root, `${randomUUID()}${ext || '.jpg'}`);
      await writeFile(path, buf);
      return path;
    },
    async resolve(key): Promise<ResolvedPhoto> {
      // A row written by the SUPABASE backend holds a bare object key. Handing
      // that to res.sendFile() throws "path must be absolute" and surfaces as a
      // 500 on every such photo, which reads like an outage rather than a
      // misconfiguration. This is the mirror of the guard in supabase.ts.
      if (!isAbsolute(key)) {
        throw new Error(
          'This photo lives in object storage, not on local disk. ' +
          'Set PHOTO_BACKEND=supabase.',
        );
      }
      return { kind: 'file', path: key };
    },
    async remove(key) {
      try {
        await unlink(key);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') console.warn('[photos] unlink failed for', key, err);
      }
    },
  };
}
