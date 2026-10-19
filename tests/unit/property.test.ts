import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  evaluateConsumption,
  remainingUnits,
  type EvaluateConsumptionInput,
} from '../../src/domain/rules.js';
import { isErr, isOk } from '../../src/domain/result.js';
import { currentUtcPeriod, isValidPeriod } from '../../src/domain/types.js';

/**
 * Property-based (fuzzed) verification of the PURE quota evaluator.
 *
 * Instead of a handful of hardcoded cases, fast-check generates thousands
 * of pseudo-random inputs and asserts that mathematical invariants NEVER
 * break. Two properties go further than testing the implementation against
 * itself: they cross-check it against an INDEPENDENTLY WRITTEN model —
 * a second implementation of the documented rule/precedence contract.
 * If the two ever disagree, one of them is wrong and the test fails.
 *
 * All properties here are 100% in-memory (zero I/O) — the evaluator is
 * pure, so this is both legal and fast (numRuns in the hundreds).
 */

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const planArb = fc.record({
  monthlyAllowance: fc.integer({ min: 0, max: 10_000 }),
  maxUnitsPerRequest: fc.integer({ min: 1, max: 500 }),
});

const usageArb = fc.record({
  unitsConsumed: fc.integer({ min: 0, max: 10_000 }),
});

const inputArb: fc.Arbitrary<EvaluateConsumptionInput> = fc.record({
  requestedUnits: fc.integer({ min: 1, max: 1_000 }),
  accountPlan: planArb,
  userPlan: planArb,
  accountUsage: usageArb,
  userUsage: usageArb,
});

/**
 * Independent model of the documented contract (rules + precedence):
 *   1. user.max_units_per_request
 *   2. account.max_units_per_request
 *   3. user.monthly_allowance
 *   4. account.monthly_allowance
 * Written from the documented contract, not from the implementation, on purpose.
 */
function modelEvaluate(input: EvaluateConsumptionInput) {
  const { requestedUnits, accountPlan, userPlan, accountUsage, userUsage } =
    input;

  if (requestedUnits > userPlan.maxUnitsPerRequest) {
    return { source: 'user', rule: 'max_units_per_request', limit: userPlan.maxUnitsPerRequest } as const;
  }
  if (requestedUnits > accountPlan.maxUnitsPerRequest) {
    return { source: 'account', rule: 'max_units_per_request', limit: accountPlan.maxUnitsPerRequest } as const;
  }
  const userRemaining = Math.max(0, userPlan.monthlyAllowance - userUsage.unitsConsumed);
  if (requestedUnits > userRemaining) {
    return { source: 'user', rule: 'monthly_allowance', limit: userPlan.monthlyAllowance } as const;
  }
  const accountRemaining = Math.max(0, accountPlan.monthlyAllowance - accountUsage.unitsConsumed);
  if (requestedUnits > accountRemaining) {
    return { source: 'account', rule: 'monthly_allowance', limit: accountPlan.monthlyAllowance } as const;
  }
  return { accepted: true } as const;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('property: evaluator matches the independent model (fuzzed)', () => {
  it('agrees with the model on the decision AND the violated rule, for arbitrary inputs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = evaluateConsumption(input);
        const model = modelEvaluate(input);

        if ('accepted' in model) {
          expect(isOk(result)).toBe(true);
          return;
        }

        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error.violation.source).toBe(model.source);
          expect(result.error.violation.rule).toBe(model.rule);
          expect(result.error.violation.limit).toBe(model.limit);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('property: acceptance invariants (fuzzed)', () => {
  it('accepted ⇒ usage math is exact and remaining never goes negative', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = evaluateConsumption(input);
        if (!isOk(result)) return; // rejections covered by other properties

        const value = result.value;
        expect(value.newAccountUsage).toBe(
          input.accountUsage.unitsConsumed + input.requestedUnits,
        );
        expect(value.newUserUsage).toBe(
          input.userUsage.unitsConsumed + input.requestedUnits,
        );
        expect(value.accountRemainingAfter).toBeGreaterThanOrEqual(0);
        expect(value.userRemainingAfter).toBeGreaterThanOrEqual(0);

        // An accepted request necessarily satisfied ALL four rules.
        expect(input.requestedUnits).toBeLessThanOrEqual(input.userPlan.maxUnitsPerRequest);
        expect(input.requestedUnits).toBeLessThanOrEqual(input.accountPlan.maxUnitsPerRequest);
        expect(input.requestedUnits).toBeLessThanOrEqual(
          Math.max(0, input.userPlan.monthlyAllowance - input.userUsage.unitsConsumed),
        );
        expect(input.requestedUnits).toBeLessThanOrEqual(
          Math.max(0, input.accountPlan.monthlyAllowance - input.accountUsage.unitsConsumed),
        );
      }),
      { numRuns: 1000 },
    );
  });

  it('rejected ⇒ violation fields are self-consistent and remainingMonthly ≥ 0', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const result = evaluateConsumption(input);
        if (!isErr(result)) return;

        const { violation } = result.error;
        expect(violation.remainingMonthly).toBeGreaterThanOrEqual(0);
        expect(violation.requestedUnits).toBe(input.requestedUnits);

        if (violation.rule === 'max_units_per_request') {
          expect(violation.requestedUnits).toBeGreaterThan(violation.limit);
        } else {
          // Monthly: the request exceeded the DERIVED remaining budget…
          expect(violation.requestedUnits).toBeGreaterThan(violation.remainingMonthly);
          // …and remaining is exactly allowance − usage, clamped at 0.
          const usage =
            violation.source === 'user'
              ? input.userUsage.unitsConsumed
              : input.accountUsage.unitsConsumed;
          expect(violation.remainingMonthly).toBe(
            Math.max(0, violation.limit - usage),
          );
          expect(violation.currentUsage).toBe(usage);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('is deterministic: identical inputs always produce the identical decision', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(evaluateConsumption(input)).toEqual(evaluateConsumption(input));
      }),
      { numRuns: 300 },
    );
  });
});

describe('property: conservation under randomized request streams (pure simulation)', () => {
  it('account total == user total == Σ accepted units; budgets never exceeded', () => {
    fc.assert(
      fc.property(
        planArb,
        planArb,
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 60 }),
        (accountPlan, userPlan, stream) => {
          let accountUsed = 0;
          let userUsed = 0;
          let acceptedUnits = 0;

          for (const units of stream) {
            const result = evaluateConsumption({
              requestedUnits: units,
              accountPlan,
              userPlan,
              accountUsage: { unitsConsumed: accountUsed },
              userUsage: { unitsConsumed: userUsed },
            });
            if (isOk(result)) {
              accountUsed = result.value.newAccountUsage;
              userUsed = result.value.newUserUsage;
              acceptedUnits += units;
            }
          }

          // Conservation: the account aggregate is exactly the user total,
          // which is exactly the sum of accepted decisions.
          expect(accountUsed).toBe(userUsed);
          expect(accountUsed).toBe(acceptedUnits);
          // Budgets (with the most permissive allowance ever in force here)
          // were never exceeded — zero over-consumption, by construction.
          expect(accountUsed).toBeLessThanOrEqual(accountPlan.monthlyAllowance);
          expect(userUsed).toBeLessThanOrEqual(userPlan.monthlyAllowance);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property: UTC period math (fuzzed)', () => {
  it('any instant maps to exactly one syntactically valid YYYY-MM (its UTC month)', () => {
    // Epoch-ms arbitrary (not fc.date): guarantees a VALID Date object —
    // fc.date can surface invalid dates, which currentUtcPeriod does not
    // accept by contract.
    const instantArb = fc
      .integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2199, 11, 31) })
      .map((ms) => new Date(ms));
    fc.assert(
      fc.property(
        instantArb,
        (date) => {
          const period = currentUtcPeriod(date);
          const expected = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
          expect(period).toBe(expected);
          expect(isValidPeriod(period)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('remainingUnits never returns a negative budget, whatever the inputs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (allowance, consumed) => {
          expect(remainingUnits(allowance, consumed)).toBe(
            Math.max(0, allowance - consumed),
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
