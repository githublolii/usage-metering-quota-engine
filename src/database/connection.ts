import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env, shouldUseSsl } from '../config/env.js';

/**
 * Shared connection pool.
 *
 * Sizing guidance (see docs/BENCHMARK_REPORT.md for measured numbers):
 *   - The consume transaction serializes on row locks, so pool size beyond a
 *     small multiple of CPU cores only adds lock-wait queueing — it never
 *     increases throughput on a single hot account, but it does increase
 *     tail latency via context switching. Default 20 is a sweet spot for
 *     PG's default max_connections=100 with headroom for migrations/tooling.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  // Force every session into UTC: period math and audit timestamps are UTC.
  options: '-c timezone=UTC',
  ssl: shouldUseSsl(env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

// An idle client emitting an error (e.g. admin-initiated termination) must
// never crash the process — log and let the pool replace the client.
pool.on('error', (error) => {
  console.error(
    `[db] idle client error: ${error.message} (client discarded, pool will recover)`,
  );
});

/** Run a single query on an auto-checked-out client. */
export async function query<Row extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<Row>> {
  return pool.query<Row>(text, params);
}

/**
 * Execute `fn` inside a transaction with guaranteed BEGIN/COMMIT/ROLLBACK
 * pairing and guaranteed client release. All multi-statement invariants of
 * the metering engine rely on this wrapper.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Connection is likely dead; release() returns it to the pool which
      // will destroy it. Surface the *original* failure either way.
      console.error('[db] rollback failed:', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Gracefully drain the pool (used on SIGINT/SIGTERM and in tests). */
export async function closePool(): Promise<void> {
  await pool.end();
}
