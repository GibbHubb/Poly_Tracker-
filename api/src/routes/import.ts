import { Router } from 'express';
import type { PoolClient } from 'pg';
import multer from 'multer';
import { pool } from '../db.js';
import { asyncHandler, HttpError } from '../middleware/index.js';
import { featureCollectionSchema, type ImportFeature } from '../lib/geojson.js';
import { featureInput as paddockInput, insertPaddockTx } from './paddocks.js';
import { featureInput as polyRunInput, insertPolyRunTx } from './polyRuns.js';
import { featureInput as pointInput, insertFeatureTx } from './features.js';

export const importRouter = Router();

// Memory storage — a GeoJSON file is small JSON, no need to hit disk.
const MAX_MB = Number(process.env.IMPORT_MAX_MB ?? 25);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

type Kind = 'paddock' | 'polyRun' | 'feature';

/** Route a feature to a resource by geometry type — same rules as PT12. */
function routeByGeometry(geometry: ImportFeature['geometry']): Kind | null {
  switch (geometry?.type) {
    case 'Polygon':
      return 'paddock';
    case 'LineString':
      return 'polyRun';
    case 'Point':
      return 'feature';
    default:
      return null; // Multi*, GeometryCollection, null → skipped
  }
}

/** Validate a feature with its kind's schema (throws ZodError on bad props)
 *  and INSERT it on the shared transaction client. */
async function insertByKind(
  client: PoolClient,
  kind: Kind,
  farmId: string,
  feature: ImportFeature,
): Promise<string> {
  if (kind === 'paddock') return insertPaddockTx(client, farmId, paddockInput.parse(feature));
  if (kind === 'polyRun') return insertPolyRunTx(client, farmId, polyRunInput.parse(feature));
  return insertFeatureTx(client, farmId, pointInput.parse(feature));
}

interface ReportEntry {
  index: number;
  kind?: Kind;
  status: 'inserted' | 'skipped' | 'error';
  id?: string;
  error?: string;
}

/**
 * POST /api/import/geojson — bulk-import a GeoJSON FeatureCollection into a farm
 * inside a single transaction. Multipart body: `file` (the GeoJSON) + `farm_id`.
 *
 * Atomicity: **all-or-nothing** by default — the first feature error rolls back
 * the whole batch (HTTP 422, nothing committed). Pass `?partial=true` to commit
 * every valid feature and report the failures. Each feature is inserted under a
 * SAVEPOINT so a single bad geometry is reportable rather than poisoning the tx.
 */
importRouter.post(
  '/geojson',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'GeoJSON file is required (form field "file")');
    const farmId = typeof req.body.farm_id === 'string' ? req.body.farm_id : '';
    if (!farmId) throw new HttpError(400, 'farm_id is required');

    let parsed: unknown;
    try {
      parsed = JSON.parse(req.file.buffer.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Uploaded file is not valid JSON');
    }
    const fc = featureCollectionSchema.safeParse(parsed);
    if (!fc.success) {
      throw new HttpError(400, 'Uploaded JSON is not a valid GeoJSON FeatureCollection');
    }

    const farmCheck = await pool.query('SELECT 1 FROM farms WHERE id = $1', [farmId]);
    if (farmCheck.rowCount === 0) throw new HttpError(404, 'Farm not found');

    const partial = req.query.partial === 'true';
    const features = fc.data.features;
    const report: ReportEntry[] = [];
    let inserted = 0;
    let skipped = 0;
    let errored = 0;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < features.length; i++) {
        const feature = features[i]!;
        const kind = routeByGeometry(feature.geometry);
        if (!kind) {
          skipped++;
          report.push({ index: i, status: 'skipped', error: 'unsupported geometry' });
          continue;
        }
        await client.query('SAVEPOINT feat');
        try {
          const id = await insertByKind(client, kind, farmId, feature);
          await client.query('RELEASE SAVEPOINT feat');
          inserted++;
          report.push({ index: i, kind, status: 'inserted', id });
        } catch (e) {
          await client.query('ROLLBACK TO SAVEPOINT feat');
          errored++;
          const error = e instanceof Error ? e.message : String(e);
          report.push({ index: i, kind, status: 'error', error });
          if (!partial) {
            // All-or-nothing: abort the whole batch on the first error.
            await client.query('ROLLBACK');
            res.status(422).json({
              mode: 'all-or-nothing',
              committed: false,
              inserted: 0,
              skipped,
              errored,
              report,
            });
            return;
          }
        }
      }
      await client.query('COMMIT');
      res.json({
        mode: partial ? 'partial' : 'all-or-nothing',
        committed: true,
        inserted,
        skipped,
        errored,
        report,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }),
);
