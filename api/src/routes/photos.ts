import { extname } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { createPhotoStore } from '../storage/index.js';
import { log } from '../middleware/observability.js';
import { assertFarmAccess, farmOfFeature, farmOfPhoto, identityOf } from '../middleware/authorize.js';
import { isUuid } from '../lib/identity.js';

/**
 * PT33 — a photo belongs to a farm only through its feature. For a signed-in
 * person that is the access path; a photo with no feature (or a feature that is
 * gone) belongs to nobody they can reach, so it is "not found". Open mode and
 * the legacy token skip this entirely (assertFarmAccess is a no-op for them).
 */
async function assertPhotoAccess(res: import('express').Response, photoId: string, need: 'read' | 'write') {
  if (identityOf(res).kind !== 'user') return;
  const farmId = isUuid(photoId) ? await farmOfPhoto(photoId) : null;
  if (!farmId) throw new HttpError(404, 'Photo not found');
  await assertFarmAccess(res, farmId, need);
}

async function assertFeatureAccess(res: import('express').Response, featureId: unknown, need: 'read' | 'write') {
  if (identityOf(res).kind !== 'user') return;
  const farmId = isUuid(featureId) ? await farmOfFeature(featureId) : null;
  if (!farmId) throw new HttpError(404, 'Feature not found');
  await assertFarmAccess(res, farmId, need);
}

export const photosRouter = Router();

// PT24 — where the bytes go is a backend choice now (disk for self-hosting,
// Supabase Storage on Vercel). Constructing a store never throws; if this
// deployment cannot take uploads, `store.unavailable` carries the reason and
// POST refuses with a 503 (the PT21 property).
const store = createPhotoStore();

// Bytes come to us, not to a disk multer picked: the store decides where they
// land.
//
// PT26 — the cap was 25 MB, but on Vercel the PLATFORM refuses a request body over
// ~4.5 MB before this code runs, so a real phone photo failed with a generic error
// and none of our messaging. The web app now downscales before upload (~1600 px);
// this cap sits under the platform limit so an oversize file is refused by US, with
// a 413 that says why (see errorHandler).
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES },
});

const metaInput = z.object({
  feature_type: z.string().nullish(),
  feature_id: z.string().uuid().nullish(),
  taken_at: z.string().nullish(),
  lat: z.coerce.number().nullish(),
  lng: z.coerce.number().nullish(),
  // PT38 — the uploader's queue-row uuid, the same on every retry of one photo.
  client_id: z.string().uuid().nullish(),
});

interface PhotoRow {
  id: string;
  feature_type: string | null;
  feature_id: string | null;
  path: string;
  taken_at: string | null;
  lat: string | null;
  lng: string | null;
  client_id: string | null;
}

/**
 * PT38 — the photo already stored under this client_id (a retried upload), or null.
 *
 * PT33 review — client_id is caller input. For a signed-in person the row is returned only
 * when it sits on a farm they can WRITE; otherwise the id is taken by someone else's photo
 * and the answer is 409, never the row. 409, not 404: the caller's own feature was just
 * checked and exists, the conflict is the id (PT44 answers a client_id reused on another
 * feature the same way, and the client's photo queue treats 409 as final, not retryable).
 */
async function photoByClientId(res: import('express').Response, clientId: string): Promise<PhotoRow | null> {
  const { rows } = await query<PhotoRow>('SELECT * FROM photos WHERE client_id = $1', [clientId]);
  const row = rows[0];
  if (!row) return null;
  const me = identityOf(res);
  if (me.kind === 'user') {
    const farmId = isUuid(row.feature_id) ? await farmOfFeature(row.feature_id) : null;
    const { rows: can } = farmId
      ? await query(
          "SELECT 1 FROM farm_members WHERE farm_id = $1 AND user_id = $2 AND role IN ('owner', 'editor')",
          [farmId, me.userId],
        )
      : { rows: [] };
    if (!can[0]) throw new HttpError(409, 'This client_id already belongs to another photo.');
  }
  return row;
}

photosRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const featureId = req.query.feature_id;
    const farmId = req.query.farm_id;
    let sql: string;
    let params: unknown[];
    const me = identityOf(res);
    if (featureId) await assertFeatureAccess(res, featureId, 'read');
    else if (farmId && me.kind === 'user') await assertFarmAccess(res, String(farmId), 'read');
    if (featureId) {
      sql = 'SELECT * FROM photos WHERE feature_id = $1 ORDER BY taken_at';
      params = [featureId];
    } else if (farmId) {
      // Photos only attach to point features; scope to a farm by joining
      // features → farm_id (no farm_id column on photos by design).
      sql = `SELECT p.* FROM photos p
               JOIN features f ON p.feature_id = f.id
              WHERE f.farm_id = $1
              ORDER BY p.taken_at`;
      params = [farmId];
    } else if (me.kind === 'user') {
      // PT33 — "all photos" means all photos on the farms this person is in.
      sql = `SELECT p.* FROM photos p
               JOIN features f ON p.feature_id = f.id
               JOIN farm_members m ON m.farm_id = f.farm_id
              WHERE m.user_id = $1
              ORDER BY p.taken_at`;
      params = [me.userId];
    } else {
      sql = 'SELECT * FROM photos ORDER BY taken_at';
      params = [];
    }
    const { rows } = await query<PhotoRow>(sql, params);
    res.json(rows);
  }),
);

photosRouter.get(
  '/file/:id',
  asyncHandler(async (req, res) => {
    // PT33 — an <img> sends the session cookie, not a header; resolveIdentity
    // already turned that cookie into a person, so this is the same check as
    // every other read.
    await assertPhotoAccess(res, String(req.params.id), 'read');
    const { rows } = await query<{ path: string }>(
      'SELECT path FROM photos WHERE id = $1',
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Photo not found');
    // PT24 — this URL is the stable public interface and deliberately did NOT
    // change: `MapView.tsx` and `PhotoUpload.tsx` open it as a real NAVIGATION,
    // and `photoFileUrl` builds it everywhere else. The object backend answers
    // by redirecting here to a short-lived signed URL, which keeps the bucket
    // private and keeps every caller working untouched.
    const resolved = await store.resolve(row.path);
    if (resolved.kind === 'redirect') res.redirect(302, resolved.url);
    else res.sendFile(resolved.path);
  }),
);

photosRouter.post(
  '/',
  // Fail closed BEFORE multer touches the disk: an upload that is accepted and
  // then evaporates is worse than one that is refused with a reason.
  (_req, _res, next) => {
    if (store.unavailable) {
      // PT41 — the reason (env var names, a filesystem path) is for the
      // operator's log, not the caller; the caller gets a stable sentence.
      log({ level: 'warn', msg: 'photo upload refused: storage unavailable', reason: store.unavailable });
      next(new HttpError(503, 'Photo storage is unavailable on this deployment.'));
      return;
    }
    next();
  },
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'photo file is required');
    const meta = metaInput.parse(req.body);
    // PT33 — before any bytes are stored: a signed-in person may attach a photo
    // only to a feature on a farm they can edit. A photo with no feature would
    // be unreachable by anyone signed in, so it is refused rather than orphaned.
    if (identityOf(res).kind === 'user') {
      if (!meta.feature_id) throw new HttpError(400, 'feature_id is required');
      await assertFeatureAccess(res, meta.feature_id, 'write');
    }
    const clientId = meta.client_id ?? null;
    // PT38 — a retry of a photo we already have (its first reply was lost):
    // answer with that row, and store nothing a second time.
    if (clientId) {
      const seen = await photoByClientId(res, clientId);
      if (seen) {
        res.status(200).json(seen);
        return;
      }
    }
    // Store the bytes BEFORE the row: a row pointing at an object that was
    // never written is a broken image with no way to tell; an object with no
    // row is an orphan, reclaimed by `scripts/sweep-photos.ts` (PT27).
    const key = await store.put(
      req.file.buffer,
      extname(req.file.originalname),
      req.file.mimetype,
    );
    const { rows } = await query<PhotoRow>(
      `INSERT INTO photos (feature_type, feature_id, path, taken_at, lat, lng, client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (client_id) DO NOTHING RETURNING *`,
      [
        meta.feature_type ?? null,
        meta.feature_id ?? null,
        key,
        meta.taken_at ?? null,
        meta.lat ?? null,
        meta.lng ?? null,
        clientId,
      ],
    );
    if (!rows[0]) {
      // Two attempts of the same photo raced past the check above; the other
      // one's row won. Drop the object we just stored and answer with theirs.
      await store.remove(key);
      res.status(200).json(await photoByClientId(res, clientId!));
      return;
    }
    res.status(201).json(rows[0]);
  }),
);

photosRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Read the path first (source of truth = DB row), delete the row, then
    // best-effort unlink the file — a missing file must not fail the delete.
    await assertPhotoAccess(res, String(req.params.id), 'write');
    const { rows } = await query<{ path: string }>(
      'SELECT path FROM photos WHERE id = $1',
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Photo not found');
    await query('DELETE FROM photos WHERE id = $1', [req.params.id]);
    await store.remove(row.path); // best-effort; a missing object is not an error
    res.status(204).end();
  }),
);
