import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

export const pool = new pg.Pool({ connectionString });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as unknown[]);
}
