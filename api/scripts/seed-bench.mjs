#!/usr/bin/env node
// PT31 — seeds a realistic dataset into a SCRATCH database so
// `EXPLAIN (ANALYZE, BUFFERS)` numbers mean something and can be re-run
// later. Never point this at the live `poly` schema: it INSERTs thousands of
// rows and TRUNCATEs first.
//
//   DATABASE_URL="postgres://postgres:x@127.0.0.1:55435/ptbench" \
//     node scripts/seed-bench.mjs
//
// Dataset matches PT31 §3's acceptance criteria: one farm with 5,000
// features, 2,000 poly runs, 500 paddocks and 5,000 photos.
//
// ⚠️ It ALSO seeds a batch of noise farms (default 300) with their own rows in
// the same tables. Without them, farm_id has zero selectivity — every row in
// the table belongs to the one farm under test, so an EXPLAIN correctly
// prefers a Seq Scan over the new index (proven while writing this script:
// the "after" plan flipped BACK to Seq Scan on poly_runs and the photos join
// the moment the composite indexes went in, because there was nothing else in
// the table to filter out). Real usage is multi-tenant — many farms share
// these tables — so the benchmark needs that shape too, not just the row
// count.

import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — point it at a throwaway PostGIS database.');
  process.exit(1);
}
if (/supabase\.co|qzgrukdwukkcghacolua/.test(url)) {
  console.error('Refusing: DATABASE_URL looks like the shared live Supabase project.');
  process.exit(1);
}

const FEATURE_COUNT = Number(process.env.SEED_FEATURES ?? 5000);
const POLY_RUN_COUNT = Number(process.env.SEED_POLY_RUNS ?? 2000);
const PADDOCK_COUNT = Number(process.env.SEED_PADDOCKS ?? 500);
const PHOTO_COUNT = Number(process.env.SEED_PHOTOS ?? 5000);

// Other tenants sharing the same tables — see the note above on why these
// exist. Deliberately cheap geometry (short lines, small polygons): realism
// of the NOISE rows doesn't matter, only that farm_id actually filters most
// of the table out.
const NOISE_FARM_COUNT = Number(process.env.SEED_NOISE_FARMS ?? 300);
const NOISE_FEATURES_PER_FARM = Number(process.env.SEED_NOISE_FEATURES ?? 100);
const NOISE_POLY_RUNS_PER_FARM = Number(process.env.SEED_NOISE_POLY_RUNS ?? 40);
const NOISE_PADDOCKS_PER_FARM = Number(process.env.SEED_NOISE_PADDOCKS ?? 10);
const NOISE_PHOTOS_PER_FARM = Number(process.env.SEED_NOISE_PHOTOS ?? 100);

// Roughly centred on the fixture point already used in the test suite
// (152.0, -27.0), scattered across a ~50 km square so geometries don't
// collapse onto one point.
const CENTER = [152.0, -27.0];
const SPREAD = 0.4; // degrees, ~44 km

function jitter() {
  return (Math.random() - 0.5) * SPREAD;
}

function randomPoint() {
  return [CENTER[0] + jitter(), CENTER[1] + jitter()];
}

/** A LineString of 20-200 vertices, walking a short random path. */
function randomLine() {
  const vertexCount = 20 + Math.floor(Math.random() * 181);
  let [x, y] = randomPoint();
  const coords = [[x, y]];
  for (let i = 1; i < vertexCount; i++) {
    x += (Math.random() - 0.5) * 0.002;
    y += (Math.random() - 0.5) * 0.002;
    coords.push([x, y]);
  }
  return { type: 'LineString', coordinates: coords };
}

/** A small closed rectangle polygon (a paddock). */
function randomPolygon() {
  const [x, y] = randomPoint();
  const w = 0.01 + Math.random() * 0.03;
  const h = 0.01 + Math.random() * 0.03;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x, y],
      ],
    ],
  };
}

/** Cheap 3-vertex line for noise farms — presence, not realism, is the point. */
function cheapLine() {
  const [x, y] = randomPoint();
  return {
    type: 'LineString',
    coordinates: [
      [x, y],
      [x + 0.001, y + 0.001],
      [x + 0.002, y],
    ],
  };
}

/** Cheap 4-point rectangle for noise farms. */
function cheapPolygon() {
  const [x, y] = randomPoint();
  const w = 0.005;
  const h = 0.005;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
        [x, y],
      ],
    ],
  };
}

const FEATURE_TYPES = ['trough', 'turkey_nest', 'bore', 'gate', 'tank', 'tap', 'other'];

async function insertBatch(client, sqlPrefix, rows, valuesPerRow, buildValues, batchSize = 500) {
  for (let start = 0; start < rows.length; start += batchSize) {
    const chunk = rows.slice(start, start + batchSize);
    const params = [];
    const valueClauses = chunk.map((row, i) => {
      const values = buildValues(row, start + i);
      const placeholders = values.map((_, j) => `$${i * valuesPerRow + j + 1}`).join(',');
      params.push(...values);
      return `(${placeholders})`;
    });
    await client.query(`${sqlPrefix} VALUES ${valueClauses.join(',')}`, params);
  }
}

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const { rows: sp } = await client.query(
    'SELECT current_database() AS db, current_schema() AS schema',
  );
  console.log(`→ seeding database=${sp[0].db} schema=${sp[0].schema}`);

  await client.query('BEGIN');
  try {
    await client.query(
      'TRUNCATE TABLE photos, features, poly_runs, paddocks, farms RESTART IDENTITY CASCADE',
    );

    const { rows: farmRows } = await client.query(
      `INSERT INTO farms (name, owner) VALUES ($1, $2) RETURNING id`,
      ['PT31 Bench Farm', 'seed-bench.mjs'],
    );
    const farmId = farmRows[0].id;
    console.log(`✓ farm ${farmId}`);

    // Paddocks
    const paddocks = Array.from({ length: PADDOCK_COUNT }, (_, i) => ({
      name: `Paddock ${i}`,
      geom: randomPolygon(),
    }));
    await insertBatch(
      client,
      `INSERT INTO paddocks (farm_id, name, geom)`,
      paddocks,
      3,
      (p) => [farmId, p.name, `SRID=4326;${wktFromPolygon(p.geom)}`],
    );
    console.log(`✓ ${PADDOCK_COUNT} paddocks`);

    // Poly runs
    const polyRuns = Array.from({ length: POLY_RUN_COUNT }, (_, i) => ({
      name: `Run ${i}`,
      geom: randomLine(),
    }));
    await insertBatch(
      client,
      `INSERT INTO poly_runs (farm_id, name, geom)`,
      polyRuns,
      3,
      (r) => [farmId, r.name, `SRID=4326;${wktFromLine(r.geom)}`],
    );
    console.log(`✓ ${POLY_RUN_COUNT} poly runs`);

    // Features
    const features = Array.from({ length: FEATURE_COUNT }, (_, i) => ({
      type: FEATURE_TYPES[i % FEATURE_TYPES.length],
      name: `Feature ${i}`,
      point: randomPoint(),
    }));
    const featureIds = [];
    for (let start = 0; start < features.length; start += 500) {
      const chunk = features.slice(start, start + 500);
      const params = [];
      const valueClauses = chunk.map((f, i) => {
        const values = [farmId, f.type, f.name, `SRID=4326;POINT(${f.point[0]} ${f.point[1]})`];
        const placeholders = values.map((_, j) => `$${i * 4 + j + 1}`).join(',');
        params.push(...values);
        return `(${placeholders})`;
      });
      const { rows } = await client.query(
        `INSERT INTO features (farm_id, type, name, geom) VALUES ${valueClauses.join(',')} RETURNING id`,
        params,
      );
      featureIds.push(...rows.map((r) => r.id));
    }
    console.log(`✓ ${FEATURE_COUNT} features`);

    // Photos — attached to features round-robin so both the feature_id
    // lookup and the farm_id join have something realistic to hit.
    const photos = Array.from({ length: PHOTO_COUNT }, (_, i) => ({
      feature_id: featureIds[i % featureIds.length],
      path: `bench/photo-${i}.jpg`,
    }));
    await insertBatch(
      client,
      `INSERT INTO photos (feature_type, feature_id, path, taken_at)`,
      photos,
      4,
      (p) => ['point', p.feature_id, p.path, new Date(Date.now() - Math.random() * 1e10)],
    );
    console.log(`✓ ${PHOTO_COUNT} photos`);

    // Noise farms — see the top-of-file note. Cheap 3-vertex lines / 4-point
    // rectangles / single points; only presence in another farm matters.
    const { rows: noiseFarmRows } = await client.query(
      `INSERT INTO farms (name, owner)
       SELECT 'Noise Farm ' || g, 'seed-bench.mjs'
         FROM generate_series(1, $1) g
       RETURNING id`,
      [NOISE_FARM_COUNT],
    );
    const noiseFarmIds = noiseFarmRows.map((r) => r.id);
    console.log(`✓ ${NOISE_FARM_COUNT} noise farms`);

    const noiseFeatures = [];
    const noisePolyRuns = [];
    const noisePaddocks = [];
    for (const nfId of noiseFarmIds) {
      for (let i = 0; i < NOISE_FEATURES_PER_FARM; i++) {
        noiseFeatures.push({ farmId: nfId, point: randomPoint() });
      }
      for (let i = 0; i < NOISE_POLY_RUNS_PER_FARM; i++) {
        noisePolyRuns.push({ farmId: nfId, geom: cheapLine() });
      }
      for (let i = 0; i < NOISE_PADDOCKS_PER_FARM; i++) {
        noisePaddocks.push({ farmId: nfId, geom: cheapPolygon() });
      }
    }

    await insertBatch(
      client,
      `INSERT INTO paddocks (farm_id, name, geom)`,
      noisePaddocks,
      3,
      (p, i) => [p.farmId, `Noise Paddock ${i}`, `SRID=4326;${wktFromPolygon(p.geom)}`],
    );
    console.log(`✓ ${noisePaddocks.length} noise paddocks`);

    await insertBatch(
      client,
      `INSERT INTO poly_runs (farm_id, name, geom)`,
      noisePolyRuns,
      3,
      (r, i) => [r.farmId, `Noise Run ${i}`, `SRID=4326;${wktFromLine(r.geom)}`],
    );
    console.log(`✓ ${noisePolyRuns.length} noise poly runs`);

    const noiseFeatureIds = [];
    for (let start = 0; start < noiseFeatures.length; start += 500) {
      const chunk = noiseFeatures.slice(start, start + 500);
      const params = [];
      const valueClauses = chunk.map((f, i) => {
        const values = [
          f.farmId,
          FEATURE_TYPES[i % FEATURE_TYPES.length],
          `Noise Feature ${start + i}`,
          `SRID=4326;POINT(${f.point[0]} ${f.point[1]})`,
        ];
        const placeholders = values.map((_, j) => `$${i * 4 + j + 1}`).join(',');
        params.push(...values);
        return `(${placeholders})`;
      });
      const { rows } = await client.query(
        `INSERT INTO features (farm_id, type, name, geom) VALUES ${valueClauses.join(',')} RETURNING id`,
        params,
      );
      noiseFeatureIds.push(...rows.map((r) => r.id));
    }
    console.log(`✓ ${noiseFeatureIds.length} noise features`);

    const totalNoisePhotos = NOISE_FARM_COUNT * NOISE_PHOTOS_PER_FARM;
    const noisePhotos = Array.from({ length: totalNoisePhotos }, (_, i) => ({
      feature_id: noiseFeatureIds[i % noiseFeatureIds.length],
      path: `bench/noise-photo-${i}.jpg`,
    }));
    await insertBatch(
      client,
      `INSERT INTO photos (feature_type, feature_id, path, taken_at)`,
      noisePhotos,
      4,
      (p) => ['point', p.feature_id, p.path, new Date(Date.now() - Math.random() * 1e10)],
    );
    console.log(`✓ ${noisePhotos.length} noise photos`);

    await client.query('COMMIT');
    console.log(`→ done. farm_id=${farmId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

function wktFromLine(geom) {
  const pts = geom.coordinates.map(([x, y]) => `${x} ${y}`).join(',');
  return `LINESTRING(${pts})`;
}

function wktFromPolygon(geom) {
  const ring = geom.coordinates[0].map(([x, y]) => `${x} ${y}`).join(',');
  return `POLYGON((${ring}))`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
