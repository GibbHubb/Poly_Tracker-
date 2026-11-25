import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { PhotoStore, ResolvedPhoto, StoredObject } from './index.js';
import { isStoredObjectName } from './objectName.js';

/**
 * Supabase Storage over its REST API.
 *
 * Deliberately no `@supabase/supabase-js`: the three calls we need are plain
 * HTTP, and a serverless function pays for every dependency at cold start.
 *
 * The bucket is PRIVATE. Reads go out as short-lived signed URLs, so the
 * service-role key never reaches a browser.
 */
const SIGNED_URL_TTL_SECONDS = 60;

export function createSupabaseStore(env: NodeJS.ProcessEnv): PhotoStore {
  const url = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const bucket = env.SUPABASE_PHOTO_BUCKET ?? 'poly-photos';

  // Fail closed, with the reason, rather than 500ing on the first upload.
  const missing = [
    !url && 'SUPABASE_URL',
    !key && 'SUPABASE_SERVICE_ROLE_KEY',
  ].filter(Boolean);
  const unavailable = missing.length
    ? `PHOTO_BACKEND=supabase but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set.`
    : null;
  if (unavailable) console.warn('[photos] supabase storage unusable:', unavailable);

  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  const object = (k: string) => `${url}/storage/v1/object/${bucket}/${encodeURI(k)}`;

  return {
    kind: 'supabase',
    unavailable,
    async put(buf, ext, contentType) {
      const objectKey = `${randomUUID()}${ext || '.jpg'}`;
      const res = await fetch(object(objectKey), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': contentType || 'application/octet-stream' },
        body: new Uint8Array(buf),
      });
      if (!res.ok) {
        // The body can name buckets, policies and internal paths, and
        // errorHandler returns err.message verbatim to the caller — log it,
        // do not disclose it.
        console.error(`[photos] upload failed: HTTP ${res.status}`, await res.text());
        throw new Error('Could not store the photo.');
      }
      return objectKey;
    },
    async resolve(objectKey): Promise<ResolvedPhoto> {
      // A row written by the DISK backend holds an absolute path, not an
      // object key. Signing it would 404 and surface as a 500 on every legacy
      // photo. Say what actually happened instead.
      if (isAbsolute(objectKey)) {
        throw new Error(
          'This photo was stored on local disk by a previous deployment and is ' +
          'not in object storage. Re-upload it, or set PHOTO_BACKEND=disk.',
        );
      }
      const res = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encodeURI(objectKey)}`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
      });
      if (!res.ok) {
        console.error(`[photos] signing failed: HTTP ${res.status}`, await res.text());
        throw new Error('Could not read the photo.');
      }
      // signedURL comes back relative, e.g. "/object/sign/<bucket>/<key>?token=…"
      const { signedURL } = (await res.json()) as { signedURL: string };
      return { kind: 'redirect', url: `${url}/storage/v1${signedURL}` };
    },
    async remove(objectKey) {
      // Best-effort, like the disk backend's ENOENT handling. The row is
      // already deleted by the time we get here, so throwing would turn a
      // successful delete into a 500 and the retry would 404. A network-level
      // rejection is not an HTTP status, so catch rather than check.
      try {
        const res = await fetch(object(objectKey), { method: 'DELETE', headers: auth });
        // 404 = already gone, which is the desired end state anyway.
        if (!res.ok && res.status !== 404) {
          console.warn(`[photos] delete failed for ${objectKey}: HTTP ${res.status}`);
        }
      } catch (err) {
        console.warn(`[photos] delete failed for ${objectKey}:`, err);
      }
    },
    async list(): Promise<StoredObject[]> {
      // Objects sit at the bucket root (put never adds a prefix). The list API
      // pages at `limit`; a short page is the last one.
      const PAGE = 1000;
      const out: StoredObject[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const res = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: '', limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!res.ok) {
          console.error(`[photos] list failed: HTTP ${res.status}`, await res.text());
          throw new Error('Could not list stored photos.');
        }
        const page = (await res.json()) as {
          name: string;
          id: string | null;
          updated_at?: string;
          created_at?: string;
          metadata?: { size?: number } | null;
        }[];
        for (const o of page) {
          if (o.id === null) continue; // a folder placeholder, not an object
          // PT44 — only what `put` wrote; the sweep removes whatever this returns.
          if (!isStoredObjectName(o.name)) continue;
          // PT44 — no timestamp must read as "unknown age" (an Invalid Date, which
          // the sweep treats as too new), never as the epoch, which made a fresh
          // upload look decades old.
          const when = o.updated_at ?? o.created_at;
          const size = o.metadata?.size;
          out.push({
            key: o.name,
            modifiedAt: when ? new Date(when) : new Date(Number.NaN),
            ...(typeof size === 'number' ? { size } : {}),
          });
        }
        if (page.length < PAGE) break;
      }
      return out;
    },
    async read(objectKey) {
      // PT47 — a plain authenticated GET: read-only, no signed URL minted.
      if (isAbsolute(objectKey)) {
        throw new Error('This photo was stored on local disk, not in object storage.');
      }
      const res = await fetch(`${url}/storage/v1/object/authenticated/${bucket}/${encodeURI(objectKey)}`, {
        headers: auth,
      });
      if (!res.ok) {
        // Status only: the body can name buckets and policies (see put()).
        throw new Error(`Could not read ${objectKey}: HTTP ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
