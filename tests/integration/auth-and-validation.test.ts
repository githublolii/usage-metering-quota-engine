import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';

/**
 * Authentication, API-key lifecycle, and DTO validation semantics.
 *
 * Status-code contract asserted here:
 *   401 problem+json — missing/invalid credentials
 *   400 problem+json — schema violations (with structured `errors`)
 *   404 problem+json — unknown resources / cross-tenant probes
 *   409 problem+json — duplicate resources / wrong plan type
 */

let server: TestServer;
let apiKey: string;

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Starter');
  apiKey = account.apiKey;
});
afterAll(async () => {
  await server.stop();
});

describe('authentication', () => {
  it('401 problem+json when no API key is supplied', async () => {
    const response = await apiCall(server.baseUrl, 'GET', '/accounts/me', null);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 401,
      title: 'Authentication required',
      instance: '/accounts/me',
    });
  });

  it('401 for an invalid (unknown) API key', async () => {
    const response = await apiCall(
      server.baseUrl,
      'GET',
      '/accounts/me',
      'mk_totally_bogus_key',
    );
    expect(response.status).toBe(401);
  });

  it('accepts the key via X-API-Key OR Authorization: Bearer', async () => {
    const header = await fetch(`${server.baseUrl}/accounts/me`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(header.status).toBe(200);

    const bearer = await fetch(`${server.baseUrl}/accounts/me`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(bearer.status).toBe(200);
  });

  it('rejects a "Bearer" header with an empty token', async () => {
    const response = await fetch(`${server.baseUrl}/accounts/me`, {
      headers: { authorization: 'Bearer ' },
    });
    expect(response.status).toBe(401);
  });

  it('protects every metering route', async () => {
    const consume = await apiCall(server.baseUrl, 'POST', '/metering/consume', null, {
      userId: 'x',
      units: 1,
      requestId: randomUUID(),
    });
    expect(consume.status).toBe(401);

    const usage = await apiCall(server.baseUrl, 'GET', '/metering/usage', null);
    expect(usage.status).toBe(401);

    const history = await apiCall(server.baseUrl, 'GET', '/metering/history', null);
    expect(history.status).toBe(401);
  });
});

describe('API key rotation', () => {
  it('invalidates the previous key atomically', async () => {
    const rotation = await apiCall(server.baseUrl, 'POST', '/accounts/rotate-key', apiKey);
    expect(rotation.status).toBe(200);
    const newKey = rotation.body.apiKey as string;
    expect(newKey.startsWith('mk_')).toBe(true);
    expect(newKey).not.toBe(apiKey);

    // Old key dies immediately…
    const old = await apiCall(server.baseUrl, 'GET', '/accounts/me', apiKey);
    expect(old.status).toBe(401);

    // …and the new one is fully functional for the remainder of this suite.
    const fresh = await apiCall(server.baseUrl, 'GET', '/accounts/me', newKey);
    expect(fresh.status).toBe(200);
    apiKey = newKey;
  });
});

describe('request validation (Zod DTOs → 400 problem+json)', () => {
  const invalidConsumeBodies: Array<[string, unknown]> = [
    ['zero units', { userId: 'u', units: 0, requestId: randomUUID() }],
    ['negative units', { userId: 'u', units: -1, requestId: randomUUID() }],
    ['non-integer units', { userId: 'u', units: 2.5, requestId: randomUUID() }],
    ['units as string', { userId: 'u', units: '3', requestId: randomUUID() }],
    ['missing userId', { units: 1, requestId: randomUUID() }],
    ['empty userId', { userId: '   ', units: 1, requestId: randomUUID() }],
    ['non-UUID requestId', { userId: 'u', units: 1, requestId: 'abc' }],
    ['unknown extra field', { userId: 'u', units: 1, requestId: randomUUID(), tenant: 'evil' }],
  ];

  it.each(invalidConsumeBodies)('rejects %s with structured issues', async (label, body) => {
    void label;
    const response = await apiCall(server.baseUrl, 'POST', '/metering/consume', apiKey, body);
    expect(response.status).toBe(400);
    expect(response.body.status).toBe(400);
    expect(Array.isArray(response.body.errors)).toBe(true);
    expect(response.body.errors.length).toBeGreaterThan(0);
  });

  it('rejects a malformed JSON body', async () => {
    const response = await fetch(`${server.baseUrl}/metering/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: '{"userId": "u", ',
    });
    expect(response.status).toBe(400);
    const problem = (await response.json()) as { title: string; status: number };
    expect(problem.status).toBe(400);
    expect(problem.title).toBe('Malformed request body');
  });

  it('rejects invalid query parameters on /metering/usage', async () => {
    const bad = await apiCall(server.baseUrl, 'GET', '/metering/usage?period=2026-13', apiKey);
    expect(bad.status).toBe(400);

    const good = await apiCall(server.baseUrl, 'GET', '/metering/usage?period=2026-10', apiKey);
    expect(good.status).toBe(200);
  });
});

describe('resource semantics (404 / 409)', () => {
  it('404 problem+json for unknown routes', async () => {
    const response = await apiCall(server.baseUrl, 'GET', '/definitely/not/a/route', apiKey);
    expect(response.status).toBe(404);
    expect(response.body.title).toBe('Resource not found');
    expect(response.body.instance).toBe('/definitely/not/a/route');
  });

  it('404 when consuming for a user that does not exist in the tenant', async () => {
    const response = await apiCall(server.baseUrl, 'POST', '/metering/consume', apiKey, {
      userId: 'no-such-user',
      units: 1,
      requestId: randomUUID(),
    });
    expect(response.status).toBe(404);
    expect(response.body.detail).toContain('no-such-user');
  });

  it('404 when creating an account with an unknown predefined plan', async () => {
    const response = await apiCall(server.baseUrl, 'POST', '/accounts', null, {
      name: 'ghost',
      planName: 'DoesNotExist',
    });
    expect(response.status).toBe(404);
  });

  it('409 when registering a duplicate user within the account', async () => {
    const userId = `dup-${randomUUID().slice(0, 8)}`;
    const first = await apiCall(server.baseUrl, 'POST', '/users', apiKey, { userId });
    expect(first.status).toBe(201);

    const second = await apiCall(server.baseUrl, 'POST', '/users', apiKey, { userId });
    expect(second.status).toBe(409);
  });

  it('409 when binding a USER-type plan to an account (or vice versa)', async () => {
    const accountToUserPlan = await apiCall(
      server.baseUrl,
      'PATCH',
      '/accounts/plan',
      apiKey,
      { planId: await planIdOf(server.baseUrl, apiKey, 'Basic') },
    );
    expect(accountToUserPlan.status).toBe(409);

    const userToAccountPlan = await apiCall(server.baseUrl, 'POST', '/users', apiKey, {
      userId: `u-${randomUUID().slice(0, 8)}`,
      planId: await planIdOf(server.baseUrl, apiKey, 'Pro'),
    });
    expect(userToAccountPlan.status).toBe(409);
  });
});

async function planIdOf(baseUrl: string, key: string, name: string): Promise<string> {
  const list = await apiCall(baseUrl, 'GET', '/plans', key);
  const plan = (list.body.plans as Array<{ id: string; name: string }>).find(
    (p) => p.name === name,
  );
  if (plan === undefined) {
    throw new Error(`Predefined plan "${name}" missing — did the seed run?`);
  }
  return plan.id;
}
