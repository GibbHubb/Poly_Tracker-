import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { geometrySchema, rowsToCollection, rowToFeature } from '../lib/geojson.js';

// mergeParams: mounted at /api/farms/:farmId/paddocks
export const paddocksRouter = Router({ mergeParams: true });

const featureInput = z.object({
  type: z.literal('Feature').optional(),
  geometry: geometrySchema,
  properties: z
    .object({ name: z.string().min(1), notes: z.string().nullish() })
    .passthrough(),
});

interface GeoRow {
  id: string;
  geojson: string | null;
  name: string;
  notes: string | null;
  created_at: string;
}

const SELECT = `
  SELECT id, name, notes, created_at, ST_AsGeoJSON(geom) AS geojson
    FROM paddocks WHERE farm_id = $1`;

paddocksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query<GeoRow>(`${SELECT} ORDER BY created_at`, [
      req.params.farmId,
    ]);
    res.json(rowsToCollection(rows));
  }),
);

paddocksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = featureInput.parse(req.body);
    const { rows } = await query<GeoRow>(
      `INSERT INTO paddocks (farm_id, name, notes, geom)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
       RETURNING id, name, notes, created_at, ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.farmId,
        body.properties.name,
        body.properties.notes ?? null,
        JSON.stringify(body.geometry),
      ],
    );
    res.status(201).json(rowToFeature(rows[0]!));
  }),
);

paddocksRouter.patch(
  '/:paddockId',
  asyncHandler(async (req, res) => {
    const body = featureInput.partial({ geometry: true }).parse(req.body);
    const { rows } = await query<GeoRow>(
      `UPDATE paddocks SET
         name = COALESCE($3, name),
         notes = COALESCE($4, notes),
         geom = COALESCE(ST_SetSRID(ST_GeomFromGeoJSON($5), 4326), geom)
       WHERE id = $1 AND farm_id = $2
       RETURNING id, name, notes, created_at, ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.paddockId,
        req.params.farmId,
        body.properties?.name ?? null,
        body.properties?.notes ?? null,
        body.geometry ? JSON.stringify(body.geometry) : null,
      ],
    );
    if (rows.length === 0) throw new HttpError(404, 'Paddock not found');
    res.json(rowToFeature(rows[0]!));
  }),
);

paddocksRouter.delete(
  '/:paddockId',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM paddocks WHERE id = $1 AND farm_id = $2',
      [req.params.paddockId, req.params.farmId],
    );
    if (rowCount === 0) throw new HttpError(404, 'Paddock not found');
    res.status(204).end();
  }),
);
