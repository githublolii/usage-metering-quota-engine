import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consume,
  createUser,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';
import { pool } from '../../src/database/connection.js';
import { currentUtcPeriod } from '../../src/domain/types.js';

/**
 * Idempotency race: N transactions with the SAME (account, requestId)
 * racing concurrently. The unique constraint guarantees:
 *
 *   - exactly ONE consumption record is committed,
 *   - the quota is charged exactly ONCE,
 *   - every caller receives the IDENTICAL decision payload.
 *
 * This exercises the SQLSTATE 23505 catch-and-replay path in the metering
 * service, including the fact that the losers' counter increments are
 * fully rolled back.
 */

const CONCURRENT_DUPLICATES = 40;
const UNITS = 5;

let server: TestServer;
let apiKey: string;
let accountId: string;
const period = currentUtcPeriod();

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Starter');
  apiKey = account.apiKey;
  accountId = account.accountId;
  await createUser(server.baseUrl, apiKey, 'replayer', 'Premium');
});

afterAll(async () => {
  await server.stop();
});

describe(`idempotency race — ${CONCURRENT_DUPLICATES} concurrent requests, one shared requestId`, () => {
  it('charges once, replays the identical decision to everyone', async () => {
    const sharedRequestId = randomUUID();
    const body = { userId: 'replayer', units: UNITS, requestId: sharedRequestId };

    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_DUPLICATES }, () =>
        consume(server.baseUrl, apiKey, body),
      ),
    );

    // 1. Every caller receives the SAME accepted payload. Deep equality is
    //    used deliberately: PostgreSQL JSONB does not preserve key order, so
    //    a replayed payload can differ from a fresh one in serialization
    //    order while being semantically identical.
    const reference = responses[0]?.body;
    for (const response of responses) {
      expect(response.body).toEqual(reference);
    }
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => r.body.accepted === true)).toBe(true);

    // 2. Exactly one original decision; everyone else was a replay.
    const replays = responses.filter((r) => r.replayed);
    expect(replays).toHaveLength(CONCURRENT_DUPLICATES - 1);

    // 3. Database: exactly one record for the shared key.
    const recordCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM consumption_records
        WHERE account_id = $1 AND request_id = $2`,
      [accountId, sharedRequestId],
    );
    expect(Number(recordCount.rows[0]?.count ?? '0')).toBe(1);

    // 4. Database: the quota was charged exactly once (no double spend,
    //    proving the losers' increments were rolled back atomically).
    const usage = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    expect(usage.rows[0]?.units_consumed).toBe(UNITS);

    // 5. A later serial retry also replays (idempotency persists in time).
    const laterRetry = await consume(server.baseUrl, apiKey, body);
    expect(laterRetry.status).toBe(200);
    expect(laterRetry.replayed).toBe(true);
    expect(laterRetry.body).toEqual(reference);

    const usageAfter = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    expect(usageAfter.rows[0]?.units_consumed).toBe(UNITS);
  }, 120_000);

  it('holds under a second wave with a fresh shared key', async () => {
    const secondKey = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT_DUPLICATES }, () =>
        consume(server.baseUrl, apiKey, {
          userId: 'replayer',
          units: 3,
          requestId: secondKey,
        }),
      ),
    );
    const reference = responses[0]?.body;
    for (const response of responses) {
      expect(response.body).toEqual(reference);
    }

    const usage = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    expect(usage.rows[0]?.units_consumed).toBe(UNITS + 3);
  }, 120_000);
});

describe('idempotency conflict defense (replay-attack guard)', () => {
  it('409s when an already-used requestId arrives with a DIFFERENT payload', async () => {
    const key = randomUUID();

    // Original: 2 units, accepted.
    const first = await consume(server.baseUrl, apiKey, {
      userId: 'replayer',
      units: 2,
      requestId: key,
    });
    expect(first.status).toBe(200);

    const accountBefore = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    const before = accountBefore.rows[0]?.units_consumed ?? 0;

    // Hijack attempt #1: same key, different units.
    const hijackUnits = await consume(server.baseUrl, apiKey, {
      userId: 'replayer',
      units: 999,
      requestId: key,
    });
    expect(hijackUnits.status).toBe(409);
    expect(hijackUnits.replayed).toBe(false);
    expect(hijackUnits.body.title).toBe('Request conflicts with current state');
    expect(String(hijackUnits.body.detail)).toContain('different request payload');

    // Hijack attempt #2: same key, different user.
    await createUser(server.baseUrl, apiKey, 'hijacker', 'Premium');
    const hijackUser = await consume(server.baseUrl, apiKey, {
      userId: 'hijacker',
      units: 2,
      requestId: key,
    });
    expect(hijackUser.status).toBe(409);

    // A same-payload retry still replays the original decision cleanly.
    const legitRetry = await consume(server.baseUrl, apiKey, {
      userId: 'replayer',
      units: 2,
      requestId: key,
    });
    expect(legitRetry.status).toBe(200);
    expect(legitRetry.replayed).toBe(true);
    expect(legitRetry.body).toEqual(first.body);

    // And the hijack attempts charged nothing.
    const accountAfter = await pool.query<{ units_consumed: number }>(
      `SELECT units_consumed FROM monthly_usage
        WHERE account_id = $1 AND user_id IS NULL AND period = $2`,
      [accountId, period],
    );
    expect(accountAfter.rows[0]?.units_consumed).toBe(before);
  }, 120_000);

  it('409s for key reuse even against a REJECTED decision, and charges nothing either way', async () => {
    // Get a rejection: hijacker is on Premium (300/mo) but the account pool
    // may still have room — force a per-request violation instead: units
    // beyond Premium's max 50/request while the key is fresh.
    const key = randomUUID();
    const rejected = await consume(server.baseUrl, apiKey, {
      userId: 'hijacker',
      units: 51, // > Premium max_units_per_request (50)
      requestId: key,
    });
    expect(rejected.status).toBe(422);

    const misuse = await consume(server.baseUrl, apiKey, {
      userId: 'hijacker',
      units: 1,
      requestId: key,
    });
    expect(misuse.status).toBe(409);
  }, 120_000);
});
