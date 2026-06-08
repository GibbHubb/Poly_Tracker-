import pg from 'pg';

let _pool: pg.Pool | null = null;

function pool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

export async function truncateAll(): Promise<void> {
  await pool().query(
    'TRUNCATE TABLE farms, paddocks, poly_runs, features, photos RESTART IDENTITY CASCADE',
  );
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
