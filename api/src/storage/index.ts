import { createDiskStore } from './disk.js';
import { createSupabaseStore } from './supabase.js';

/**
 * Where photo bytes live. Two backends behind one interface:
 *
 *   disk      — the original `multer.diskStorage` behaviour, for docker-compose
 *               and any self-hosted deployment with a real writable volume.
 *   supabase  — object storage, for Vercel, whose filesystem is read-only
 *               outside /tmp and ephemeral even there (PT21/PT24).
 *
 * `photos.path` in the database holds whatever the ACTIVE backend produced —
 * an absolute filesystem path for `disk`, an object key for `supabase`. Only
 * the backend interprets it, which is why the column did not need a migration.
 */
export interface PhotoStore {
  readonly kind: 'disk' | 'supabase';
  /**
   * Non-null when this deployment cannot accept uploads, carrying the reason.
   *
   * PT21: photo storage that is misconfigured must fail CLOSED with an
   * explanation, and must never throw at import time — a bare mkdirSync threw
   * EROFS while the module loaded and took down every route in the app, not
   * just this one. Construction records the problem; it does not raise.
   */
  readonly unavailable: string | null;
  /** Store bytes, return the key to persist in `photos.path`. */
  put(buf: Buffer, ext: string, contentType: string): Promise<string>;
  /** How the GET route should answer for this key. */
  resolve(key: string): Promise<ResolvedPhoto>;
  /** Best-effort delete. A missing object is not an error (matches ENOENT). */
  remove(key: string): Promise<void>;
}

export type ResolvedPhoto =
  | { kind: 'file'; path: string }
  | { kind: 'redirect'; url: string };

/**
 * Pick the backend from the environment.
 *
 * Defaults to `disk` on purpose: an incomplete or absent config must never
 * silently move where a self-hosted deployment writes its photos. Opting in to
 * object storage is explicit, and if that opt-in is incomplete the store comes
 * back `unavailable` (a 503 naming what is missing) rather than falling back to
 * a disk that is not there.
 */
export function createPhotoStore(env: NodeJS.ProcessEnv = process.env): PhotoStore {
  return env.PHOTO_BACKEND === 'supabase'
    ? createSupabaseStore(env)
    : createDiskStore(env);
}
