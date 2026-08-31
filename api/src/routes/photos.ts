import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';

export const photosRouter = Router();

const STORAGE = process.env.PHOTO_STORAGE_PATH ?? '/data/photos';

// PT21 — this used to be a bare mkdirSync at import time. On a serverless host
// the filesystem is read-only outside /tmp, so that call throws EROFS while the
// module is being loaded and takes down EVERY route in the app, not just this
// one. Record the failure instead and refuse uploads with a reason (§4: photo
// storage is deliberately not implemented on Vercel — see PT24).
let storageError: string | null = null;
try {
  mkdirSync(STORAGE, { recursive: true });
} catch (err) {
  storageError = err instanceof Error ? err.message : String(err);
  console.warn(
    `[photos] storage path ${STORAGE} is not writable — uploads will be refused with 503:`,
    storageError,
  );
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STORAGE),
  filename: (_req, file, cb) =>
    cb(null, `${randomUUID()}${extname(file.originalname) || '.jpg'}`),
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
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
    res.sendFile(row.path);
  }),
);

photosRouter.post(
  '/',
  // Fail closed BEFORE multer touches the disk: an upload that is accepted and
  // then evaporates is worse than one that is refused with a reason.
  (_req, _res, next) => {
    if (storageError) {
      next(
        new HttpError(
          503,
          `Photo storage is unavailable on this deployment (${STORAGE}: ${storageError}). ` +
            'Photo upload needs object storage — see PT24.',
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
    const { rows } = await query<PhotoRow>(
      `INSERT INTO photos (feature_type, feature_id, path, taken_at, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        meta.feature_type ?? null,
        meta.feature_id ?? null,
        join(STORAGE, req.file.filename),
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
    try {
      await unlink(row.path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn('[photos] unlink failed for', row.path, err);
      }
    }
    res.status(204).end();
  }),
);
