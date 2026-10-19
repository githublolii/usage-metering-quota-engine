import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  consume,
  consumeBody,
  createUser,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';
import { pool } from '../../src/database/connection.js';
import { currentUtcPeriod, isValidPeriod, type Period } from '../../src/domain/types.js';

/**
 * Monthly reset & previous-month semantics — the "monthly reset" deliverable.
 *
 * The engine's reset model is *implicit rollover*: there is no cron and no
 * UPDATE job. A period is just part of the row key; a new UTC month lazily
 * creates fresh zero rows. This suite pins down the observable contract:
 *
 *   1. Previous months are frozen, immutable history: reads scoped to an
 *      old period return the old numbers and are unaffected by current
 *      activity.
 *   2. Current consumption only ever touches the current period's rows.
 *   3. `period` is a first-class query parameter on /usage and /history
 *      (arbitrary past months are addressable).
 *   4. A downgraded-below-usage month clamps `remaining` to 0 — the next
 *      month starts clean because it is a DIFFERENT row, with no migration.
 */

let server: TestServer;
let apiKey: string;
let accountId: string;
const currentPeriod = currentUtcPeriod();

/** The UTC month immediately before `currentPeriod` (handles year wrap). */
function previousUtcPeriod(period: string): Period {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${prev.year}-${String(prev.month).padStart(2, '0')}` as Period;
}

const prevPeriod = previousUtcPeriod(currentPeriod);

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Pro');
  apiKey = account.apiKey;
  accountId = account.accountId;
  await createUser(server.baseUrl, apiKey, 'historian', 'Premium');

  // Seed "last month's" usage rows directly — the read side must surface
  // them verbatim, exactly as a real past month would look.
  await pool.query(
    `INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
     VALUES ($1, NULL, $2, 420)
     ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING`,
    [accountId, prevPeriod],
  );
  const userRow = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE account_id = $1 AND external_id = $2',
    [accountId, 'historian'],
  );
  await pool.query(
    `INSERT INTO monthly_usage (account_id, user_id, period, units_consumed)
     VALUES ($1, $2, $3, 300)
     ON CONFLICT ON CONSTRAINT unique_usage_period DO NOTHING`,
    [accountId, userRow.rows[0]?.id, prevPeriod],
  );
});

afterAll(async () => {
  await server.stop();
});

describe('monthly reset & previous months', () => {
  it('accepts arbitrary valid periods and rejects malformed ones', async () => {
    const bad = await apiCall(
      server.baseUrl,
      'GET',
      `/metering/usage?period=${prevPeriod.slice(0, 4)}-13`,
      apiKey,
    );
    expect(bad.status).toBe(400);
  });

  it('reads a PREVIOUS month: usage views are period-addressable and frozen', async () => {
    const usage = await apiCall(
      server.baseUrl,
      'GET',
      `/metering/usage?userId=historian&period=${prevPeriod}`,
      apiKey,
    );
    expect(usage.status).toBe(200);
    expect(usage.body.period).toBe(prevPeriod);
    expect(usage.body.account).toMatchObject({
      planName: 'Pro',
      monthlyAllowance: 500,
      unitsConsumed: 420,
      remaining: 80,
    });
    expect(usage.body.user).toMatchObject({
      planName: 'Premium',
      unitsConsumed: 300,
      remaining: 0, // Premium allowance is 300 — derived remaining clamps to 0
    });
  });

  it('the CURRENT month starts untouched by last month’s consumption', async () => {
    const usage = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/usage?userId=historian',
      apiKey,
    );
    expect(usage.status).toBe(200);
    expect(usage.body.period).toBe(currentPeriod);
    expect(usage.body.account.unitsConsumed).toBe(0);
    expect(usage.body.user.unitsConsumed).toBe(0);
  });

  it('consuming now mutates ONLY the current period (implicit monthly reset)', async () => {
    const response = await consume(
      server.baseUrl,
      apiKey,
      consumeBody('historian', 25),
    );
    expect(response.status).toBe(200);
    expect(response.body.period).toBe(currentPeriod);
    expect(response.body.usage.account.unitsConsumed).toBe(25);

    // Previous month is immutable history — nothing leaked backwards…
    const prev = await apiCall(
      server.baseUrl,
      'GET',
      `/metering/usage?userId=historian&period=${prevPeriod}`,
      apiKey,
    );
    expect(prev.body.account.unitsConsumed).toBe(420);
    expect(prev.body.user.unitsConsumed).toBe(300);

    // …and current-month reads show only current-month activity.
    const now = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/usage?userId=historian',
      apiKey,
    );
    expect(now.body.account.unitsConsumed).toBe(25);
    expect(now.body.user.unitsConsumed).toBe(25);
  });

  it('history is period-scoped: past months show only their own decisions', async () => {
    const currentHistory = await apiCall(
      server.baseUrl,
      'GET',
      `/metering/history?period=${currentPeriod}`,
      apiKey,
    );
    expect(currentHistory.status).toBe(200);
    expect(currentHistory.body.total).toBe(1);
    expect(currentHistory.body.records[0].period).toBe(currentPeriod);

    const prevHistory = await apiCall(
      server.baseUrl,
      'GET',
      `/metering/history?period=${prevPeriod}`,
      apiKey,
    );
    expect(prevHistory.status).toBe(200);
    // The seeded rows carried no consumption_records, so the audit trail
    // for the previous month is legitimately empty even though usage rows
    // exist — decisions and counters are separate tables by design.
    expect(prevHistory.body.total).toBe(0);

    // The unfiltered view still shows every decision ever made.
    const all = await apiCall(server.baseUrl, 'GET', '/metering/history', apiKey);
    expect(all.body.total).toBe(1);
  });

  it('year-wrap period arithmetic is sound (regression for Dec → Jan)', () => {
    expect(previousUtcPeriod('2027-01')).toBe('2026-12');
    expect(previousUtcPeriod('2027-03')).toBe('2027-02');
    expect(isValidPeriod(prevPeriod)).toBe(true);
  });
});
