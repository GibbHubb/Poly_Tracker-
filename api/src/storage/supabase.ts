import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { PhotoStore, ResolvedPhoto } from './index.js';

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
  };
}
