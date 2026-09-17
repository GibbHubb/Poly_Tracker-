import { extname } from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { createPhotoStore } from '../storage/index.js';

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
});

interface PhotoRow {
  id: string;
  feature_type: string | null;
  feature_id: string | null;
  path: string;
  taken_at: string | null;
  lat: string | null;
  lng: string | null;
}

photosRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const featureId = req.query.feature_id;
    const farmId = req.query.farm_id;
    let sql: string;
    let params: unknown[];
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
      next(
        new HttpError(
          503,
          `Photo storage is unavailable on this deployment (${store.unavailable})`,
        ),
      );
      return;
    }
    next();
  },
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'photo file is required');
    const meta = metaInput.parse(req.body);
    // Store the bytes BEFORE the row: a row pointing at an object that was
    // never written is a broken image with no way to tell; an object with no
    // row is an orphan. Nothing reclaims orphans today and one can be up to
    // the 25 MB limit, so if uploads ever fail often this needs a sweeper
    // (tracked as PT27).
    const key = await store.put(
      req.file.buffer,
      extname(req.file.originalname),
      req.file.mimetype,
    );
    const { rows } = await query<PhotoRow>(
      `INSERT INTO photos (feature_type, feature_id, path, taken_at, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        meta.feature_type ?? null,
        meta.feature_id ?? null,
        key,
        meta.taken_at ?? null,
        meta.lat ?? null,
        meta.lng ?? null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

photosRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Read the path first (source of truth = DB row), delete the row, then
    // best-effort unlink the file — a missing file must not fail the delete.
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
