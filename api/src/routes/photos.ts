import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';

export const photosRouter = Router();

const STORAGE = process.env.PHOTO_STORAGE_PATH ?? '/data/photos';
mkdirSync(STORAGE, { recursive: true });

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
    const { rowCount } = await query('DELETE FROM photos WHERE id = $1', [
      req.params.id,
    ]);
    if (rowCount === 0) throw new HttpError(404, 'Photo not found');
    res.status(204).end();
  }),
);
