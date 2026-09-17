// @vitest-environment node
/**
 * PT28 — a photo taken offline is kept on the device and uploaded later, instead of being
 * thrown away behind a "Saved offline" message. Runs against a real IndexedDB implementation
 * (fake-indexeddb), so Dexie's schema, indexes and Blob storage are exercised, not mocked.
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pendingCount } from './db';
import { MAX_SERVER_ERRORS, PHOTO_QUEUE_CAP, PhotoQueueFullError, queuePhoto, replayPhotoQueue } from './photoQueue';

const meta = (over: Partial<Parameters<typeof queuePhoto>[0]> = {}) => ({
  blob: new Blob([new Uint8Array(1234)], { type: 'image/jpeg' }),
  filename: 'trough.jpg',
  featureType: 'trough',
  featureId: 'f-1',
  lat: -25.12345,
  lng: 133.54321,
  takenAt: '2026-09-17T08:00:00.000Z',
  ...over,
});

const response = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(async () => {
  await db.photoQueue.clear();
  await db.pending.clear();
});

describe('queuePhoto', () => {
  it('stores the bytes and the queue-time location', async () => {
    const { queued } = await queuePhoto(meta());
    expect(queued).toBe(1);
    const row = (await db.photoQueue.toArray())[0]!;
    expect(row.blob.size).toBe(1234);
    expect([row.lat, row.lng]).toEqual([-25.12345, 133.54321]);
    expect(row.status).toBe('queued');
  });

  it('counts queued photos in the pending badge alongside JSON edits', async () => {
    await db.pending.put({ id: 'm1', op: 'update', endpoint: '/x', method: 'PATCH', payload: {}, createdAt: 1 });
    await queuePhoto(meta());
    expect(await pendingCount()).toBe(2);
  });

  it('refuses visibly past the cap instead of risking silent eviction', async () => {
    for (let i = 0; i < PHOTO_QUEUE_CAP; i++) await queuePhoto(meta());
    await expect(queuePhoto(meta())).rejects.toBeInstanceOf(PhotoQueueFullError);
    expect(await db.photoQueue.count()).toBe(PHOTO_QUEUE_CAP);
  });
});

describe('replayPhotoQueue', () => {
  it('uploads oldest-first with the queued location, then empties the queue', async () => {
    await queuePhoto(meta({ filename: 'first.jpg' }));
    await queuePhoto(meta({ filename: 'second.jpg', lat: 1, lng: 2 }));
    const sent: FormData[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(init!.body as FormData);
      return response(201, { id: 'p' });
    });

    const r = await replayPhotoQueue(fetchImpl as unknown as typeof fetch);

    expect(r).toEqual({ uploaded: 2, failed: 0 });
    expect(await db.photoQueue.count()).toBe(0);
    expect((sent[0]!.get('photo') as File).name).toBe('first.jpg');
    expect(sent[0]!.get('lat')).toBe('-25.12345');
    expect(sent[1]!.get('lat')).toBe('1');
    expect(sent[0]!.get('feature_id')).toBe('f-1');
  });

  it('keeps everything when the network is still down', async () => {
    await queuePhoto(meta());
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await replayPhotoQueue(fetchImpl as unknown as typeof fetch)).toEqual({ uploaded: 0, failed: 0 });
    expect(await db.photoQueue.where('status').equals('queued').count()).toBe(1);
  });

  it('keeps the photo for a later retry on a 5xx', async () => {
    await queuePhoto(meta());
    await replayPhotoQueue((async () => response(503)) as unknown as typeof fetch);
    expect((await db.photoQueue.toArray())[0]!.status).toBe('queued');
  });

  it('marks a 4xx as failed with the reason, stops retrying it, and keeps the bytes', async () => {
    await queuePhoto(meta());
    const fetchImpl = vi.fn(async () => response(400, { error: 'feature not found' }));

    const r = await replayPhotoQueue(fetchImpl as unknown as typeof fetch);
    expect(r).toEqual({ uploaded: 0, failed: 1 });
    const row = (await db.photoQueue.toArray())[0]!;
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('feature not found');
    expect(row.blob.size).toBe(1234);
    expect(await pendingCount()).toBe(0); // no longer "pending": it cannot succeed by waiting

    await replayPhotoQueue(fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // not retried forever
  });
});

describe('replayPhotoQueue — review fixes', () => {
  it('keeps a photo queued on a transient 401 (no write token yet) instead of failing it', async () => {
    await queuePhoto(meta());
    const r = await replayPhotoQueue((async () => response(401, { error: 'missing token' })) as unknown as typeof fetch);
    expect(r).toEqual({ uploaded: 0, failed: 0 });
    const row = (await db.photoQueue.toArray())[0]!;
    expect(row.status).toBe('queued');
    expect(await pendingCount()).toBe(1);
  });

  it('stops one photo that always 500s from blocking the photos behind it', async () => {
    await queuePhoto(meta({ filename: 'too-big.jpg' }));
    await queuePhoto(meta({ filename: 'fine.jpg' }));
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      const name = ((init!.body as FormData).get('photo') as File).name;
      return name === 'too-big.jpg' ? response(500, { error: 'File too large' }) : response(201);
    });
    for (let i = 0; i < MAX_SERVER_ERRORS - 1; i++) {
      await replayPhotoQueue(fetchImpl as unknown as typeof fetch);
      expect(await db.photoQueue.count()).toBe(2); // a normal outage: nothing given up yet
    }
    await replayPhotoQueue(fetchImpl as unknown as typeof fetch);
    const rows = await db.photoQueue.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.filename).toBe('too-big.jpg');
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.lastError).toContain('File too large');
  });
});
