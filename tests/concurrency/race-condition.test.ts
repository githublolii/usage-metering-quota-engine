import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  consumeBody,
  createUser,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';
import { pool } from '../../src/database/connection.js';
import { currentUtcPeriod } from '../../src/domain/types.js';

/**
 * THE race-condition regression (spec §6, automated for CI).
 *
 * Setup: Starter account (100 units/month, max 10/request). A `drainer`
 * user consumes exactly 50 units up front, leaving 50 units. Then 250
 * concurrent requests each attempt to consume 1 unit.
 *
 * Mathematical invariant (not probabilistic):
 *   accepted + rejected = 250
 *   accepted = 50                       (exactly the remaining budget)
 *   account units_consumed = 100         (50 pre-drained + 50 raced)
 *   user 'racer' units_consumed = 50     (raced units land on one user)
 *
 * Any lost update, double-spend, or over-consumption breaks these
 * equations. The database is the source of truth for every assertion.
 */

const CONCURRENT_REQUESTS = 250;
const REMAINING_UNITS = 50;

let server: TestServer;
let apiKey: string;
let accountId: string;
const period = currentUtcPeriod();

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Starter');
  apiKey = account.apiKey;
  accountId = account.accountId;

  await createUser(server.baseUrl, apiKey, 'drainer', 'Basic');
  await createUser(server.baseUrl, apiKey, 'racer', 'Premium');

  // Pre-drain exactly 50 units (5 × 10 — within Starter's per-request max).
  for (let i = 0; i < REMAINING_UNITS / 10; i += 1) {
    const response = await consume(server.baseUrl, apiKey, consumeBody('drainer', 10));
    if (response.status !== 200) {
      throw new Error(`pre-drain request ${i} failed with HTTP ${response.status}`);
    }
  }
});

afterAll(async () => {
  await server.stop();
});

async function dbUnits(userId: string | null): Promise<number> {
  if (userId === null) {
    const result = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    return result.rows[0]?.units_consumed ?? 0;
  }
  const result = await pool.query<{ units_consumed: number }>(
    `SELECT m.units_consumed
       FROM monthly_usage m JOIN users u ON u.id = m.user_id
      WHERE m.account_id = $1 AND u.external_id = $2 AND m.period = $3`,
    [accountId, userId, period],
  );
  return result.rows[0]?.units_consumed ?? 0;
}

describe(`quota overrun race — ${CONCURRENT_REQUESTS} concurrent requests into ${REMAINING_UNITS} remaining units`, () => {
  it('consumes exactly the remaining budget: zero overruns, clean rejections, intact audit', async () => {
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        consume(server.baseUrl, apiKey, consumeBody('racer', 1)),
      ),
    );

    const accepted = responses.filter((r) => r.status === 200 && r.body?.accepted === true);
    const rejected = responses.filter(
      (r) =>
        r.status === 422 &&
        r.body?.violation?.source === 'account' &&
        r.body?.violation?.rule === 'monthly_allowance',
    );
    const unexpected = responses.filter(
      (r) => r.status !== 200 && r.status !== 422,
    );

    // 1. No transport-level or 5xx failures (a deadlock would surface here).
    expect(unexpected, 'every request must yield a 2xx/4xx decision').toHaveLength(0);

    // 2. Exactly the remaining budget was consumed — no more, no less.
    expect(accepted).toHaveLength(REMAINING_UNITS);

    // 3. Every loser received a structured account-monthly rejection.
    expect(rejected).toHaveLength(CONCURRENT_REQUESTS - REMAINING_UNITS);

    // 4. Rejections that arrived AFTER exhaustion report the full counter.
    const exhaustedRejections = rejected.filter(
      (r) => r.body.violation.currentUsage === 100,
    );
    expect(exhaustedRejections.length).toBeGreaterThan(0);

    // 5. Database ground truth: monotonic counters, exactly 100 total.
    expect(await dbUnits(null)).toBe(100);
    expect(await dbUnits('drainer')).toBe(50);
    expect(await dbUnits('racer')).toBe(50);

    // 6. Every decision (accepted AND rejected) is persisted exactly once.
    const audit = await pool.query<{ accepted: boolean; count: string }>(
      `SELECT accepted, COUNT(*)::text AS count
         FROM consumption_records WHERE account_id = $1 GROUP BY accepted`,
      [accountId],
    );
    const acceptedRecords = Number(audit.rows.find((r) => r.accepted)?.count ?? '0');
    const rejectedRecords = Number(
      audit.rows.find((r) => r.accepted === false)?.count ?? '0',
    );
    expect(acceptedRecords).toBe(55); // 5 pre-drain + 50 raced
    expect(rejectedRecords).toBe(CONCURRENT_REQUESTS - REMAINING_UNITS);

    // 7. The highest account snapshot any winner observed equals the
    //    committed database total (no phantom increments).
    const maxAccountSeen = Math.max(
      ...accepted.map((r) => r.body.usage.account.unitsConsumed as number),
    );
    expect(maxAccountSeen).toBe(100);
  }, 120_000);
});
