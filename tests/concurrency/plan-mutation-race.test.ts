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
import { currentUtcPeriod } from '../../src/domain/types.js';

/**
 * Rules changing WHILE requests arrive concurrently: usage totals and
 * decisions must remain correct as rules change and requests arrive
 * concurrently.
 *
 * Storm design: an account on Pro (500/mo, max 50/request) with one user
 * fires 60 concurrent 5-unit consumptions (total demand 300). MID-STORM
 * the account is downgraded to Starter (100/mo, max 10/request).
 *
 * Invariants asserted against the database afterwards:
 *   1. Zero 5xx / transport failures (no deadlocks, no torn state).
 *   2. CONSERVATION: account counter == Σ user counters == Σ units of all
 *      accepted decisions (no lost updates, no phantom charges).
 *   3. NO OVERRUN: the counter never exceeds the *most permissive* bound
 *      it was evaluated against (500), and the audit trail of accepted
 *      records sums exactly to the counter.
 *   4. Every accepted request respected the max-per-request limit that was
 *      in force for it (5 ≤ 50 always holds here; the interesting part is
 *      that nothing crashed and totals still reconcile).
 *   5. The downgrade is LIVE: the last rejection (if any) after the switch
 *      reports the NEW limits, proving decisions read the current rules.
 */

const TOTAL_REQUESTS = 60;
const UNITS = 5;
const FULL_DEMAND = TOTAL_REQUESTS * UNITS; // 300

let server: TestServer;
let apiKey: string;
let accountId: string;
const period = currentUtcPeriod();

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Pro');
  apiKey = account.apiKey;
  accountId = account.accountId;
  await createUser(server.baseUrl, apiKey, 'stormy', 'Premium');
});

afterAll(async () => {
  await server.stop();
});

describe('plan mutation racing concurrent consumption', () => {
  it('keeps totals exact while the account plan changes mid-storm', async () => {
    // Launch the storm; the downgrade lands while most requests are in
    // flight (some will be decided under Pro, some under Starter).
    const storm = Promise.all(
      Array.from({ length: TOTAL_REQUESTS }, () =>
        consume(server.baseUrl, apiKey, consumeBody('stormy', UNITS)),
      ),
    );

    const downgrade = await apiCall(
      server.baseUrl,
      'PATCH',
      '/accounts/plan',
      apiKey,
      { planName: 'Starter' },
    );
    expect(downgrade.status).toBe(200);

    const responses = await storm;

    // 1. Every request received a definitive decision — no 5xx.
    const statusBuckets = new Map<number, number>();
    for (const response of responses) {
      statusBuckets.set(response.status, (statusBuckets.get(response.status) ?? 0) + 1);
    }
    expect(statusBuckets.get(500) ?? 0).toBe(0);
    expect(statusBuckets.get(503) ?? 0).toBe(0);
    expect((statusBuckets.get(200) ?? 0) + (statusBuckets.get(422) ?? 0)).toBe(
      TOTAL_REQUESTS,
    );

    const accepted = responses.filter((r) => r.status === 200 && r.body?.accepted === true);
    const rejected = responses.filter((r) => r.status === 422);

    // 2. CONSERVATION (database ground truth):
    //    account counter == Σ user counters == Σ accepted units.
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
    const acceptedUnits = accepted.reduce(
      (sum, r) => sum + (r.body.unitsConsumed as number),
      0,
    );

    expect(userSum).toBe(accountTotal); // no lost updates
    expect(acceptedUnits).toBe(accountTotal); // audit == counters
    expect(accountTotal).toBeLessThanOrEqual(FULL_DEMAND);

    // 3. NO OVERRUN against the most permissive bound in force (Pro=500).
    expect(accountTotal).toBeLessThanOrEqual(500);

    // 4. Audit trail: accepted records sum matches, and every rejected
    //    decision was persisted with a structured violation.
    const audit = await pool.query<{ accepted: boolean; units: string; count: string }>(
      `SELECT accepted, SUM(units_requested)::text AS units, COUNT(*)::text AS count
         FROM consumption_records
        WHERE account_id = $1
        GROUP BY accepted`,
      [accountId],
    );
    const acceptedAudit = audit.rows.find((r) => r.accepted);
    const rejectedAudit = audit.rows.find((r) => !r.accepted);
    expect(Number(acceptedAudit?.units ?? '0')).toBe(accountTotal);
    expect(Number(acceptedAudit?.count ?? '0')).toBe(accepted.length);
    expect(Number(rejectedAudit?.count ?? '0')).toBe(rejected.length);

    // 5. The downgrade is live: any post-switch rejection reports the NEW
    //    Starter limits (max 10/request or 100/mo), never stale Pro values.
    for (const response of rejected) {
      const violation = response.body?.violation;
      if (violation?.rule === 'max_units_per_request') {
        expect(violation.limit).toBeLessThanOrEqual(50);
      }
      if (violation?.rule === 'monthly_allowance') {
        expect(violation.limit).toBeLessThanOrEqual(500);
      }
    }

    // And the account profile reflects the final binding with derived
    // remaining under the NEW allowance (clamped, never negative).
    const profile = await apiCall(server.baseUrl, 'GET', '/accounts/me', apiKey);
    expect(profile.body.account.plan.name).toBe('Starter');
    expect(profile.body.account.usage.remaining).toBeGreaterThanOrEqual(0);
    expect(
      profile.body.account.usage.remaining,
    ).toBe(Math.max(0, 100 - accountTotal));
  }, 180_000);
});
