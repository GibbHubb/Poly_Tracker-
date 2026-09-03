#!/usr/bin/env node
// DB initialiser + migration runner for Poly_Tracker's `poly` schema.
//
//   cd api
//   DATABASE_URL="postgres://…" PGSSL=true npm run db:init
//
// ⚠️ Render is OUT (Max, 2026-08-24) — its free Postgres deleted this very
// database once (PT22). The target is now the `poly` schema of the shared
// Supabase project, reached through the poly_app role's search_path.
//
// Safe to re-run: migrations are recorded in a `schema_migrations` ledger and
// applied once each, in their own transaction. Before PT30 there was no ledger
// and every file was re-executed on every invocation — which held only while
// every file happened to be idempotent, a property nothing checked.

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

// PT30 — migrations connect as a DDL-capable role, NOT as the app role.
//
// Measured against the live database 2026-09-03: `poly_app` reads and writes
// rows fine and then fails `CREATE TABLE` with
//   error: permission denied for schema poly   (42501)
// That is the app role behaving CORRECTLY — a runtime role that can DROP its own
// tables is a role one bug away from doing it. So the fix is not to grant it
// DDL; it is to run migrations as someone else.
//
// POLY_TRACKER_MIGRATION_URL is that someone: the project's postgres-role DSN,
// used ONLY by this script. It must never appear in the app's runtime
// environment — Cortana keeps its service-role key off Vercel for the same
// reason (SEC19).
const url = process.env.POLY_TRACKER_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.error(
    'No connection string. Set POLY_TRACKER_MIGRATION_URL (preferred, a\n' +
      'DDL-capable role) or DATABASE_URL before running db:init.'
  );
  process.exit(1);
}
const usingAppRole = !process.env.POLY_TRACKER_MIGRATION_URL;

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
  // PT30 — where are we actually pointed?
  //
  // Everything below used to assume `public`. PT22 moved the whole schema into
  // `poly`, reached through the poly_app role's `search_path` (api/src/db.ts),
  // so `to_regclass('public.farms')` returns NULL against the live database —
  // the runner then concluded it was empty and tried to CREATE the tables
  // again. That is why NO migration has been able to reach production since
  // PT22, and why `poly_runs` still has no `version` column.
  //
  // So: ask the connection which schema it will actually write to, and report
  // it. A runner that does not say where it is pointed is a runner you cannot
  // trust to have done anything.
  const { rows: sp } = await client.query(
    'SELECT current_schema() AS schema, current_user AS role, current_database() AS db'
  );
  const schemaName = sp[0].schema;
  console.log(
    `→ database=${sp[0].db} role=${sp[0].role} target schema=${schemaName}`
  );
  if (!schemaName) {
    throw new Error(
      'current_schema() is NULL — the role has no usable search_path, so this ' +
        'script cannot tell which schema it would write to. Refusing to guess.'
    );
  }

  const extensions = await readFile(join(initDir, '01_extensions.sql'), 'utf8');
  try {
    await client.query(extensions);
    console.log('✓ extensions ensured (postgis, pgcrypto)');
  } catch (err) {
    // A Supabase project role is not normally permitted to CREATE EXTENSION,
    // and on a hosted project they are pre-installed anyway. A permission
    // error here is expected and must not abort the migrations that follow —
    // but it is reported, not swallowed.
    console.log(`• extensions skipped (${err.code || err.message}) — expected on hosted Postgres`);
  }

  // Unqualified: resolves through the SAME search_path the app uses, so this
  // answers "does the app's own farms table exist" rather than "does one exist
  // in a schema I guessed".
  const { rows } = await client.query("SELECT to_regclass('farms') AS t");
  if (rows[0].t) {
    console.log(`✓ schema already present in ${schemaName} — skipping 02_schema.sql`);
  } else {
    const schema = await readFile(join(initDir, '02_schema.sql'), 'utf8');
    await client.query(schema);
    console.log('✓ schema applied (5 tables + GIST indexes, SRID 4326)');
  }

  // Fail with the ACTUAL reason rather than a raw 42501 stack. The first live
  // run spent its error budget printing an aclchk.c traceback that said nothing
  // about which role was wrong or what to set.
  if (usingAppRole) {
    const { rows: canCreate } = await client.query(
      'SELECT has_schema_privilege(current_user, current_schema(), $1) AS ok', ['CREATE']
    );
    if (!canCreate[0].ok) {
      throw new Error(
        `role ${sp[0].role} has no CREATE on schema ${schemaName}, so migrations ` +
          'cannot run as it. That is correct for an app role — set ' +
          'POLY_TRACKER_MIGRATION_URL to a DDL-capable (postgres-role) DSN and ' +
          're-run. Do NOT grant CREATE to the app role to work around this.'
      );
    }
  }

  // PT30 — a ledger, so a migration runs ONCE.
  //
  // Every .sql in db/migrations/ used to be re-executed on every invocation,
  // which worked only while every file happened to be idempotent. That is a
  // property nobody was checking and one `INSERT` or `UPDATE ... SET` away from
  // being false — and a data migration is exactly the kind that cannot be
  // written idempotently without effort.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = join(here, '..', '..', 'db', 'migrations');
  let migrations = [];
  try {
    migrations = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    // No migrations directory yet — nothing to apply.
  }
  // ⚠️ Transition note. The ledger starts EMPTY, so on the first run after this
  // change every existing migration is re-applied once. That is safe today and
  // only today: the old design required every file to be idempotent, and 001 is
  // (`ADD COLUMN IF NOT EXISTS`). It stops being safe the moment someone writes
  // a data migration — which is precisely why the ledger is going in now,
  // before one exists, rather than after it has run twice.
  const { rows: doneRows } = await client.query('SELECT filename FROM schema_migrations');
  const done = new Set(doneRows.map((r) => r.filename));

  let applied = 0;
  for (const file of migrations) {
    if (done.has(file)) {
      console.log(`• already applied: ${file}`);
      continue;
    }
    // One transaction per migration: a file that fails half way must not leave
    // its own ledger row behind, or it can never be retried.
    await client.query('BEGIN');
    try {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied += 1;
      console.log(`✓ applied: ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed and was rolled back: ${err.message}`);
    }
  }
  console.log(
    `→ migrations: ${applied} applied, ${migrations.length - applied} already applied`
  );

  const v = await client.query('SELECT postgis_version() AS v');
  console.log('✓ postgis_version:', v.rows[0].v);
} finally {
  await client.end();
}
