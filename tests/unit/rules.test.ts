import { describe, expect, it } from 'vitest';
import {
  REJECTION_REASONS,
  evaluateConsumption,
  remainingUnits,
  type EvaluateConsumptionInput,
} from '../../src/domain/rules.js';
import { isErr, isOk } from '../../src/domain/result.js';

/**
 * Exhaustive boundary coverage for the PURE quota evaluator.
 *
 * Every limit is probed at limit-1, exactly-limit, and limit+1 — the only
 * three points where off-by-one bugs can hide. The evaluation order
 * (precedence) and monotonic-counter semantics (downgrades below current
 * usage) are asserted as documented contracts.
 */

const baseInput: EvaluateConsumptionInput = {
  requestedUnits: 5,
  accountPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 50 },
  userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 20 },
  accountUsage: { unitsConsumed: 0 },
  userUsage: { unitsConsumed: 0 },
};

const input = (overrides: Partial<EvaluateConsumptionInput>): EvaluateConsumptionInput => ({
  ...baseInput,
  ...overrides,
});

describe('evaluateConsumption — accepted', () => {
  it('accepts a request well inside every limit', () => {
    const result = evaluateConsumption(baseInput);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value).toEqual({
        accepted: true,
        unitsConsumed: 5,
        newAccountUsage: 5,
        newUserUsage: 5,
        accountRemainingAfter: 95,
        userRemainingAfter: 95,
      });
    }
  });

  it('accepts EXACTLY the user per-request limit (boundary)', () => {
    const result = evaluateConsumption(
      input({ requestedUnits: 20, userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 20 } }),
    );
    expect(isOk(result)).toBe(true);
  });

  it('accepts EXACTLY the account per-request limit (boundary)', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 50,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
      }),
    );
    expect(isOk(result)).toBe(true);
  });

  it('accepts a request equal to the ENTIRE user monthly remaining (boundary)', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 60,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 100 },
        userUsage: { unitsConsumed: 40 },
      }),
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.newUserUsage).toBe(100);
      expect(result.value.userRemainingAfter).toBe(0);
    }
  });

  it('accepts a request equal to the ENTIRE account monthly remaining (boundary)', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 50,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 50 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
        accountUsage: { unitsConsumed: 450 },
      }),
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.newAccountUsage).toBe(500);
      expect(result.value.accountRemainingAfter).toBe(0);
    }
  });

  it('treats zero consumed as a fresh month (remaining == allowance)', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 100,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 100 },
      }),
    );
    expect(isOk(result)).toBe(true);
  });
});

describe('evaluateConsumption — single-rule rejections', () => {
  it('rejects user max_units_per_request at limit + 1', () => {
    const result = evaluateConsumption(input({ requestedUnits: 21 }));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toMatchObject({
        accepted: false,
        reason: REJECTION_REASONS.userMaxPerRequest,
        violation: {
          source: 'user',
          rule: 'max_units_per_request',
          limit: 20,
          requestedUnits: 21,
          currentUsage: 0,
        },
      });
    }
  });

  it('rejects account max_units_per_request when the account limit is the tightest', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 30,
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 25 },
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toMatchObject({
        source: 'account',
        rule: 'max_units_per_request',
        limit: 25,
        requestedUnits: 30,
      });
    }
  });

  it('rejects user monthly_allowance at remaining + 1', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 80,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 100 },
        userUsage: { unitsConsumed: 21 }, // remaining = 79
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toEqual({
        source: 'user',
        rule: 'monthly_allowance',
        limit: 100,
        requestedUnits: 80,
        currentUsage: 21,
        remainingMonthly: 79,
      });
    }
  });

  it('rejects account monthly_allowance when only the shared pool is exhausted', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 10,
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
        accountUsage: { unitsConsumed: 491 }, // remaining = 9
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.reason).toBe(REJECTION_REASONS.accountMonthly);
      expect(result.error.violation).toMatchObject({
        source: 'account',
        rule: 'monthly_allowance',
        limit: 500,
        currentUsage: 491,
      });
    }
  });
});

describe('evaluateConsumption — deterministic precedence', () => {
  it('user max_per_request wins over account monthly_allowance', () => {
    // Violates BOTH: requestedUnits 60 > user max 20 AND > account remaining 10.
    const result = evaluateConsumption(
      input({
        requestedUnits: 60,
        accountPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 50 },
        accountUsage: { unitsConsumed: 90 },
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toMatchObject({
        source: 'user',
        rule: 'max_units_per_request',
      });
    }
  });

  it('account max_per_request wins over user monthly_allowance', () => {
    // Violates BOTH: 40 > account max 25 AND > user remaining 30.
    const result = evaluateConsumption(
      input({
        requestedUnits: 40,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 25 },
        userUsage: { unitsConsumed: 70 },
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toMatchObject({
        source: 'account',
        rule: 'max_units_per_request',
      });
    }
  });

  it('user monthly_allowance wins over account monthly_allowance', () => {
    // Violates BOTH: > user remaining 5 AND > account remaining 3.
    const result = evaluateConsumption(
      input({
        requestedUnits: 10,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        accountPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 100 },
        userUsage: { unitsConsumed: 95 },
        accountUsage: { unitsConsumed: 97 },
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toMatchObject({
        source: 'user',
        rule: 'monthly_allowance',
      });
    }
  });

  it('is pure: identical inputs always yield the identical decision', () => {
    const first = evaluateConsumption(input({ requestedUnits: 21 }));
    const second = evaluateConsumption(input({ requestedUnits: 21 }));
    expect(first).toEqual(second);
  });
});

describe('evaluateConsumption — monotonic counters survive plan downgrades', () => {
  it('usage ABOVE a reduced allowance ⇒ remaining 0 ⇒ any request rejected', () => {
    // User consumed 150; plan downgraded to 100 mid-month. History untouched.
    const result = evaluateConsumption(
      input({
        requestedUnits: 1,
        userPlan: { monthlyAllowance: 100, maxUnitsPerRequest: 20 },
        accountPlan: { monthlyAllowance: 1000, maxUnitsPerRequest: 50 },
        userUsage: { unitsConsumed: 150 },
        accountUsage: { unitsConsumed: 150 },
      }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.violation).toMatchObject({
        source: 'user',
        rule: 'monthly_allowance',
        limit: 100,
        currentUsage: 150,
      });
    }
  });

  it('an upgraded allowance restores capacity without mutating usage', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 50,
        userPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
        accountPlan: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
        userUsage: { unitsConsumed: 150 },
        accountUsage: { unitsConsumed: 150 },
      }),
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.newUserUsage).toBe(200);
      expect(result.value.userRemainingAfter).toBe(300);
    }
  });
});

describe('evaluateConsumption — defensive programmer-error contracts', () => {
  it.each([
    ['zero units', 0],
    ['negative units', -5],
    ['fractional units', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('throws RangeError for %s', (_label, requestedUnits) => {
    expect(() => evaluateConsumption(input({ requestedUnits }))).toThrow(RangeError);
  });

  it('throws RangeError for a malformed plan rule set', () => {
    expect(() =>
      evaluateConsumption(
        input({ accountPlan: { monthlyAllowance: -1, maxUnitsPerRequest: 10 } }),
      ),
    ).toThrow(RangeError);
    expect(() =>
      evaluateConsumption(
        input({ userPlan: { monthlyAllowance: 10, maxUnitsPerRequest: 0 } }),
      ),
    ).toThrow(RangeError);
  });

  it('throws RangeError for negative usage counters (invariant violation)', () => {
    expect(() =>
      evaluateConsumption(input({ userUsage: { unitsConsumed: -1 } })),
    ).toThrow(RangeError);
  });

  it('handles large (1e9-scale) allowances as safe integers', () => {
    const result = evaluateConsumption(
      input({
        requestedUnits: 1_000_000_000,
        userPlan: { monthlyAllowance: 1_000_000_000, maxUnitsPerRequest: 1_000_000_000 },
        accountPlan: { monthlyAllowance: 1_000_000_000, maxUnitsPerRequest: 1_000_000_000 },
      }),
    );
    expect(isOk(result)).toBe(true);
  });
});

describe('remainingUnits — derived remaining budget', () => {
  it.each([
    [100, 0, 100],
    [100, 40, 60],
    [100, 100, 0],
    [100, 150, 0], // downgraded below usage ⇒ clamped to 0, never negative
    [0, 0, 0],
  ])('remainingUnits(%i, %i) === %i', (allowance, consumed, expected) => {
    expect(remainingUnits(allowance, consumed)).toBe(expected);
  });

  it('throws on malformed inputs', () => {
    expect(() => remainingUnits(-1, 0)).toThrow(RangeError);
    expect(() => remainingUnits(10, -1)).toThrow(RangeError);
    expect(() => remainingUnits(1.5, 0)).toThrow(RangeError);
  });
});
