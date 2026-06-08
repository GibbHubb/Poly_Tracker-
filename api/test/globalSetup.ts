import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(__dirname, '../../db/init');

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set before running tests (point it at a throwaway PostGIS DB).',
    );
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // Drop all tables so the schema SQL can run cleanly each time.
  await client.query(`
    DROP TABLE IF EXISTS photos      CASCADE;
    DROP TABLE IF EXISTS features    CASCADE;
    DROP TABLE IF EXISTS poly_runs   CASCADE;
    DROP TABLE IF EXISTS paddocks    CASCADE;
    DROP TABLE IF EXISTS farms       CASCADE;
  `);

  await client.query(readFileSync(resolve(DB_ROOT, '01_extensions.sql'), 'utf8'));
  await client.query(readFileSync(resolve(DB_ROOT, '02_schema.sql'), 'utf8'));
  await client.end();
}
