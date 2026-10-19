import { isErr } from '../../domain/result.js';
import { evaluateConsumption } from '../../domain/rules.js';
import {
  ConflictError,
  NotFoundError,
  isUniqueViolation,
} from '../../domain/errors.js';
import type {
  AccountId,
  AuthContext,
  ConsumeDto,
  ConsumeOutcome,
  ConsumeResponseBody,
  HistoryQueryDto,
  Period,
  PlanId,
  PlanSnapshot,
  PlanUsageView,
  UsageQueryDto,
  UserId,
} from '../../domain/types.js';
import {
  currentUtcPeriod,
  isValidPeriod,
  requestFingerprint,
} from '../../domain/types.js';
import { pool, withTransaction } from '../../database/connection.js';
import type { SqlExecutor } from '../../database/executor.js';
import * as meteringRepo from './metering.repository.js';
import { findPlanById } from '../plans/plans.repository.js';
import { findUserRowByExternalId } from '../users/users.repository.js';

/**
 * Metering service — the quota engine's serialization point.
 *
 * TRANSACTION SHAPE (spec §4, with the lock-order contract):
 *
 *   ⓪ Replay fast path (NO transaction): if (account_id, request_id) is
 *      already committed, return the frozen payload immediately — a retry
 *      never opens a transaction or takes locks.
 *   BEGIN
 *     1. Idempotency probe: (account_id, request_id) already recorded?
 *        → COMMIT-less return of the stored payload (replay).
 *     2. Resolve (account_id, external userId) → internal user row.
 *        Unknown user ⇒ 404 (IDOR-safe: no cross-tenant probing).
 *     3. LOCK monthly_usage (account_id, NULL, period)      ← order 1
 *     4. LOCK monthly_usage (account_id, user_uuid, period) ← order 2
 *     5. Read the two bound plans (MVCC read committed, no locks needed —
 *        plan rows are only ever INSERT/UPDATEd, never deleted).
 *     6. evaluateConsumption() — pure function decides accept/reject.
 *     7a. REJECT: persist the decision (audit) with violation fields.
 *     7b. ACCEPT: increment BOTH counters monotonically, persist decision.
 *     8. COMMIT — the only instant at which any of this becomes visible.
 *
 * If TWO transactions race on the same (account_id, request_id), both pass
 * step 1 (neither record is committed yet), serialize on step 3/4, and the
 * loser's step-7 INSERT violates `unique_request_idempotency`, aborting
 * the ENTIRE transaction (including its counter increments — zero double
 * spend). The service catches SQLSTATE 23505 and returns the winner's
 * stored payload: both callers see the identical decision.
 */

export async function consume(
  auth: AuthContext,
  dto: ConsumeDto,
): Promise<ConsumeOutcome> {
  const { accountId } = auth;
  const period = currentUtcPeriod();

  // Replay-conflict defense: fingerprint the canonical request payload.
  // One idempotency key maps to exactly one request — a key reused with a
  // DIFFERENT payload is a 409, never a silent replay of a decision the
  // client did not send (Stripe-style idempotency_error). Legacy rows
  // (fingerprint NULL) keep replaying as before.
  const fingerprint = requestFingerprint(accountId, dto.userId, dto.units);

  // ⓪ REPLAY FAST PATH (outside any transaction). A committed decision is
  // IMMUTABLE, so a plain MVCC read is sufficient to serve a retry: it
  // never pays for BEGIN, the row locks, or the convoy, and — crucially —
  // a retry storm of already-decided requests cannot contend with live
  // decisions. The in-transaction re-check (step 1 below) still covers the
  // race where two workers probe simultaneously before either commits;
  // those losers abort on the unique constraint with their increments
  // rolled back (see the catch below).
  const committed = await meteringRepo.findConsumptionRecord(
    pool,
    accountId,
    dto.requestId,
  );
  if (committed !== null) {
    assertFingerprintMatches(committed.fingerprint, fingerprint);
    return replayOutcome(committed);
  }

  try {
    return await withTransaction(async (client) => {
      // 1. Idempotency re-check INSIDE the transaction: closes the race
      //    window between the fast path and this commit for two workers
      //    carrying the same request id.
      const stored = await meteringRepo.findConsumptionRecord(
        client,
        accountId,
        dto.requestId,
      );
      if (stored !== null) {
        assertFingerprintMatches(stored.fingerprint, fingerprint);
        return replayOutcome(stored);
      }

      // 2. Tenant-scoped user resolution (IDOR guard).
      const user = await findUserRowByExternalId(
        client,
        accountId,
        dto.userId,
      );
      if (user === null) {
        throw new NotFoundError(
          `User "${dto.userId}" does not exist in this account.`,
        );
      }

      // 3–4. Deterministic lock order: account aggregate FIRST, user SECOND.
      const accountConsumed = await meteringRepo.lockAccountUsage(
        client,
        accountId,
        period,
      );
      const userConsumed = await meteringRepo.lockUserUsage(
        client,
        accountId,
        user.id as UserId,
        period,
      );

      // 5. Plan snapshots — RE-READ inside the locked transaction. The
      //    account binding is NOT taken from the auth middleware snapshot
      //    (auth ran milliseconds earlier): a concurrent plan switch must
      //    not leave the decision evaluating a stale binding (TOCTOU fix).
      //    Plans themselves are never deleted while bound, so a plain
      //    read-committed read under the held locks is safe.
      const accountPlan = await loadAccountPlan(client, accountId);
      const userPlan = await requirePlan(client, user.plan_id as PlanId);

      // 6. Pure evaluation.
      const evaluation = evaluateConsumption({
        requestedUnits: dto.units,
        accountPlan: {
          monthlyAllowance: accountPlan.monthlyAllowance,
          maxUnitsPerRequest: accountPlan.maxUnitsPerRequest,
        },
        userPlan: {
          monthlyAllowance: userPlan.monthlyAllowance,
          maxUnitsPerRequest: userPlan.maxUnitsPerRequest,
        },
        accountUsage: { unitsConsumed: accountConsumed },
        userUsage: { unitsConsumed: userConsumed },
      });

      // 7 + 8. Persist the decision (both branches), commit atomically.
      if (isErr(evaluation)) {
        const payload: ConsumeResponseBody = {
          accepted: false,
          requestId: dto.requestId,
          period,
          reason: evaluation.error.reason,
          violation: evaluation.error.violation,
        };

        await meteringRepo.insertConsumptionRecord(client, {
          accountId,
          userId: user.id as UserId,
          requestId: dto.requestId,
          unitsRequested: dto.units,
          accepted: false,
          period,
          rejectionReason: evaluation.error.reason,
          rejectionSource: evaluation.error.violation.source,
          rejectionRule: evaluation.error.violation.rule,
          responsePayload: payload,
          fingerprint,
        });

        return { statusCode: 422, replayed: false, payload };
      }

      const acceptedEval = evaluation.value;

      // Increment the ALREADY-LOCKED rows; both updates are no-ops for lock
      // ordering because this transaction already holds both row locks.
      const newAccountConsumed = await meteringRepo.incrementUsage(
        client,
        accountId,
        null,
        period,
        dto.units,
      );
      const newUserConsumed = await meteringRepo.incrementUsage(
        client,
        accountId,
        user.id as UserId,
        period,
        dto.units,
      );

      const payload: ConsumeResponseBody = {
        accepted: true,
        requestId: dto.requestId,
        period,
        unitsConsumed: acceptedEval.unitsConsumed,
        usage: {
          account: buildUsageView(accountPlan, newAccountConsumed),
          user: buildUsageView(userPlan, newUserConsumed),
        },
      };

      await meteringRepo.insertConsumptionRecord(client, {
        accountId,
        userId: user.id as UserId,
        requestId: dto.requestId,
        unitsRequested: dto.units,
        accepted: true,
        period,
        rejectionReason: null,
        rejectionSource: null,
        rejectionRule: null,
        responsePayload: payload,
        fingerprint,
      });

      return { statusCode: 200, replayed: false, payload };
    });
  } catch (error) {
    // Lost the idempotency race: another worker committed this request id
    // first. Return THEIR decision — identical semantics, zero double spend —
    // unless the racing payload differs, which is an idempotency conflict.
    if (isUniqueViolation(error, 'unique_request_idempotency')) {
      const stored = await meteringRepo.findConsumptionRecord(
        pool,
        accountId,
        dto.requestId,
      );
      if (stored !== null) {
        assertFingerprintMatches(stored.fingerprint, fingerprint);
        return replayOutcome(stored);
      }
    }
    throw error;
  }
}

/** Shared replay renderer: the frozen payload + the ORIGINAL status code. */
function replayOutcome(stored: meteringRepo.StoredRecord): ConsumeOutcome {
  return {
    statusCode: stored.accepted ? 200 : 422,
    replayed: true,
    payload: stored.responsePayload,
  };
}

/**
 * Replay-conflict guard (audit rule 3): one idempotency key maps to exactly
 * one request payload. Legacy rows (NULL fingerprint) are exempt.
 */
function assertFingerprintMatches(
  stored: string | null,
  computed: string,
): void {
  if (stored !== null && stored !== computed) {
    throw new ConflictError(
      'This requestId was already used with a different request payload. ' +
        'An idempotency key maps to exactly one immutable decision — ' +
        'use a new requestId for a new request.',
    );
  }
}

function buildUsageView(
  plan: PlanSnapshot,
  unitsConsumed: number,
): PlanUsageView {
  return {
    planName: plan.name,
    planType: plan.type,
    monthlyAllowance: plan.monthlyAllowance,
    maxUnitsPerRequest: plan.maxUnitsPerRequest,
    unitsConsumed,
    remaining: Math.max(0, plan.monthlyAllowance - unitsConsumed),
  };
}

async function requirePlan(
  executor: SqlExecutor,
  planId: PlanId,
): Promise<PlanSnapshot> {
  const plan = await findPlanById(executor, planId);
  if (plan === null) {
    // Impossible in practice (FK + no delete endpoint), but fail loudly
    // rather than invent a quota decision from missing data.
    throw new NotFoundError('Bound plan no longer exists.');
  }
  return plan;
}

// ---------------------------------------------------------------------------
// GET /metering/usage — live usage views (pure reads, no locks)
// ---------------------------------------------------------------------------

export interface UsageReport {
  readonly period: Period;
  readonly account: PlanUsageView;
  readonly user?: PlanUsageView | undefined;
}

export async function getUsage(
  auth: AuthContext,
  dto: UsageQueryDto,
): Promise<UsageReport> {
  const period: Period = isValidPeriod(dto.period ?? '')
    ? (dto.period as Period)
    : currentUtcPeriod();

  const accountWithPlan = await loadAccountPlan(pool, auth.accountId);
  const accountConsumed = await meteringRepo.getAccountUsage(
    pool,
    auth.accountId,
    period,
  );
  const accountView = buildUsageView(accountWithPlan, accountConsumed);

  if (dto.userId === undefined) {
    return { period, account: accountView };
  }

  const user = await findUserRowByExternalId(
    pool,
    auth.accountId,
    dto.userId,
  );
  if (user === null) {
    throw new NotFoundError(
      `User "${dto.userId}" does not exist in this account.`,
    );
  }
  const userPlan = await requirePlan(pool, user.plan_id as PlanId);
  const userConsumed = await meteringRepo.getUserUsage(
    pool,
    auth.accountId,
    user.id as UserId,
    period,
  );

  return {
    period,
    account: accountView,
    user: buildUsageView(userPlan, userConsumed),
  };
}

async function loadAccountPlan(
  executor: SqlExecutor,
  accountId: AccountId,
): Promise<PlanSnapshot> {
  const result = await executor.query<{
    id: string;
    name: string;
    type: 'ACCOUNT' | 'USER';
    is_predefined: boolean;
    monthly_allowance: number;
    max_units_per_request: number;
  }>(
    `SELECT p.id, p.name, p.type, p.is_predefined,
            p.monthly_allowance, p.max_units_per_request
       FROM accounts a JOIN plans p ON p.id = a.plan_id
      WHERE a.id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new NotFoundError('Account not found.');
  }
  return {
    id: row.id as never,
    name: row.name,
    type: row.type,
    isPredefined: row.is_predefined,
    monthlyAllowance: row.monthly_allowance,
    maxUnitsPerRequest: row.max_units_per_request,
  };
}

// ---------------------------------------------------------------------------
// GET /metering/history — paginated audit trail
// ---------------------------------------------------------------------------

export interface HistoryRecord {
  readonly requestId: string;
  readonly userId: string;
  readonly unitsRequested: number;
  readonly accepted: boolean;
  readonly rejectionReason: string | null;
  readonly rejectionSource: string | null;
  readonly rejectionRule: string | null;
  readonly period: string;
  readonly createdAt: string;
  readonly response: ConsumeResponseBody;
}

export interface HistoryReport {
  readonly records: HistoryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export async function getHistory(
  auth: AuthContext,
  dto: HistoryQueryDto,
): Promise<HistoryReport> {
  let internalUserId: UserId | null = null;
  if (dto.userId !== undefined) {
    const user = await findUserRowByExternalId(
      pool,
      auth.accountId,
      dto.userId,
    );
    if (user === null) {
      throw new NotFoundError(
        `User "${dto.userId}" does not exist in this account.`,
      );
    }
    internalUserId = user.id as UserId;
  }

  const filter = {
    accountId: auth.accountId,
    internalUserId,
    period: dto.period ?? null,
    accepted:
      dto.accepted === undefined ? null : dto.accepted === 'true',
  };

  const [rows, total] = await Promise.all([
    meteringRepo.listHistory(pool, { ...filter, limit: dto.limit, offset: dto.offset }),
    meteringRepo.countHistory(pool, filter),
  ]);

  return {
    records: rows.map((row) => ({
      requestId: row.request_id,
      userId: row.external_id,
      unitsRequested: row.units_requested,
      accepted: row.accepted,
      rejectionReason: row.rejection_reason,
      rejectionSource: row.rejection_source,
      rejectionRule: row.rejection_rule,
      period: row.period,
      createdAt: row.created_at.toISOString(),
      response: row.response_payload,
    })),
    total,
    limit: dto.limit,
    offset: dto.offset,
  };
}
