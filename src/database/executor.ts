import type { Pool, PoolClient } from 'pg';

/**
 * Anything that can run SQL: a pooled client (inside a transaction) or the
 * shared pool (one-shot reads). Repositories accept an executor so the
 * service layer decides transactional boundaries — repositories never
 * manage transactions themselves.
 */
export type SqlExecutor = Pool | PoolClient;
