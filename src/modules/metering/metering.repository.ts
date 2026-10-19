import type {
  AccountId,
  ConsumeResponseBody,
  Period,
  UserId,
} from '../../domain/types.js';
import type { SqlExecutor } from '../../database/executor.js';

/**
 * Metering repository — usage counters, idempotency log, audit history.
 *
 * LOCK ORDER CONTRACT (load-bearing, see docs/CONCURRENCY_AND_LOCKING.md):
 *   Inside the consume transaction, row locks on `monthly_usage` are ALWAYS
 *   acquired in the deterministic order
 *       1. (account_id, user_id IS NULL,      period)   — account aggregate
 *       2. (account_id, user_id = <user uuid>, period) — the user row
 *   Every concurrent consume transaction on the same account acquires the
 *   same locks in the same total order, so the wait-for graph is acyclic
 *   and PostgreSQL can never raise SQLSTATE 40P01 (deadlock) here.
 */

// ---------------------------------------------------------------------------
// Idempotency log
// ---------------------------------------------------------------------------

export interface StoredRecord {
  readonly accepted: boolean;
  readonly responsePayload: ConsumeResponseBody;
}

export async function findConsumptionRecord(
  executor: SqlExecutor,
  accountId: AccountId,
  requestId: string,
): Promise<StoredRecord | null> {
  const result = await executor.query<{
    accepted: boolean;
    response_payload: ConsumeResponseBody;
  }>(
    `SELECT accepted, response_payload
       FROM consumption_records
      WHERE account_id = $1 AND request_id = $2`,
    [accountId, requestId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { accepted: row.accepted, responsePayload: row.response_payload };
}

export interface InsertRecordInput {
  readonly accountId: AccountId;
  readonly userId: UserId;
  readonly requestId: string;
  readonly unitsRequested: number;
  readonly accepted: boolean;
  readonly period: Period;
  readonly rejectionReason: string | null;
  readonly rejectionSource: string | null;
  readonly rejectionRule: string | null;
  readonly responsePayload: ConsumeResponseBody;
}

export async function insertConsumptionRecord(
  executor: SqlExecutor,
  input: InsertRecordInput,
): Promise<void> {
  await executor.query(
    `INSERT INTO consumption_records
        (account_id, user_id, request_id, units_requested, accepted,
         rejection_reason, rejection_source, rejection_rule,
         period, response_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      input.accountId,
      input.userId,
      input.requestId,
      input.unitsRequested,
      input.accepted,
      input.rejectionReason,
      input.rejectionSource,
      input.rejectionRule,
      input.period,
      JSON.stringify(input.responsePayload),
    ],
  );
}

// ---------------------------------------------------------------------------
// Usage counters — lazy row creation + pessimistic locking
// ---------------------------------------------------------------------------

/**
 * Ensure the (account, period) aggregate row exists, then lock it.
 * INSERT … ON CONFLICT ON CONSTRAINT targets the NULLS NOT DISTINCT unique
 * constraint, so concurrent first-writers for the same period race safely:
 * exactly one inserts, the others take the DO NOTHING path and proceed to
 * the FOR UPDATE select, which blocks until the winner commits — after
 * which the row is visible and lockable.
 */
export async function lockAccountUsage(
  executor: SqlExecutor,
  accountId: AccountId,
  period: Period,
): Promise<number> {
  await executor.query(
    `INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
     VALUES ($1, NULL, $2, 0)
     ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING`,
    [accountId, period],
  );

  const result = await executor.query<{ units_consumed: number }>(
    `SELECT units_consumed FROM monthly_usage
      WHERE account_id = $1 AND user_id IS NULL AND period = $2
        FOR UPDATE`,
    [accountId, period],
  );
  return (result.rows[0] as { units_consumed: number }).units_consumed;
}

/**
 * Ensure the (account, user, period) row exists, then lock it.
 * ALWAYS called after `lockAccountUsage` — never before (lock ordering).
 */
export async function lockUserUsage(
  executor: SqlExecutor,
  accountId: AccountId,
  userId: UserId,
  period: Period,
): Promise<number> {
  await executor.query(
    `INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING`,
    [accountId, userId, period],
  );

  const result = await executor.query<{ units_consumed: number }>(
    `SELECT units_consumed FROM monthly_usage
      WHERE account_id = $1 AND user_id = $2 AND period = $3
        FOR UPDATE`,
    [accountId, userId, period],
  );
  return (result.rows[0] as { units_consumed: number }).units_consumed;
}

/**
 * Atomic monotonic increment. The caller already holds the row lock from
 * the corresponding `lock*Usage` call in the SAME transaction, so this
 * UPDATE cannot interleave with any other transaction.
 */
export async function incrementUsage(
  executor: SqlExecutor,
  accountId: AccountId,
  userId: UserId | null,
  period: Period,
  units: number,
): Promise<number> {
  const result = await executor.query<{ units_consumed: number }>(
    `UPDATE monthly_usage
        SET units_consumed = units_consumed + $4,
            updated_at = NOW()
      WHERE account_id = $1
        AND user_id IS NOT DISTINCT FROM $2
        AND period = $3
      RETURNING units_consumed`,
    [accountId, userId, period, units],
  );
  return (result.rows[0] as { units_consumed: number }).units_consumed;
}

// ---------------------------------------------------------------------------
// Read side (no locks — plain MVCC snapshots)
// ---------------------------------------------------------------------------

export async function getAccountUsage(
  executor: SqlExecutor,
  accountId: AccountId,
  period: Period,
): Promise<number> {
  const result = await executor.query<{ units_consumed: number | null }>(
    `SELECT units_consumed FROM monthly_usage
      WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
    [accountId, period],
  );
  return result.rows[0]?.units_consumed ?? 0;
}

export async function getUserUsage(
  executor: SqlExecutor,
  accountId: AccountId,
  userId: UserId,
  period: Period,
): Promise<number> {
  const result = await executor.query<{ units_consumed: number | null }>(
    `SELECT units_consumed FROM monthly_usage
      WHERE account_id = $1 AND user_id = $2 AND period = $3`,
    [accountId, userId, period],
  );
  return result.rows[0]?.units_consumed ?? 0;
}

export interface HistoryRow {
  readonly request_id: string;
  readonly user_id: string;
  readonly external_id: string;
  readonly units_requested: number;
  readonly accepted: boolean;
  readonly rejection_reason: string | null;
  readonly rejection_source: string | null;
  readonly rejection_rule: string | null;
  readonly period: string;
  readonly response_payload: ConsumeResponseBody;
  readonly created_at: Date;
}

export interface HistoryFilter {
  readonly accountId: AccountId;
  readonly internalUserId: UserId | null;
  readonly period: string | null;
  readonly accepted: boolean | null;
  readonly limit: number;
  readonly offset: number;
}

export async function listHistory(
  executor: SqlExecutor,
  filter: HistoryFilter,
): Promise<HistoryRow[]> {
  const result = await executor.query<HistoryRow>(
    `SELECT cr.request_id, cr.user_id, u.external_id, cr.units_requested,
            cr.accepted, cr.rejection_reason, cr.rejection_source,
            cr.rejection_rule, cr.period, cr.response_payload, cr.created_at
       FROM consumption_records cr
       JOIN users u ON u.id = cr.user_id
      WHERE cr.account_id = $1
        AND ($2::uuid IS NULL OR cr.user_id = $2)
        AND ($3::varchar IS NULL OR cr.period = $3)
        AND ($4::boolean IS NULL OR cr.accepted = $4)
      ORDER BY cr.created_at DESC, cr.request_id
      LIMIT $5 OFFSET $6`,
    [
      filter.accountId,
      filter.internalUserId,
      filter.period,
      filter.accepted,
      filter.limit,
      filter.offset,
    ],
  );
  return result.rows;
}

export async function countHistory(
  executor: SqlExecutor,
  filter: Omit<HistoryFilter, 'limit' | 'offset'>,
): Promise<number> {
  const result = await executor.query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM consumption_records cr
      WHERE cr.account_id = $1
        AND ($2::uuid IS NULL OR cr.user_id = $2)
        AND ($3::varchar IS NULL OR cr.period = $3)
        AND ($4::boolean IS NULL OR cr.accepted = $4)`,
    [filter.accountId, filter.internalUserId, filter.period, filter.accepted],
  );
  return Number((result.rows[0] as { total: string }).total);
}
