import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Managed Postgres (e.g. Render) requires TLS for connections from other
// services. Enable it when PGSSL=true (or the URL asks for sslmode=require);
// local docker-compose (plain db:5432) leaves SSL off.
const useSsl =
  process.env.PGSSL === 'true' || /sslmode=require/.test(connectionString);

// PT21 — one connection per function instance. A serverless deploy runs many
// short-lived instances against one Postgres, so a per-instance pool of the
// default size (10) multiplies into connection exhaustion. The Supabase pooler
// is the real broker; this process only ever needs one socket at a time.
// Measured 2026-08-28: the pooler's TRANSACTION mode (port 6543) preserves the
// poly_app role's `search_path = poly, extensions` on every fresh connection,
// including for parameterized and PostGIS queries — so serverless can use 6543
// without the schema qualification PT22 was worried about.
const isServerless = Boolean(process.env.VERCEL);

export const pool = new pg.Pool({
  connectionString,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  ...(isServerless ? { max: 1, idleTimeoutMillis: 10_000 } : {}),
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}
