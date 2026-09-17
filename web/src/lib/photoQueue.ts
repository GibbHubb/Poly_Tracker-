import { db, type QueuedPhoto } from './db';
import { getWriteToken } from './auth';

const BASE = import.meta.env.VITE_API_BASE || '/api';

/**
 * PT28 — iOS Safari's IndexedDB quota is small and eviction is silent, so the
 * queue refuses visibly past this many photos instead of risking losing them all.
 */
export const PHOTO_QUEUE_CAP = 20;

export class PhotoQueueFullError extends Error {
  constructor() {
    super(`Offline photo queue is full (${PHOTO_QUEUE_CAP}). Reconnect to upload before taking more.`);
  }
}

export type PhotoMeta = Omit<QueuedPhoto, 'id' | 'createdAt' | 'status' | 'lastError'>;

export async function queuePhoto(meta: PhotoMeta): Promise<{ id: string; queued: number }> {
  const queued = await db.photoQueue.where('status').equals('queued').count();
  if (queued >= PHOTO_QUEUE_CAP) throw new PhotoQueueFullError();
  const id = crypto.randomUUID();
  // Strictly increasing, so "oldest first" is defined even for two photos in the same millisecond
  // (a burst from the camera); a tie would otherwise upload in random id order.
  const last = await db.photoQueue.orderBy('createdAt').last();
  const createdAt = Math.max(Date.now(), (last?.createdAt ?? 0) + 1);
  await db.photoQueue.put({ ...meta, id, createdAt, status: 'queued' });
  // Ask the browser not to evict this origin's storage; best effort, ignored where unsupported.
  void navigator.storage?.persist?.().catch(() => undefined);
  return { id, queued: queued + 1 };
}

/** The multipart body the upload endpoint expects: the same shape the online path sends. */
export function photoForm(
  p: Pick<QueuedPhoto, 'blob' | 'filename' | 'featureType' | 'featureId' | 'lat' | 'lng' | 'takenAt'>,
): FormData {
  const form = new FormData();
  form.append('photo', p.blob, p.filename);
  if (p.featureType) form.append('feature_type', p.featureType);
  form.append('feature_id', p.featureId);
  form.append('taken_at', p.takenAt);
  if (p.lat != null && p.lng != null) {
    form.append('lat', String(p.lat));
    form.append('lng', String(p.lng));
  }
  return form;
}

/** 4xx answers that are about the moment, not the photo: retried, never marked failed. */
export const TRANSIENT_4XX = new Set([401, 403, 408, 425, 429]);
/** Consecutive 5xx answers for ONE photo before it stops blocking the queue. */
export const MAX_SERVER_ERRORS = 5;

async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error || body.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export interface PhotoReplayResult {
  uploaded: number;
  failed: number;
}

let running = false;

/**
 * Upload queued photos oldest-first. 2xx: removed. 4xx: marked 'failed' with the
 * server's reason and never retried (waiting cannot fix it). 5xx or a network
 * error: stop and keep the rest for the next attempt.
 */
export async function replayPhotoQueue(fetchImpl: typeof fetch = fetch): Promise<PhotoReplayResult> {
  if (running) return { uploaded: 0, failed: 0 };
  running = true;
  let uploaded = 0;
  let failed = 0;
  try {
    const queue = await db.photoQueue.where('status').equals('queued').sortBy('createdAt');
    for (const p of queue) {
      const headers: Record<string, string> = {};
      const token = getWriteToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
      let res: Response;
      try {
        res = await fetchImpl(`${BASE}/photos`, { method: 'POST', headers, body: photoForm(p) });
      } catch {
        break; // offline again
      }
      if (res.ok) {
        await db.photoQueue.delete(p.id);
        uploaded += 1;
        continue;
      }
      const reason = await errorReason(res);
      if (TRANSIENT_4XX.has(res.status)) {
        // No token yet, rate-limited, timed out: waiting CAN fix these. Keep queued, stop the run.
        await db.photoQueue.update(p.id, { lastError: reason });
        break;
      }
      if (res.status >= 400 && res.status < 500) {
        await db.photoQueue.update(p.id, { status: 'failed', lastError: reason });
        failed += 1;
        continue;
      }
      // 5xx. Usually the server is down, so stop — but a photo that fails the same way on every
      // attempt (e.g. over the upload size limit, answered as a 500) must not block the queue
      // behind it forever: after MAX_SERVER_ERRORS it is marked failed and the queue moves on.
      const attempts = (p.serverErrors ?? 0) + 1;
      if (attempts >= MAX_SERVER_ERRORS) {
        await db.photoQueue.update(p.id, { status: 'failed', serverErrors: attempts, lastError: `${reason} (${attempts} attempts)` });
        failed += 1;
        continue;
      }
      await db.photoQueue.update(p.id, { serverErrors: attempts, lastError: reason });
      break;
    }
  } finally {
    running = false;
  }
  return { uploaded, failed };
}
