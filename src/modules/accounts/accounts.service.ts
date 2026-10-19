import { NotFoundError } from '../../domain/errors.js';
import {
  currentUtcPeriod,
  generateApiKey,
  hashApiKey,
  type AccountId,
  type ApiKey,
  type ChangePlanDto,
  type CreateAccountDto,
  type PlanId,
} from '../../domain/types.js';
import { pool, query } from '../../database/connection.js';
import * as accountsRepo from './accounts.repository.js';
import * as plansRepo from '../plans/plans.repository.js';
import { resolveUsablePlan } from '../plans/plans.service.js';

/**
 * Accounts service — provisioning, API key lifecycle, plan binding.
 *
 * API key lifecycle contract:
 *   - Keys are generated here (256-bit `mk_<base64url>`), hashed with
 *     SHA-256 before leaving this file, and returned in plaintext exactly
 *     once. There is no "get key" endpoint by design.
 *   - Rotation is a single UPDATE on the hash — the old key stops working
 *     atomically, with no eventual-consistency window.
 */

/** The predefined plan new accounts get when none is requested. */
const DEFAULT_ACCOUNT_PLAN = 'Starter';

export interface AccountView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly plan: {
    readonly id: string;
    readonly name: string;
    readonly type: 'ACCOUNT';
    readonly monthlyAllowance: number;
    readonly maxUnitsPerRequest: number;
  };
}

export interface CreatedAccount extends AccountView {
  /** Plaintext API key — shown exactly once, never persisted. */
  readonly apiKey: string;
}

/**
 * Create an account bound to a predefined ACCOUNT plan.
 *
 * This is the only unauthenticated route in the system (bootstrap
 * chicken-and-egg: you need an account to authenticate). At creation time
 * an account can not own custom plans yet, so only predefined plans are
 * eligible bindings.
 */
export async function createAccount(dto: CreateAccountDto): Promise<CreatedAccount> {
  const plan = await resolveBootstrapPlan(dto);

  const apiKey: ApiKey = generateApiKey();
  const account = await accountsRepo.insertAccount(pool, {
    name: dto.name,
    apiKeyHash: hashApiKey(apiKey),
    planId: plan.id,
  });

  return {
    id: account.id,
    name: account.name,
    createdAt: account.created_at,
    apiKey,
    plan: {
      id: plan.id,
      name: plan.name,
      type: 'ACCOUNT',
      monthlyAllowance: plan.monthlyAllowance,
      maxUnitsPerRequest: plan.maxUnitsPerRequest,
    },
  };
}

async function resolveBootstrapPlan(dto: CreateAccountDto) {
  if (dto.planId !== undefined) {
    const plan = await plansRepo.findPlanById(pool, dto.planId as PlanId);
    if (plan === null || !plan.isPredefined || plan.type !== 'ACCOUNT') {
      throw new NotFoundError(
        'No predefined ACCOUNT plan with that id exists. Run `npm run seed` or use planName.',
      );
    }
    return plan;
  }

  const plan = await plansRepo.findPredefinedPlanByName(
    pool,
    dto.planName ?? DEFAULT_ACCOUNT_PLAN,
  );
  if (plan === null || plan.type !== 'ACCOUNT') {
    throw new NotFoundError(
      `No predefined ACCOUNT plan named "${dto.planName ?? DEFAULT_ACCOUNT_PLAN}" exists. ` +
        'Run `npm run seed` first.',
    );
  }
  return plan;
}

/** Rotate the API key; the previous key dies atomically. */
export async function rotateApiKey(accountId: AccountId): Promise<ApiKey> {
  const apiKey = generateApiKey();
  await accountsRepo.updateApiKeyHash(pool, accountId, hashApiKey(apiKey));
  return apiKey;
}

/**
 * Runtime plan mutation (spec §5 Phase 6): rebind the account to any
 * ACCOUNT-type plan the caller may use — predefined or custom — without
 * restarting anything. Usage counters are untouched (monotonic), so the
 * new, larger allowance applies to *remaining* budget immediately.
 */
export async function changePlan(
  accountId: AccountId,
  dto: ChangePlanDto,
): Promise<AccountView> {
  const plan = await resolveUsablePlan(accountId, dto, 'ACCOUNT', null);
  await accountsRepo.updatePlanBinding(pool, accountId, plan.id);

  const row = await accountsRepo.findAccountWithPlan(pool, accountId);
  if (row === null) {
    throw new NotFoundError('Account not found.');
  }
  return toAccountView(row);
}

/** Profile + live usage projection for the current UTC month. */
export async function getProfile(
  accountId: AccountId,
): Promise<AccountView & {
  usage: { readonly period: string; readonly unitsConsumed: number; readonly remaining: number };
}> {
  const row = await accountsRepo.findAccountWithPlan(pool, accountId);
  if (row === null) {
    throw new NotFoundError('Account not found.');
  }

  const period = currentUtcPeriod();
  const usageResult = await query<{ units_consumed: number | null }>(
    `SELECT units_consumed
       FROM monthly_usage
      WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
    [accountId, period],
  );
  const consumed = usageResult.rows[0]?.units_consumed ?? 0;

  return {
    ...toAccountView(row),
    usage: {
      period,
      unitsConsumed: consumed,
      remaining: Math.max(0, row.plan_monthly_allowance - consumed),
    },
  };
}

function toAccountView(row: accountsRepo.AccountWithPlanRow): AccountView {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      // The accounts_plan_type_guard trigger guarantees ACCOUNT-type plans
      // on accounts; the assertion here documents that invariant.
      type: 'ACCOUNT',
      monthlyAllowance: row.plan_monthly_allowance,
      maxUnitsPerRequest: row.plan_max_units_per_request,
    },
  };
}
