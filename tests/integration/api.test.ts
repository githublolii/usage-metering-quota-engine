import { randomUUID } from 'node:crypto';
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

/**
 * End-to-end API lifecycle — the acceptance-test mirror of the demo
 * script's six phases, plus the audit/usage read side and mid-month plan
 * mutation. Asserts exact response shapes, status-code semantics, and
 * database-consistent usage numbers throughout.
 */

let server: TestServer;
let apiKey: string;
let accountId: string;
/** Captured in the first accepted consume; replayed in the idempotency test. */
let firstAcceptedBody: { userId: string; units: number; requestId: string } | null = null;

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Starter');
  apiKey = account.apiKey;
  accountId = account.accountId;
});

afterAll(async () => {
  await server.stop();
});

describe('account & user provisioning', () => {
  it('exposes the plaintext API key exactly once', async () => {
    const response = await apiCall(server.baseUrl, 'GET', '/accounts/me', apiKey);
    expect(response.status).toBe(200);
    expect(response.body.account.plan.name).toBe('Starter');
    expect(JSON.stringify(response.body)).not.toContain('mk_');
  });

  it('rejects an account plan binding to a USER-type plan', async () => {
    const response = await apiCall(server.baseUrl, 'PATCH', '/accounts/plan', apiKey, {
      planName: 'Basic',
    });
    expect(response.status).toBe(409);
  });

  it('registers users with distinct plans', async () => {
    await createUser(server.baseUrl, apiKey, 'user-1', 'Basic');
    await createUser(server.baseUrl, apiKey, 'user-2', 'Premium');
    const list = await apiCall(server.baseUrl, 'GET', '/users', apiKey);
    expect(list.status).toBe(200);
    const ids = list.body.users.map((u: { userId: string }) => u.userId);
    expect(ids).toContain('user-1');
    expect(ids).toContain('user-2');
  });
});

describe('consume — the dual-quota decision', () => {
  it('accepts a request and reports both plan views', async () => {
    const body = consumeBody('user-1', 10);
    const response = await consume(server.baseUrl, apiKey, body);
    firstAcceptedBody = body;

    expect(response.status).toBe(200);
    expect(response.replayed).toBe(false);
    expect(response.body).toMatchObject({
      accepted: true,
      requestId: body.requestId,
      usage: {
        account: {
          planName: 'Starter',
          monthlyAllowance: 100,
          maxUnitsPerRequest: 10,
          unitsConsumed: 10,
          remaining: 90,
        },
        user: {
          planName: 'Basic',
          monthlyAllowance: 100,
          maxUnitsPerRequest: 20,
          unitsConsumed: 10,
          remaining: 90,
        },
      },
    });
  });

  it('rejects by USER max_units_per_request with a structured violation (HTTP 422)', async () => {
    const response = await consume(
      server.baseUrl,
      apiKey,
      consumeBody('user-1', 25),
    );
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      accepted: false,
      reason: 'Request exceeds user maximum units per request limit.',
      violation: {
        source: 'user',
        rule: 'max_units_per_request',
        limit: 20,
        requestedUnits: 25,
        currentUsage: 10,
      },
    });
  });

  it('rejects by ACCOUNT max_units_per_request (account plan is the tightest)', async () => {
    const response = await consume(
      server.baseUrl,
      apiKey,
      consumeBody('user-1', 11),
    );
    expect(response.status).toBe(422);
    expect(response.body.violation).toMatchObject({
      source: 'account',
      rule: 'max_units_per_request',
      limit: 10,
      requestedUnits: 11,
    });
  });

  it('rejects by USER monthly_allowance for a user on a tiny custom plan', async () => {
    // Custom plan exercises the plans module AND the user-monthly rule.
    const plan = await apiCall(server.baseUrl, 'POST', '/plans', apiKey, {
      name: 'Featherweight',
      type: 'USER',
      monthlyAllowance: 15,
      maxUnitsPerRequest: 10,
    });
    expect(plan.status).toBe(201);

    const user = await apiCall(server.baseUrl, 'POST', '/users', apiKey, {
      userId: 'light-user',
      planName: 'Featherweight',
    });
    expect(user.status).toBe(201);

    const first = await consume(server.baseUrl, apiKey, consumeBody('light-user', 10));
    expect(first.status).toBe(200);

    const second = await consume(server.baseUrl, apiKey, consumeBody('light-user', 6));
    expect(second.status).toBe(422);
    expect(second.body.violation).toEqual({
      source: 'user',
      rule: 'monthly_allowance',
      limit: 15,
      requestedUnits: 6,
      currentUsage: 10,
      remainingMonthly: 5,
    });
  });

  it('accepts at the exact account boundary then rejects by ACCOUNT monthly_allowance', async () => {
    // Account state here: 20 units (user-1: 10, light-user: 10).
    // user-1 drains 7 × 10 (account 20 → 90, user-1 90/100).
    for (let i = 0; i < 7; i += 1) {
      const response = await consume(server.baseUrl, apiKey, consumeBody('user-1', 10));
      expect(response.status).toBe(200);
    }
    // user-2 takes the account to exactly 100/100 — the exact boundary.
    const boundary = await consume(server.baseUrl, apiKey, consumeBody('user-2', 10));
    expect(boundary.status).toBe(200);
    expect(boundary.body.usage.account.unitsConsumed).toBe(100);
    expect(boundary.body.usage.account.remaining).toBe(0);

    // Any further request on the shared pool is an account-level violation.
    const over = await consume(server.baseUrl, apiKey, consumeBody('user-2', 1));
    expect(over.status).toBe(422);
    expect(over.body.violation).toEqual({
      source: 'account',
      rule: 'monthly_allowance',
      limit: 100,
      requestedUnits: 1,
      currentUsage: 100,
      remainingMonthly: 0,
    });
  });

  it('is idempotent: replaying an accepted requestId returns the identical payload without re-charging', async () => {
    const original = firstAcceptedBody!;
    const replay = await consume(server.baseUrl, apiKey, original);

    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe(true);
    expect(replay.body.requestId).toBe(original.requestId);
    // Stored payload shows the state AT DECISION TIME (10/100), not the
    // current state (90/100) — the decision is an immutable fact.
    expect(replay.body.usage.account.unitsConsumed).toBe(10);

    const usage = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/usage?userId=user-1',
      apiKey,
    );
    expect(usage.body.user.unitsConsumed).toBe(80); // unchanged by the replay
  });

  it('is idempotent for REJECTED decisions too: replays return the same 422', async () => {
    const rejectedBody = consumeBody('user-2', 1); // account exhausted above
    const first = await consume(server.baseUrl, apiKey, rejectedBody);
    expect(first.status).toBe(422);

    const replay = await consume(server.baseUrl, apiKey, rejectedBody);
    expect(replay.status).toBe(422);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
  });
});

describe('runtime plan mutation (no restart)', () => {
  it('upgrades the account plan and PRESERVES monotonic usage', async () => {
    const upgrade = await apiCall(server.baseUrl, 'PATCH', '/accounts/plan', apiKey, {
      planName: 'Pro',
    });
    expect(upgrade.status).toBe(200);
    expect(upgrade.body.account.plan.name).toBe('Pro');

    const profile = await apiCall(server.baseUrl, 'GET', '/accounts/me', apiKey);
    expect(profile.body.account.plan.monthlyAllowance).toBe(500);
    expect(profile.body.account.usage.unitsConsumed).toBe(100);
    expect(profile.body.account.usage.remaining).toBe(400);
  });

  it('lets a previously-rejected request pass immediately after the upgrade', async () => {
    const retry = await consume(server.baseUrl, apiKey, consumeBody('user-2', 1));
    expect(retry.status).toBe(200);
    expect(retry.body.usage.account).toMatchObject({
      unitsConsumed: 101,
      remaining: 399,
    });
  });

  it('binds a custom ACCOUNT plan usable only by its owner', async () => {
    const created = await apiCall(server.baseUrl, 'POST', '/plans', apiKey, {
      name: 'Enterprise',
      type: 'ACCOUNT',
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
    });
    expect(created.status).toBe(201);

    const duplicate = await apiCall(server.baseUrl, 'POST', '/plans', apiKey, {
      name: 'Enterprise',
      type: 'ACCOUNT',
      monthlyAllowance: 10_000,
      maxUnitsPerRequest: 100,
    });
    expect(duplicate.status).toBe(409);

    // Cross-tenant IDOR probe: another account may NOT bind this plan id.
    const stranger = await provisionAccount(server.baseUrl, 'Starter');
    const stolen = await apiCall(
      server.baseUrl,
      'PATCH',
      '/accounts/plan',
      stranger.apiKey,
      { planId: created.body.plan.id },
    );
    expect(stolen.status).toBe(404);

    // Owner rebinds and consumes 50 units in one request (max 100).
    const rebind = await apiCall(server.baseUrl, 'PATCH', '/accounts/plan', apiKey, {
      planId: created.body.plan.id,
    });
    expect(rebind.status).toBe(200);

    const big = await consume(server.baseUrl, apiKey, consumeBody('user-2', 50));
    expect(big.status).toBe(200);
    expect(big.body.usage.account.monthlyAllowance).toBe(10_000);
    expect(big.body.usage.account.maxUnitsPerRequest).toBe(100);
  });
});

describe('read side — usage and history', () => {
  it('GET /metering/usage reports account + user views', async () => {
    const usage = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/usage?userId=user-2',
      apiKey,
    );
    expect(usage.status).toBe(200);
    expect(usage.body.account.planName).toBe('Enterprise');
    expect(usage.body.user.planName).toBe('Premium');
    // user-2's accepted consumptions: 10 (boundary) + 1 (post-upgrade) + 50 (Enterprise)
    expect(usage.body.user.unitsConsumed).toBe(61);
  });

  it('GET /metering/history returns the persisted audit trail', async () => {
    const history = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/history?userId=user-2&limit=200',
      apiKey,
    );
    expect(history.status).toBe(200);
    expect(history.body.total).toBeGreaterThanOrEqual(4);

    const records: Array<Record<string, any>> = history.body.records;
    const rejectedRecord = records.find((r) => r.accepted === false);
    expect(rejectedRecord).toBeDefined();
    expect(rejectedRecord!.rejectionSource).toBe('account');
    expect(rejectedRecord!.rejectionRule).toBe('monthly_allowance');
    expect(rejectedRecord!.rejectionReason).toContain('account');
    expect(rejectedRecord!.response.accepted).toBe(false);
    expect(rejectedRecord!.response.violation.currentUsage).toBe(100);
  });

  it('history pagination is honored', async () => {
    const page = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/history?limit=2&offset=0',
      apiKey,
    );
    expect(page.body.records).toHaveLength(2);
    expect(page.body.limit).toBe(2);
    expect(page.body.total).toBeGreaterThan(2);
  });
});

describe('tenant isolation (IDOR hardening)', () => {
  it('never resolves another tenant\'s user, plans, or usage', async () => {
    const stranger = await provisionAccount(server.baseUrl, 'Starter');
    await createUser(server.baseUrl, stranger.apiKey, 'user-1', 'Basic');

    // 1. Consume referencing a user that exists ONLY in the other tenant.
    const response = await apiCall(
      server.baseUrl,
      'POST',
      '/metering/consume',
      stranger.apiKey,
      { userId: 'user-2', units: 1, requestId: randomUUID() }, // exists only in tenant A
    );
    expect(response.status).toBe(404);

    // 2. Usage lookup for a foreign user.
    const usage = await apiCall(
      server.baseUrl,
      'GET',
      '/metering/usage?userId=user-2',
      stranger.apiKey,
    );
    expect(usage.status).toBe(404);

    // 3. History listing is scoped to the caller's own account (empty).
    const history = await apiCall(server.baseUrl, 'GET', '/metering/history', stranger.apiKey);
    expect(history.status).toBe(200);
    expect(history.body.total).toBe(0);

    // 4. The stranger CANNOT see tenant A's records by counting.
    expect(stranger.accountId).not.toBe(accountId);
  });
});
