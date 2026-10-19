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
 * Deadlock-freedom regression: sustained mixed-user concurrency where every
 * transaction acquires the same TWO row locks (account aggregate + user).
 *
 * If ANY transaction ever acquired locks in a different relative order,
 * PostgreSQL would eventually raise SQLSTATE 40P01 (deadlock_detected),
 * which would surface as an HTTP 500 via the error middleware. The test
 * therefore asserts:
 *
 *   - zero 5xx responses across the whole storm,
 *   - the account counter equals the exact sum of its user counters
 *     (no lost updates),
 *   - every user ends exactly at their allowance boundary.
 */

const USERS = ['alpha', 'bravo', 'charlie'] as const;
const REQUESTS_PER_USER = 80;
const UNITS_PER_REQUEST = 1; // each user ends at exactly 80/100

let server: TestServer;
let apiKey: string;
let accountId: string;
const period = currentUtcPeriod();

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Pro'); // 500/mo, max 50/req
  apiKey = account.apiKey;
  accountId = account.accountId;

  for (const user of USERS) {
    await createUser(server.baseUrl, apiKey, user, 'Basic'); // 100/mo, max 20/req
  }
});

afterAll(async () => {
  await server.stop();
});

describe(`deterministic lock ordering under mixed-user load (${USERS.length} users × ${REQUESTS_PER_USER} requests)`, () => {
  it('completes with zero deadlocks, zero lost updates, exact per-user budgets', async () => {
    const storm = USERS.flatMap((user) =>
      Array.from({ length: REQUESTS_PER_USER }, () =>
        consume(server.baseUrl, apiKey, consumeBody(user, UNITS_PER_REQUEST)),
      ),
    );

    const responses = await Promise.all(storm);

    // 1. Every request received a definitive decision — no 5xx, no aborts.
    //    (A single deadlock would appear here as an unexpected status.)
    const statusBuckets = new Map<number, number>();
    for (const response of responses) {
      statusBuckets.set(response.status, (statusBuckets.get(response.status) ?? 0) + 1);
    }
    expect(statusBuckets.get(500) ?? 0).toBe(0);
    expect(statusBuckets.get(503) ?? 0).toBe(0);
    expect(statusBuckets.get(200)).toBe(USERS.length * REQUESTS_PER_USER);

    // 2. Account counter == Σ user counters (lost-update detector).
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

    const accountTotal = accountRow.rows[0]?.units_consumed ?? 0;
    const userSum = userRows.rows.reduce((sum, row) => sum + row.units_consumed, 0);
    expect(accountTotal).toBe(USERS.length * REQUESTS_PER_USER * UNITS_PER_REQUEST);
    expect(userSum).toBe(accountTotal);

    // 3. Each user consumed exactly their own request count (no cross-talk).
    for (const user of USERS) {
      const row = userRows.rows.find((r) => r.external_id === user);
      expect(row?.units_consumed).toBe(REQUESTS_PER_USER);
    }

    // 4. Audit trail: one persisted record per request.
    const audit = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM consumption_records
        WHERE account_id = $1 AND accepted = TRUE`,
      [accountId],
    );
    expect(Number(audit.rows[0]?.count ?? '0')).toBe(USERS.length * REQUESTS_PER_USER);
  }, 180_000);
});
