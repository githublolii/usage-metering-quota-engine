import { err, ok, type Result } from './result.js';
import type {
  QuotaRuleSet,
  QuotaUsage,
  RejectionRule,
  RejectionSource,
  Violation,
} from './types.js';

/**
 * PURE quota evaluation — the entire business policy of the engine.
 *
 * Zero I/O, zero imports of database/network code, 100% referentially
 * transparent: same inputs ⇒ same output, always. This makes the rule
 * exhaustively unit-testable and formally reviewable (see tests/unit/).
 *
 * Policy:
 *   - Both the ACCOUNT plan (shared across all users) and the USER plan
 *     (individual allowance) apply SIMULTANEOUSLY. Both must satisfy the
 *     request or NOTHING is consumed (atomic all-or-nothing semantics).
 *   - Usage is tracked as additive monotonic counters. `remaining` is
 *     always derived: GREATEST(0, allowance - consumed). If a plan is
 *     downgraded below current usage mid-month, existing usage is never
 *     mutated — remaining simply evaluates to 0 and new requests are
 *     rejected until the next UTC month begins.
 *   - Exact-limit requests are ACCEPTED (a request of `limit` units when
 *     exactly `limit` units remain consumes to the boundary, not past it).
 */

export interface EvaluateConsumptionInput {
  readonly requestedUnits: number;
  readonly accountPlan: QuotaRuleSet;
  readonly userPlan: QuotaRuleSet;
  readonly accountUsage: QuotaUsage;
  readonly userUsage: QuotaUsage;
}

export interface AcceptedEvaluation {
  readonly accepted: true;
  readonly unitsConsumed: number;
  readonly newAccountUsage: number;
  readonly newUserUsage: number;
  readonly accountRemainingAfter: number;
  readonly userRemainingAfter: number;
}

export interface RejectedEvaluation {
  readonly accepted: false;
  readonly reason: string;
  readonly violation: Violation;
}

export type ConsumptionEvaluation =
  | AcceptedEvaluation
  | RejectedEvaluation;

/**
 * Human-readable rejection explanations (returned verbatim in the API
 * response and persisted for audit).
 */
export const REJECTION_REASONS = {
  userMaxPerRequest:
    'Request exceeds user maximum units per request limit.',
  accountMaxPerRequest:
    'Request exceeds account maximum units per request limit.',
  userMonthly: 'Request exceeds user monthly allowance limit.',
  accountMonthly: 'Request exceeds account monthly allowance limit.',
} as const;

/**
 * Derivable remaining units. Monotonic counters mean this is a pure
 * function of (allowance, consumed) — a reduced allowance can never
 * produce a negative balance, only 0.
 */
export function remainingUnits(
  allowance: number,
  consumed: number,
): number {
  assertNonNegativeInt('allowance', allowance);
  assertNonNegativeInt('consumed', consumed);
  return Math.max(0, allowance - consumed);
}

/**
 * Deterministic violation precedence (documented contract, not an accident):
 *   1. user.max_units_per_request
 *   2. account.max_units_per_request
 *   3. user.monthly_allowance
 *   4. account.monthly_allowance
 *
 * Rationale: request-shape rules are checked before cumulative rules
 * (a malformed-sized request is rejected without consulting counters),
 * and the more specific subject (user) is checked before the shared
 * subject (account) at each tier. When several rules are violated at
 * once, the SAME violation is reported for identical inputs — essential
 * for deterministic replay-comparison in tests.
 */
export function evaluateConsumption(
  input: EvaluateConsumptionInput,
): Result<AcceptedEvaluation, RejectedEvaluation> {
  assertPositiveUnits(input.requestedUnits);
  assertValidRuleSet('accountPlan', input.accountPlan);
  assertValidRuleSet('userPlan', input.userPlan);

  const { requestedUnits, accountPlan, userPlan, accountUsage, userUsage } =
    input;

  // 1. user.max_units_per_request
  if (requestedUnits > userPlan.maxUnitsPerRequest) {
    return err(
      rejection('user', 'max_units_per_request', userPlan.maxUnitsPerRequest, requestedUnits, userUsage.unitsConsumed, remainingUnits(userPlan.monthlyAllowance, userUsage.unitsConsumed)),
    );
  }

  // 2. account.max_units_per_request
  if (requestedUnits > accountPlan.maxUnitsPerRequest) {
    return err(
      rejection('account', 'max_units_per_request', accountPlan.maxUnitsPerRequest, requestedUnits, accountUsage.unitsConsumed, remainingUnits(accountPlan.monthlyAllowance, accountUsage.unitsConsumed)),
    );
  }

  // 3. user.monthly_allowance (cumulative)
  const userRemaining = remainingUnits(
    userPlan.monthlyAllowance,
    userUsage.unitsConsumed,
  );
  if (requestedUnits > userRemaining) {
    return err(
      rejection('user', 'monthly_allowance', userPlan.monthlyAllowance, requestedUnits, userUsage.unitsConsumed, userRemaining),
    );
  }

  // 4. account.monthly_allowance (cumulative)
  const accountRemaining = remainingUnits(
    accountPlan.monthlyAllowance,
    accountUsage.unitsConsumed,
  );
  if (requestedUnits > accountRemaining) {
    return err(
      rejection('account', 'monthly_allowance', accountPlan.monthlyAllowance, requestedUnits, accountUsage.unitsConsumed, accountRemaining),
    );
  }

  // Accepted: all four rules satisfied. Note this is all-or-nothing —
  // a single failure above consumes exactly zero units.
  return ok({
    accepted: true,
    unitsConsumed: requestedUnits,
    newAccountUsage: accountUsage.unitsConsumed + requestedUnits,
    newUserUsage: userUsage.unitsConsumed + requestedUnits,
    accountRemainingAfter: accountRemaining - requestedUnits,
    userRemainingAfter: userRemaining - requestedUnits,
  });
}

function rejection(
  source: RejectionSource,
  rule: RejectionRule,
  limit: number,
  requestedUnits: number,
  currentUsage: number,
  remainingMonthly: number,
): RejectedEvaluation {
  const reason =
    rule === 'max_units_per_request'
      ? source === 'user'
        ? REJECTION_REASONS.userMaxPerRequest
        : REJECTION_REASONS.accountMaxPerRequest
      : source === 'user'
        ? REJECTION_REASONS.userMonthly
        : REJECTION_REASONS.accountMonthly;

  return {
    accepted: false,
    reason,
    violation: { source, rule, limit, requestedUnits, currentUsage, remainingMonthly },
  };
}

// ---------------------------------------------------------------------------
// Defensive contracts. These throw (programmer error) rather than returning
// rejection Results: the HTTP layer guarantees positive integers via Zod,
// and a violation of that invariant is a bug to surface loudly, never a
// business decision to serialize to a client.
// ---------------------------------------------------------------------------

function assertPositiveUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      `requestedUnits must be a positive safe integer, received ${value}`,
    );
  }
}

function assertValidRuleSet(label: string, rules: QuotaRuleSet): void {
  if (
    !Number.isSafeInteger(rules.monthlyAllowance) ||
    rules.monthlyAllowance < 0
  ) {
    throw new RangeError(
      `${label}.monthlyAllowance must be a non-negative safe integer, received ${rules.monthlyAllowance}`,
    );
  }
  if (
    !Number.isSafeInteger(rules.maxUnitsPerRequest) ||
    rules.maxUnitsPerRequest <= 0
  ) {
    throw new RangeError(
      `${label}.maxUnitsPerRequest must be a positive safe integer, received ${rules.maxUnitsPerRequest}`,
    );
  }
}

function assertNonNegativeInt(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
}
