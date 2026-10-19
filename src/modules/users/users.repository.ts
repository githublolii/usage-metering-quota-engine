import type { PlanId } from '../../domain/types.js';
import type { SqlExecutor } from '../../database/executor.js';

/**
 * Users repository.
 *
 * Users are ALWAYS resolved through (account_id, external_id) — never by
 * the internal UUID from client input. That composite is UNIQUE and
 * indexed, and it is precisely what makes cross-tenant lookups impossible:
 * a `userId` from tenant A can simply never match tenant B's rows.
 */

export interface UserRow {
  readonly id: string;
  readonly account_id: string;
  readonly external_id: string;
  readonly plan_id: string;
  readonly created_at: Date;
}

export interface UserWithPlanRow {
  readonly id: string;
  readonly external_id: string;
  readonly created_at: Date;
  readonly plan_id: string;
  readonly plan_name: string;
  readonly plan_monthly_allowance: number;
  readonly plan_max_units_per_request: number;
}

const USER_COLUMNS = 'id, account_id, external_id, plan_id, created_at';

export async function insertUser(
  executor: SqlExecutor,
  input: {
    accountId: string;
    externalId: string;
    planId: PlanId;
  },
): Promise<UserRow> {
  const result = await executor.query<UserRow>(
    `INSERT INTO users (account_id, external_id, plan_id)
     VALUES ($1, $2, $3)
     RETURNING ${USER_COLUMNS}`,
    [input.accountId, input.externalId, input.planId],
  );
  return result.rows[0] as UserRow;
}

/**
 * Rebind a user to another plan (runtime rule change). Scoped by BOTH the
 * internal user id AND the owning account — the tenant guard rides along
 * in the WHERE clause, so a foreign user id can never match.
 */
export async function updateUserPlan(
  executor: SqlExecutor,
  accountId: string,
  userId: string,
  planId: PlanId,
): Promise<UserRow | null> {
  const result = await executor.query<UserRow>(
    `UPDATE users
        SET plan_id = $3
      WHERE id = $1 AND account_id = $2
      RETURNING ${USER_COLUMNS}`,
    [userId, accountId, planId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve the internal user id for a caller-supplied external id, scoped
 * to the authenticated account. Runs inside the consume transaction so the
 * (account_id, external_id) → users row is stable for the whole decision.
 */
export async function findUserRowByExternalId(
  executor: SqlExecutor,
  accountId: string,
  externalId: string,
): Promise<UserRow | null> {
  const result = await executor.query<UserRow>(
    `SELECT ${USER_COLUMNS}
       FROM users
      WHERE account_id = $1 AND external_id = $2`,
    [accountId, externalId],
  );
  return result.rows[0] ?? null;
}

/** Full user + plan projection for list/read endpoints. */
export async function listUsersWithPlan(
  executor: SqlExecutor,
  accountId: string,
): Promise<UserWithPlanRow[]> {
  const result = await executor.query<UserWithPlanRow>(
    `SELECT u.id, u.external_id, u.created_at,
            p.id AS plan_id, p.name AS plan_name,
            p.monthly_allowance AS plan_monthly_allowance,
            p.max_units_per_request AS plan_max_units_per_request
       FROM users u
       JOIN plans p ON p.id = u.plan_id
      WHERE u.account_id = $1
      ORDER BY u.created_at ASC, u.external_id ASC`,
    [accountId],
  );
  return result.rows;
}
