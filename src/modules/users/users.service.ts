import { ConflictError, NotFoundError, isUniqueViolation } from '../../domain/errors.js';
import type {
  AccountId,
  ChangePlanDto,
  CreateUserDto,
} from '../../domain/types.js';
import { pool } from '../../database/connection.js';
import * as usersRepo from './users.repository.js';
import { resolveUsablePlan } from '../plans/plans.service.js';

/**
 * Users service — tenant-scoped user registration.
 *
 * The predefined plan assigned when none is requested.
 */
const DEFAULT_USER_PLAN = 'Basic';

export interface UserView {
  readonly userId: string;
  readonly createdAt: Date;
  readonly plan: {
    readonly id: string;
    readonly name: string;
    readonly type: 'USER';
    readonly monthlyAllowance: number;
    readonly maxUnitsPerRequest: number;
  };
}

export async function createUser(
  accountId: AccountId,
  dto: CreateUserDto,
): Promise<UserView> {
  const plan = await resolveUsablePlan(
    accountId,
    dto,
    'USER',
    DEFAULT_USER_PLAN,
  );

  try {
    const row = await usersRepo.insertUser(pool, {
      accountId,
      externalId: dto.userId,
      planId: plan.id,
    });
    return {
      userId: row.external_id,
      createdAt: row.created_at,
      plan: {
        id: plan.id,
        name: plan.name,
        type: 'USER',
        monthlyAllowance: plan.monthlyAllowance,
        maxUnitsPerRequest: plan.maxUnitsPerRequest,
      },
    };
  } catch (error) {
    if (isUniqueViolation(error, 'unique_user_per_account')) {
      throw new ConflictError(
        `User "${dto.userId}" already exists in this account.`,
      );
    }
    throw error;
  }
}

export async function listUsers(accountId: AccountId): Promise<UserView[]> {
  const rows = await usersRepo.listUsersWithPlan(pool, accountId);
  return rows.map((row) => ({
    userId: row.external_id,
    createdAt: row.created_at,
    plan: {
      id: row.plan_id,
      name: row.plan_name,
      type: 'USER',
      monthlyAllowance: row.plan_monthly_allowance,
      maxUnitsPerRequest: row.plan_max_units_per_request,
    },
  }));
}

/**
 * Runtime user plan mutation (rule change without restart). Usage counters
 * are NEVER touched: monotonic counters + derived `remaining` mean a
 * downgrade simply clamps remaining to 0 until next month, an upgrade
 * expands capacity instantly, and the audit trail stays truthful.
 */
export async function changeUserPlan(
  accountId: AccountId,
  externalUserId: string,
  dto: ChangePlanDto,
): Promise<UserView> {
  const user = await usersRepo.findUserRowByExternalId(
    pool,
    accountId,
    externalUserId,
  );
  if (user === null) {
    throw new NotFoundError(
      `User "${externalUserId}" does not exist in this account.`,
    );
  }

  const plan = await resolveUsablePlan(accountId, dto, 'USER', null);
  const updated = await usersRepo.updateUserPlan(
    pool,
    accountId,
    user.id,
    plan.id,
  );
  if (updated === null) {
    throw new NotFoundError(`User "${externalUserId}" does not exist in this account.`);
  }

  return {
    userId: updated.external_id,
    createdAt: updated.created_at,
    plan: {
      id: plan.id,
      name: plan.name,
      type: 'USER',
      monthlyAllowance: plan.monthlyAllowance,
      maxUnitsPerRequest: plan.maxUnitsPerRequest,
    },
  };
}
