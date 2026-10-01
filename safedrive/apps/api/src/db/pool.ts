import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'>;

// Return bigint counts as numbers and keep timestamps as Date.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url: string, max = 20): Db {
  const pool = new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
  pool.on('error', (err) => console.error('Postgres pool error', err.message));
  return pool;
}

/** Runs fn in a transaction; rolls back on any error. */
export async function withTx<T>(db: Db, fn: (c: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
