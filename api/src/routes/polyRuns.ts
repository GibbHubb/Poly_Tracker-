import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { query } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { parseIfMatch, setVersionETag, throwUpdateConflict } from '../lib/concurrency.js';
import { geometrySchema, rowsToCollection, rowToFeature } from '../lib/geojson.js';

// mergeParams: mounted at /api/farms/:farmId/poly-runs
export const polyRunsRouter = Router({ mergeParams: true });

const props = z
  .object({
    name: z.string().min(1),
    diameter_mm: z.number().int().positive().nullish(),
    depth_m: z.number().positive().nullish(),
    material: z.string().nullish(),
    installed_date: z.string().nullish(), // ISO date string
    color: z.string().nullish(),
    notes: z.string().nullish(),
  })
  // .strip() (default) drops unknown keys — in particular the read-only
  // derived `length_m` must never reach an INSERT/UPDATE (PT6).
  .strip();

export const featureInput = z.object({
  type: z.literal('Feature').optional(),
  geometry: geometrySchema,
  properties: props,
});

interface GeoRow {
  id: string;
  geojson: string | null;
  name: string;
  diameter_mm: number | null;
  depth_m: string | null;
  material: string | null;
  installed_date: string | null;
  color: string | null;
  notes: string | null;
  created_at: string;
  // PT30 — optimistic-concurrency version (001/002 migrations).
  version: number;
  // Derived, read-only: ground length in metres (pg serialises as string).
  length_m: number | string | null;
}

const SELECT = `
  SELECT id, name, diameter_mm, depth_m, material, installed_date, color,
         notes, created_at, version, ST_Length(geom::geography) AS length_m,
         ST_AsGeoJSON(geom) AS geojson
    FROM poly_runs WHERE farm_id = $1`;

/** INSERT a poly-run on a caller-supplied transaction client (bulk import).
 *  Same SQL as the POST handler; returns the new id. */
export async function insertPolyRunTx(
  client: PoolClient,
  farmId: string,
  body: z.infer<typeof featureInput>,
): Promise<string> {
  const p = body.properties;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO poly_runs
       (farm_id, name, diameter_mm, depth_m, material, installed_date,
        color, notes, geom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
     RETURNING id`,
    [
      farmId,
      p.name,
      p.diameter_mm ?? null,
      p.depth_m ?? null,
      p.material ?? null,
      p.installed_date ?? null,
      p.color ?? null,
      p.notes ?? null,
      JSON.stringify(body.geometry),
    ],
  );
  return rows[0]!.id;
}

polyRunsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query<GeoRow>(`${SELECT} ORDER BY created_at`, [
      req.params.farmId,
    ]);
    res.json(rowsToCollection(rows));
  }),
);

polyRunsRouter.get(
  '/:runId',
  asyncHandler(async (req, res) => {
    const { rows } = await query<GeoRow>(`${SELECT} AND id = $2`, [
      req.params.farmId,
      req.params.runId,
    ]);
    if (rows.length === 0) throw new HttpError(404, 'Poly run not found');
    res.json(rowToFeature(rows[0]!));
  }),
);

polyRunsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = featureInput.parse(req.body);
    const p = body.properties;
    const { rows } = await query<GeoRow>(
      `INSERT INTO poly_runs
         (farm_id, name, diameter_mm, depth_m, material, installed_date,
          color, notes, geom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
       RETURNING id, name, diameter_mm, depth_m, material, installed_date,
                 color, notes, created_at, version,
                 ST_Length(geom::geography) AS length_m,
                 ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.farmId,
        p.name,
        p.diameter_mm ?? null,
        p.depth_m ?? null,
        p.material ?? null,
        p.installed_date ?? null,
        p.color ?? null,
        p.notes ?? null,
        JSON.stringify(body.geometry),
      ],
    );
    res.status(201).json(rowToFeature(rows[0]!));
  }),
);

polyRunsRouter.patch(
  '/:runId',
  asyncHandler(async (req, res) => {
    const body = featureInput.partial({ geometry: true }).parse(req.body);
    const p = body.properties ?? {};
    // PT30 — no If-Match means no precondition, i.e. previous behaviour.
    const expected = parseIfMatch(req);
    const { rows } = await query<GeoRow>(
      // Full-replace owned attributes (see features.ts); geometry COALESCE.
      `UPDATE poly_runs SET
         name = $3,
         diameter_mm = $4,
         depth_m = $5,
         material = $6,
         installed_date = $7,
         color = $8,
         notes = $9,
         geom = COALESCE(ST_SetSRID(ST_GeomFromGeoJSON($10), 4326), geom),
         version = version + 1
       WHERE id = $1 AND farm_id = $2
         AND ($11::int IS NULL OR version = $11)
       RETURNING id, name, diameter_mm, depth_m, material, installed_date,
                 color, notes, created_at, version,
                 ST_Length(geom::geography) AS length_m,
                 ST_AsGeoJSON(geom) AS geojson`,
      [
        req.params.runId,
        req.params.farmId,
        p.name ?? null,
        p.diameter_mm ?? null,
        p.depth_m ?? null,
        p.material ?? null,
        p.installed_date ?? null,
        p.color ?? null,
        p.notes ?? null,
        body.geometry ? JSON.stringify(body.geometry) : null,
        expected,
      ],
    );
    if (rows.length === 0) {
      if (expected !== null) {
        await throwUpdateConflict('poly_runs', req.params.runId, expected, 'Poly run not found');
      }
      throw new HttpError(404, 'Poly run not found');
    }
    setVersionETag(res, rows[0]!.version);
    res.json(rowToFeature(rows[0]!));
  }),
);

polyRunsRouter.delete(
  '/:runId',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query(
      'DELETE FROM poly_runs WHERE id = $1 AND farm_id = $2',
      [req.params.runId, req.params.farmId],
    );
    if (rowCount === 0) throw new HttpError(404, 'Poly run not found');
    res.status(204).end();
  }),
);
