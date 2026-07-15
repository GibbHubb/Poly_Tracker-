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

export const pool = new pg.Pool({
  connectionString,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}
