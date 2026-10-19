import {
  ConflictError,
  NotFoundError,
  isUniqueViolation,
} from '../../domain/errors.js';
import type {
  CreatePlanDto,
  PlanId,
  PlanSnapshot,
  PlanType,
  UpdatePlanDto,
} from '../../domain/types.js';
import { pool } from '../../database/connection.js';
import type { SqlExecutor } from '../../database/executor.js';
import * as plansRepo from './plans.repository.js';
import type { PublicPlanView } from './plans.repository.js';

export type { PublicPlanView };

/**
 * Plans service.
 *
 * Plan resolution rules (the anti-IDOR core):
 *   - A caller may only bind plans that are predefined (system-wide,
 *     account_id NULL) or custom plans owned by *their own* account_id.
 *   - Looking up another tenant's plan by id or name yields 404 —
 *     indistinguishable from "does not exist", so probing is useless.
 *   - A plan reference must have the type the caller needs (ACCOUNT plan
 *     for account binding, USER plan for users) — additionally enforced
 *     at the database level by the `*_plan_type_guard` triggers.
 */

export async function listPlans(accountId: string): Promise<PublicPlanView[]> {
  return plansRepo.listVisiblePlans(pool, accountId);
}

export async function createCustomPlan(
  accountId: string,
  dto: CreatePlanDto,
): Promise<PublicPlanView> {
  try {
    return await plansRepo.insertCustomPlan(pool, {
      accountId,
      name: dto.name,
      type: dto.type,
      monthlyAllowance: dto.monthlyAllowance,
      maxUnitsPerRequest: dto.maxUnitsPerRequest,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'unique_plan_name_scope')) {
      throw new ConflictError(
        `A plan named "${dto.name}" of type ${dto.type} already exists in this scope.`,
      );
    }
    throw error;
  }
}

/**
 * Update a custom plan owned by the caller. Rules:
 *   - plan type is IMMUTABLE (an ACCOUNT plan never becomes a USER plan —
 *     that would silently change what it means for every bound subject);
 *   - is_predefined is immutable by construction (the SQL only matches
 *     custom plans owned by the caller);
 *   - a bound plan MAY be updated: existing usage is monotonic, so a
 *     reduced allowance simply clamps `remaining` to 0 until next month
 *     (the documented downgrade semantics).
 */
export async function updateCustomPlan(
  accountId: string,
  planId: string,
  dto: UpdatePlanDto,
): Promise<PublicPlanView> {
  try {
    const updated = await plansRepo.updateCustomPlan(
      pool,
      planId as PlanId,
      accountId,
      {
        name: dto.name,
        monthlyAllowance: dto.monthlyAllowance,
        maxUnitsPerRequest: dto.maxUnitsPerRequest,
      },
    );
    if (updated === null) {
      throw new NotFoundError(
        'Plan not found. Only custom plans owned by your account can be updated.',
      );
    }
    return updated;
  } catch (error) {
    if (isUniqueViolation(error, 'unique_plan_name_scope')) {
      throw new ConflictError(
        `A plan named "${dto.name}" already exists in this scope.`,
      );
    }
    throw error;
  }
}

/**
 * Delete a custom plan owned by the caller — but only while it is
 * UNBOUND. Deleting a plan still referenced by an account or user would
 * orphan live quota bindings (decisions must always resolve against
 * existing rules). Rebind the subjects first (PATCH /accounts/plan,
 * PATCH /users/:userId/plan), then delete.
 */
export async function deleteCustomPlan(
  accountId: string,
  planId: string,
): Promise<{ deleted: true; name: string }> {
  const bindings = await plansRepo.countPlanBindings(pool, planId as PlanId);
  if (bindings.accounts > 0 || bindings.users > 0) {
    throw new ConflictError(
      `Plan is still bound to ${bindings.accounts} account(s) and ` +
        `${bindings.users} user(s). Rebind them first — a bound plan cannot be deleted.`,
    );
  }

  const deleted = await plansRepo.deleteCustomPlan(
    pool,
    planId as PlanId,
    accountId,
  );
  if (!deleted) {
    throw new NotFoundError(
      'Plan not found. Only custom plans owned by your account can be deleted.',
    );
  }
  return { deleted: true, name: planId };
}

export interface PlanReference {
  readonly planName?: string | undefined;
  readonly planId?: string | undefined;
}

/**
 * Resolve a caller-supplied plan reference to a plan the caller is allowed
 * to use. `defaultPredefined` applies when the caller gave no reference
 * (e.g. "Starter" for new accounts, "Basic" for new users).
 *
 * Name resolution prefers the account's own custom plan over a predefined
 * plan with the same name — custom plans shadow the catalog.
 */
export async function resolveUsablePlan(
  accountId: string,
  reference: PlanReference,
  expectedType: PlanType,
  defaultPredefined: string | null,
  executor: SqlExecutor = pool,
): Promise<PlanSnapshot> {
  if (reference.planId !== undefined) {
    const plan = await plansRepo.findPlanById(
      executor,
      reference.planId as PlanId,
    );
    if (plan === null || !isPlanOwnedBy(plan, accountId)) {
      throw new NotFoundError('Plan not found.');
    }
    assertPlanType(plan, expectedType);
    return plan;
  }

  const name = reference.planName ?? defaultPredefined;
  if (name === null) {
    throw new NotFoundError('Plan reference is required: pass planName or planId.');
  }

  const custom = await plansRepo.findCustomPlanByName(
    executor,
    accountId,
    name,
    expectedType,
  );
  if (custom !== null) return custom;

  const predefined = await plansRepo.findPredefinedPlanByName(executor, name);
  if (predefined !== null) {
    // Exists but is the wrong kind of plan — say so precisely (no leak:
    // predefined plan names are public catalog data).
    assertPlanType(predefined, expectedType);
    return predefined;
  }

  throw new NotFoundError(
    `No ${expectedType}-type plan named "${name}" is available for this account. ` +
      'Custom plans must belong to your account; predefined plans are created by `npm run seed`.',
  );
}

/** Predefined plans are global; custom plans must belong to the caller. */
function isPlanOwnedBy(
  plan: plansRepo.PlanRecord,
  accountId: string,
): boolean {
  return plan.isPredefined || plan.accountId === accountId;
}

function assertPlanType(plan: PlanSnapshot, expectedType: PlanType): void {
  if (plan.type !== expectedType) {
    throw new ConflictError(
      `Plan "${plan.name}" is a ${plan.type}-type plan; a ${expectedType}-type plan is required.`,
    );
  }
}
