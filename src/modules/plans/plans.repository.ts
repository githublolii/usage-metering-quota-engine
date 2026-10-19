import type { PlanId, PlanSnapshot, PlanType } from '../../domain/types.js';
import type { SqlExecutor } from '../../database/executor.js';

/**
 * Plans repository — every method takes an `SqlExecutor` so the same code
 * runs inside or outside transactions; ownership scoping happens in the
 * service layer, which is the only caller trusted to pass tenant context.
 */

interface PlanRow {
  readonly id: string;
  readonly account_id: string | null;
  readonly name: string;
  readonly type: PlanType;
  readonly is_predefined: boolean;
  readonly monthly_allowance: number;
  readonly max_units_per_request: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const PLAN_COLUMNS =
  'id, account_id, name, type, is_predefined, monthly_allowance, max_units_per_request, created_at, updated_at';

/**
 * Internal record: a public plan snapshot plus the owning account id,
 * which the service needs for ownership (IDOR) checks but never exposes.
 */
export interface PlanRecord extends PlanSnapshot {
  readonly accountId: string | null;
}

/** Public projection of a plan (never leaks the owning account id). */
export interface PublicPlanView {
  readonly id: string;
  readonly name: string;
  readonly type: PlanType;
  readonly isPredefined: boolean;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toRecord(row: PlanRow): PlanRecord {
  return {
    id: row.id as PlanId,
    name: row.name,
    type: row.type,
    isPredefined: row.is_predefined,
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
    accountId: row.account_id,
  };
}

function toPublicView(row: PlanRow): PublicPlanView {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    isPredefined: row.is_predefined,
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function findPlanById(
  executor: SqlExecutor,
  planId: PlanId,
): Promise<PlanRecord | null> {
  const result = await executor.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1`,
    [planId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function findPredefinedPlanByName(
  executor: SqlExecutor,
  name: string,
): Promise<PlanRecord | null> {
  const result = await executor.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS}
       FROM plans
      WHERE is_predefined = TRUE AND account_id IS NULL AND name = $1`,
    [name],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

/** A custom plan owned by `accountId` (IDOR-safe: never matches other tenants). */
export async function findCustomPlanByName(
  executor: SqlExecutor,
  accountId: string,
  name: string,
  type?: PlanType,
): Promise<PlanRecord | null> {
  const result = await executor.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS}
       FROM plans
      WHERE is_predefined = FALSE AND account_id = $1 AND name = $2
        AND ($3::varchar IS NULL OR type = $3)`,
    [accountId, name, type ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : toRecord(row);
}

export async function insertCustomPlan(
  executor: SqlExecutor,
  input: {
    accountId: string;
    name: string;
    type: PlanType;
    monthlyAllowance: number;
    maxUnitsPerRequest: number;
  },
): Promise<PublicPlanView> {
  const result = await executor.query<PlanRow>(
    `INSERT INTO plans
        (account_id, name, type, is_predefined, monthly_allowance, max_units_per_request)
     VALUES ($1, $2, $3, FALSE, $4, $5)
     RETURNING ${PLAN_COLUMNS}`,
    [
      input.accountId,
      input.name,
      input.type,
      input.monthlyAllowance,
      input.maxUnitsPerRequest,
    ],
  );
  return toPublicView(result.rows[0] as PlanRow);
}

/** Predefined (system-wide) plans + the account's own custom plans. */
export async function listVisiblePlans(
  executor: SqlExecutor,
  accountId: string,
): Promise<PublicPlanView[]> {
  const result = await executor.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS}
       FROM plans
      WHERE account_id IS NULL OR account_id = $1
      ORDER BY is_predefined DESC, type ASC, name ASC`,
    [accountId],
  );
  return result.rows.map(toPublicView);
}

/**
 * Update a CUSTOM plan owned by `accountId`. The WHERE clause doubles as
 * the ownership guard: predefined plans (account_id NULL) and other
 * tenants' plans simply never match, so the caller sees 404 — IDOR-safe.
 * An empty patch set is rejected by the DTO schema, never by SQL.
 */
export async function updateCustomPlan(
  executor: SqlExecutor,
  planId: PlanId,
  accountId: string,
  patch: {
    name?: string | undefined;
    monthlyAllowance?: number | undefined;
    maxUnitsPerRequest?: number | undefined;
  },
): Promise<PublicPlanView | null> {
  const result = await executor.query<PlanRow>(
    `UPDATE plans
        SET name = COALESCE($3, name),
            monthly_allowance = COALESCE($4, monthly_allowance),
            max_units_per_request = COALESCE($5, max_units_per_request),
            updated_at = NOW()
      WHERE id = $1 AND account_id = $2 AND is_predefined = FALSE
      RETURNING ${PLAN_COLUMNS}`,
    [planId, accountId, patch.name ?? null, patch.monthlyAllowance ?? null, patch.maxUnitsPerRequest ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPublicView(row);
}

/**
 * How many accounts/users currently reference this plan. Used to refuse
 * deleting a plan that is still bound — a bound plan disappearing would
 * leave live quota decisions pointing at rules that no longer exist.
 */
export async function countPlanBindings(
  executor: SqlExecutor,
  planId: PlanId,
): Promise<{ accounts: number; users: number }> {
  const result = await executor.query<{ accounts: string; users: string }>(
    `SELECT
       (SELECT COUNT(*)::text FROM accounts WHERE plan_id = $1) AS accounts,
       (SELECT COUNT(*)::text FROM users    WHERE plan_id = $1) AS users`,
    [planId],
  );
  const row = result.rows[0] as { accounts: string; users: string };
  return { accounts: Number(row.accounts), users: Number(row.users) };
}

/**
 * Delete a CUSTOM plan owned by `accountId` (never predefined, never
 * another tenant's). The service layer refuses when bindings exist.
 */
export async function deleteCustomPlan(
  executor: SqlExecutor,
  planId: PlanId,
  accountId: string,
): Promise<boolean> {
  const result = await executor.query(
    `DELETE FROM plans
      WHERE id = $1 AND account_id = $2 AND is_predefined = FALSE`,
    [planId, accountId],
  );
  return (result.rowCount ?? 0) > 0;
}
