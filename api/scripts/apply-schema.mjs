#!/usr/bin/env node
// One-time DB initialiser for a managed Postgres (e.g. Render).
//
// Render does NOT run db/init/*.sql automatically — that behaviour only exists
// in the local `postgis/postgis` image's docker-entrypoint-initdb.d. So after
// the managed DB is provisioned, run this once against its EXTERNAL connection
// string (from the Render dashboard):
//
//   cd api
//   DATABASE_URL="postgres://…:…@…-a.oregon-postgres.render.com/…" PGSSL=true npm run db:init
//
// Idempotent: extensions use IF NOT EXISTS, and the schema is applied only when
// the `farms` table is absent — so re-running is a safe no-op.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set — export it before running db:init.');
  process.exit(1);
}

const useSsl = process.env.PGSSL === 'true' || /sslmode=require/.test(url);
// api/scripts/ -> api/ -> repo root -> db/init
const here = dirname(fileURLToPath(import.meta.url));
const initDir = join(here, '..', '..', 'db', 'init');

const client = new pg.Client({
  connectionString: url,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

await client.connect();
try {
  const extensions = await readFile(join(initDir, '01_extensions.sql'), 'utf8');
  await client.query(extensions);
  console.log('✓ extensions ensured (postgis, pgcrypto)');

  const { rows } = await client.query("SELECT to_regclass('public.farms') AS t");
  if (rows[0].t) {
    console.log('✓ schema already present — skipping (no-op)');
  } else {
    const schema = await readFile(join(initDir, '02_schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✓ schema applied (5 tables + GIST indexes, SRID 4326)');
  }

  // Additive migrations run on EVERY invocation, not just a fresh database —
  // the schema-present check above short-circuits 02_schema.sql, so anything
  // added after the initial release would otherwise never reach an existing
  // deployment. Each file must therefore be written idempotently
  // (ADD COLUMN IF NOT EXISTS and friends).
  const migrationsDir = join(here, '..', '..', 'db', 'migrations');
  let migrations = [];
  try {
    migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    // No migrations directory yet — nothing to apply.
  }
  for (const file of migrations) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await client.query(sql);
    console.log(`✓ migration applied: ${file}`);
  }

  const v = await client.query('SELECT postgis_version() AS v');
  console.log('✓ postgis_version:', v.rows[0].v);
} finally {
  await client.end();
}
