import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { geometrySchema, rowsToCollection, rowToFeature } from '../lib/geojson.js';

// mergeParams: mounted at /api/farms/:farmId/features
export const featuresRouter = Router({ mergeParams: true });

export const featureType = z.enum([
  'trough',
  'turkey_nest',
  'bore',
  'gate',
  'tank',
  'other',
]);

const featureInput = z.object({
  type: z.literal('Feature').optional(),
  geometry: geometrySchema,
  properties: z
    .object({
      type: featureType,
      name: z.string().nullish(),
      color: z.string().nullish(),
      notes: z.string().nullish(),
    })
    .passthrough(),
});

interface GeoRow {
  id: string;
  geojson: string | null;
  type: string;
  name: string | null;
  color: string | null;
  notes: string | null;
  created_at: string;
}

const SELECT = `
  SELECT id, type, name, color, notes, created_at, ST_AsGeoJSON(geom) AS geojson
    FROM features WHERE farm_id = $1`;

featuresRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query<GeoRow>(`${SELECT} ORDER BY created_at`, [
      req.params.farmId,
    ]);
    res.json(rowsToCollection(rows));
  }),
);

featuresRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = featureInput.parse(req.body);
    const { rows } = await query<GeoRow>(
      `INSERT INTO features (farm_id, type, name, color, notes, geom)
       VALUES ($1,$2,$3,$4,$5, ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))
       RETURNING id, type, name, color, notes, created_at,
                 ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.farmId,
        body.properties.type,
        body.properties.name ?? null,
        body.properties.color ?? null,
        body.properties.notes ?? null,
        JSON.stringify(body.geometry),
      ],
    );
    res.status(201).json(rowToFeature(rows[0]!));
  }),
);

featuresRouter.patch(
  '/:featureId',
  asyncHandler(async (req, res) => {
    const body = featureInput.partial({ geometry: true }).parse(req.body);
    const p = body.properties ?? {};
    const { rows } = await query<GeoRow>(
      // Full-replace owned attributes (client always submits the complete
      // set) so emptying a field clears it; geometry stays COALESCE since
      // attribute-only edits omit it.
      `UPDATE features SET
         type = $3,
         name = $4,
         color = $5,
         notes = $6,
         geom = COALESCE(ST_SetSRID(ST_GeomFromGeoJSON($7), 4326), geom)
       WHERE id = $1 AND farm_id = $2
       RETURNING id, type, name, color, notes, created_at,
                 ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.featureId,
        req.params.farmId,
        p.type ?? null,
        p.name ?? null,
        p.color ?? null,
        p.notes ?? null,
        body.geometry ? JSON.stringify(body.geometry) : null,
      ],
    );
    if (rows.length === 0) throw new HttpError(404, 'Feature not found');
    res.json(rowToFeature(rows[0]!));
  }),
);

featuresRouter.delete(
  '/:featureId',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM features WHERE id = $1 AND farm_id = $2',
      [req.params.featureId, req.params.farmId],
    );
    if (rowCount === 0) throw new HttpError(404, 'Feature not found');
    res.status(204).end();
  }),
);
