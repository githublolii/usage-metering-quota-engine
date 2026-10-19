import type { AccountId, ApiKeyHash, PlanId, PlanType } from '../../domain/types.js';
import type { SqlExecutor } from '../../database/executor.js';

/**
 * Accounts repository.
 *
 * Every query is keyed by primary key or by the UNIQUE api_key_hash index —
 * O(log n) lookups, no table scans. Multi-tenant scoping is enforced by the
 * service layer passing the authenticated accountId (never a client value).
 */

export interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly api_key_hash: string;
  readonly plan_id: string;
  readonly created_at: Date;
}

export interface AccountWithPlanRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: Date;
  readonly plan_id: string;
  readonly plan_name: string;
  readonly plan_type: PlanType;
  readonly plan_monthly_allowance: number;
  readonly plan_max_units_per_request: number;
}

const ACCOUNT_COLUMNS = 'id, name, api_key_hash, plan_id, created_at';

export async function insertAccount(
  executor: SqlExecutor,
  input: {
    name: string;
    apiKeyHash: ApiKeyHash;
    planId: PlanId;
  },
): Promise<AccountRow> {
  const result = await executor.query<AccountRow>(
    `INSERT INTO accounts (name, api_key_hash, plan_id)
     VALUES ($1, $2, $3)
     RETURNING ${ACCOUNT_COLUMNS}`,
    [input.name, input.apiKeyHash, input.planId],
  );
  return result.rows[0] as AccountRow;
}

/** Used by key rotation: one atomic UPDATE invalidates the previous key. */
export async function updateApiKeyHash(
  executor: SqlExecutor,
  accountId: AccountId,
  apiKeyHash: ApiKeyHash,
): Promise<void> {
  await executor.query(
    'UPDATE accounts SET api_key_hash = $2 WHERE id = $1',
    [accountId, apiKeyHash],
  );
}

/** Rebind the account to another ACCOUNT-type plan (runtime plan mutation). */
export async function updatePlanBinding(
  executor: SqlExecutor,
  accountId: AccountId,
  planId: PlanId,
): Promise<void> {
  await executor.query(
    'UPDATE accounts SET plan_id = $2 WHERE id = $1',
    [accountId, planId],
  );
}

/** Account profile + bound plan rules, for GET /accounts/me. */
export async function findAccountWithPlan(
  executor: SqlExecutor,
  accountId: AccountId,
): Promise<AccountWithPlanRow | null> {
  const result = await executor.query<AccountWithPlanRow>(
    `SELECT a.id, a.name, a.created_at,
            p.id AS plan_id, p.name AS plan_name, p.type AS plan_type,
            p.monthly_allowance AS plan_monthly_allowance,
            p.max_units_per_request AS plan_max_units_per_request
       FROM accounts a
       JOIN plans p ON p.id = a.plan_id
      WHERE a.id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}
