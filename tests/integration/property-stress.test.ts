import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  consume,
  consumeBody,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';
import { pool } from '../../src/database/connection.js';
import { currentUtcPeriod } from '../../src/domain/types.js';

/**
 * Randomized end-to-end stress with an INDEPENDENT ORACLE.
 *
 * fast-check generates arbitrary operation streams — consumptions with
 * random unit sizes interleaved with MID-STREAM PLAN DOWNGRADES/UPGRADES —
 * plays them against the LIVE HTTP API, and cross-checks every response
 * (and the final database counters) against a model of the quota contract
 * written directly from the spec, not from the implementation.
 *
 * Invariants that must hold for EVERY generated stream:
 *   1. Every HTTP decision matches the oracle's prediction — decision
 *      (accept/reject), violated rule, source, limit, and current usage.
 *   2. Conservation: DB account counter == Σ user counters == Σ accepted
 *      units (no lost updates, no phantom charges).
 *   3. No overrun: the account counter never exceeds the most permissive
 *      allowance that was ever in force (500, Pro).
 *   4. Downgrade semantics: usage above a reduced allowance simply clamps
 *      remaining to 0 (monotonic counters are never rewritten).
 *
 * Sequential execution keeps the oracle's arithmetic exact; parallel
 * storm behavior is covered by tests/concurrency (deterministic storms)
 * — this suite covers the randomized RULE-CHANGE dimension.
 */

const USERS = ['alpha', 'bravo'] as const;
type UserName = (typeof USERS)[number];

/** Fixed USER plan in this suite: Basic — 100/mo, max 20/request. */
const USER_PLAN = { monthlyAllowance: 100, maxUnitsPerRequest: 20 };

/** The two account plans the stream toggles between. */
const ACCOUNT_PLANS = {
  Pro: { monthlyAllowance: 500, maxUnitsPerRequest: 50 },
  Starter: { monthlyAllowance: 100, maxUnitsPerRequest: 10 },
} as const;
type AccountPlanName = keyof typeof ACCOUNT_PLANS;

interface Operation {
  readonly kind: 'consume' | 'mutate';
  readonly user: UserName;
  readonly units: number;
}

const opArb: fc.Arbitrary<Operation> = fc.record({
  kind: fc.constantFrom('consume' as const, 'mutate' as const),
  user: fc.constantFrom(...USERS),
  units: fc.integer({ min: 1, max: 25 }),
});

let server: TestServer;
const period = currentUtcPeriod();

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
});

/**
 * The oracle: an independent implementation of the documented contract
 * (rules + deterministic precedence), tracking simulated usage as the
 * stream executes.
 */
class Oracle {
  accountUsed = 0;
  readonly userUsed: Record<UserName, number> = { alpha: 0, bravo: 0 };
  private planName: AccountPlanName = 'Pro';

  get plan() {
    return ACCOUNT_PLANS[this.planName];
  }

  togglePlan(): AccountPlanName {
    this.planName = this.planName === 'Pro' ? 'Starter' : 'Pro';
    return this.planName;
  }

  consume(user: UserName, units: number) {
    const accountPlan = this.plan;
    if (units > USER_PLAN.maxUnitsPerRequest) {
      return { accepted: false, source: 'user', rule: 'max_units_per_request', limit: USER_PLAN.maxUnitsPerRequest, currentUsage: this.userUsed[user] } as const;
    }
    if (units > accountPlan.maxUnitsPerRequest) {
      return { accepted: false, source: 'account', rule: 'max_units_per_request', limit: accountPlan.maxUnitsPerRequest, currentUsage: this.accountUsed } as const;
    }
    const userRemaining = Math.max(0, USER_PLAN.monthlyAllowance - this.userUsed[user]);
    if (units > userRemaining) {
      return { accepted: false, source: 'user', rule: 'monthly_allowance', limit: USER_PLAN.monthlyAllowance, currentUsage: this.userUsed[user] } as const;
    }
    const accountRemaining = Math.max(0, accountPlan.monthlyAllowance - this.accountUsed);
    if (units > accountRemaining) {
      return { accepted: false, source: 'account', rule: 'monthly_allowance', limit: accountPlan.monthlyAllowance, currentUsage: this.accountUsed } as const;
    }
    this.accountUsed += units;
    this.userUsed[user] += units;
    return { accepted: true } as const;
  }
}

describe('property: randomized consumption streams with mid-stream plan flips', () => {
  it('every decision matches the independent oracle; DB counters reconcile exactly', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 5, maxLength: 15 }),
        async (stream) => {
          // FULL ISOLATION PER RUN: a fresh account (and its stream users)
          // keeps the oracle's simulated usage and the database in lockstep
          // — accumulated cross-run state would desynchronize predictions.
          const account = await provisionAccount(server.baseUrl, 'Pro');
          const apiKey = account.apiKey;
          const accountId = account.accountId;
          const runUsers: UserName[] = stream
            .map((op) => op.user)
            .filter((user, index, all) => all.indexOf(user) === index);
          for (const user of runUsers) {
            const created = await apiCall(server.baseUrl, 'POST', '/users', apiKey, {
              userId: user,
              planName: 'Basic',
            });
            expect(created.status).toBe(201);
          }

          const oracle = new Oracle();
          let acceptedUnits = 0;

          for (const op of stream) {
            if (op.kind === 'mutate') {
              const target = oracle.togglePlan();
              const response = await apiCall(
                server.baseUrl,
                'PATCH',
                '/accounts/plan',
                apiKey,
                { planName: target },
              );
              expect(response.status).toBe(200);
              continue;
            }

            const expected = oracle.consume(op.user, op.units);
            const response = await consume(
              server.baseUrl,
              apiKey,
              consumeBody(op.user, op.units, randomUUID()),
            );

            if (expected.accepted) {
              expect(
                response.status,
                `oracle predicted ACCEPT for ${op.units} units`,
              ).toBe(200);
              expect(response.body?.accepted).toBe(true);
              acceptedUnits += op.units;
            } else {
              expect(
                response.status,
                `oracle predicted REJECT (${expected.rule})`,
              ).toBe(422);
              expect(response.body?.accepted).toBe(false);
              expect(response.body?.violation?.source).toBe(expected.source);
              expect(response.body?.violation?.rule).toBe(expected.rule);
              expect(response.body?.violation?.limit).toBe(expected.limit);
              expect(response.body?.violation?.currentUsage).toBe(expected.currentUsage);
            }
          }

          // CONSERVATION against database ground truth, per isolated run.
          const accountRow = await pool.query<{ units_consumed: number }>(
            `SELECT units_consumed FROM monthly_usage
              WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
            [accountId, period],
          );
          const userRows = await pool.query<{ external_id: string; units_consumed: number }>(
            `SELECT u.external_id, m.units_consumed
               FROM monthly_usage m JOIN users u ON u.id = m.user_id
              WHERE m.account_id = $1 AND m.period = $2`,
            [accountId, period],
          );

          const dbAccount = accountRow.rows[0]?.units_consumed ?? 0;
          const dbUsersSum = userRows.rows.reduce(
            (sum, row) => sum + row.units_consumed,
            0,
          );

          // 1. Account aggregate == Σ user counters == Σ accepted decisions.
          expect(dbAccount).toBe(oracle.accountUsed);
          expect(dbUsersSum).toBe(oracle.accountUsed);
          expect(acceptedUnits).toBe(oracle.accountUsed);

          // 2. NO OVERRUN: never above the most permissive allowance in force.
          expect(dbAccount).toBeLessThanOrEqual(500);

          // 3. Per-user budgets respected; usage matches the oracle exactly.
          for (const row of userRows.rows) {
            const oracleUser = oracle.userUsed[row.external_id as UserName];
            expect(row.units_consumed).toBe(oracleUser);
            expect(row.units_consumed).toBeLessThanOrEqual(USER_PLAN.monthlyAllowance);
          }
        },
      ),
      { numRuns: 12 },
    );
  }, 180_000);
});
