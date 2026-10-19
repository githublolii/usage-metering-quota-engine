import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  apiCall,
  provisionAccount,
  startTestServer,
  type TestServer,
} from '../helpers/test-server.js';

/**
 * Custom-plan CRUD — the full lifecycle of a tenant-scoped plan:
 *
 *   Create → Read → Update (name, limits; 409 on duplicate name;
 *   404 on foreign/predefined plans) → Delete (409 while bound,
 *   200 once unbound via PATCH /users/:userId/plan or PATCH /accounts/plan).
 *
 * Ownership rules under test (the IDOR core):
 *   - another tenant may not update or delete this account's plans (404)
 *   - predefined catalog plans are immutable through these routes (404)
 */

let server: TestServer;
let apiKey: string;
/** A second tenant, used for cross-tenant probes. */
let strangerKey: string;

beforeAll(async () => {
  server = await startTestServer();
  const account = await provisionAccount(server.baseUrl, 'Starter');
  apiKey = account.apiKey;
  const stranger = await provisionAccount(server.baseUrl, 'Starter');
  strangerKey = stranger.apiKey;
});

afterAll(async () => {
  await server.stop();
});

async function createGoldPlan(overrides: Record<string, unknown> = {}) {
  return apiCall(server.baseUrl, 'POST', '/plans', apiKey, {
    name: 'Gold',
    type: 'USER',
    monthlyAllowance: 200,
    maxUnitsPerRequest: 40,
    ...overrides,
  });
}

describe('custom plan CRUD', () => {
  it('CREATE → READ: appears in the tenant-scoped catalog', async () => {
    const created = await createGoldPlan();
    expect(created.status).toBe(201);
    expect(created.body.plan).toMatchObject({
      name: 'Gold',
      type: 'USER',
      isPredefined: false,
      monthlyAllowance: 200,
      maxUnitsPerRequest: 40,
    });

    const list = await apiCall(server.baseUrl, 'GET', '/plans', apiKey);
    const names = (list.body.plans as Array<{ name: string }>).map((p) => p.name);
    expect(names).toContain('Gold');
    // The stranger's catalog must NOT contain this private plan.
    const strangerList = await apiCall(server.baseUrl, 'GET', '/plans', strangerKey);
    const strangerNames = (strangerList.body.plans as Array<{ name: string }>).map(
      (p) => p.name,
    );
    expect(strangerNames).not.toContain('Gold');
  });

  it('UPDATE: patches limits and name; reflected on the next read', async () => {
    const created = await createGoldPlan({ name: 'Gold2' });
    const id = created.body.plan.id as string;

    const updated = await apiCall(server.baseUrl, 'PATCH', `/plans/${id}`, apiKey, {
      monthlyAllowance: 999,
      maxUnitsPerRequest: 7,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.plan).toMatchObject({
      id,
      name: 'Gold2',
      monthlyAllowance: 999,
      maxUnitsPerRequest: 7,
    });

    // Name-only patch.
    const renamed = await apiCall(server.baseUrl, 'PATCH', `/plans/${id}`, apiKey, {
      name: 'Gold2Renamed',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.plan.name).toBe('Gold2Renamed');
    expect(renamed.body.plan.monthlyAllowance).toBe(999);
  });

  it('UPDATE: 409 on a name collision within the scope', async () => {
    await createGoldPlan({ name: 'CollideA' });
    const second = await createGoldPlan({ name: 'CollideB' });
    const id = second.body.plan.id as string;

    const response = await apiCall(
      server.baseUrl,
      'PATCH',
      `/plans/${id}`,
      apiKey,
      { name: 'CollideA' },
    );
    expect(response.status).toBe(409);
  });

  it('UPDATE: rejects an empty patch with 400', async () => {
    const created = await createGoldPlan({ name: 'EmptyPatch' });
    const id = created.body.plan.id as string;
    const response = await apiCall(server.baseUrl, 'PATCH', `/plans/${id}`, apiKey, {});
    expect(response.status).toBe(400);
  });

  it('UPDATE/DELETE: 404 for another tenant’s plan (IDOR probe)', async () => {
    const created = await createGoldPlan({ name: 'PrivateGold' });
    const id = created.body.plan.id as string;

    const update = await apiCall(
      server.baseUrl,
      'PATCH',
      `/plans/${id}`,
      strangerKey,
      { monthlyAllowance: 1 },
    );
    expect(update.status).toBe(404);

    const remove = await apiCall(
      server.baseUrl,
      'DELETE',
      `/plans/${id}`,
      strangerKey,
    );
    expect(remove.status).toBe(404);

    // Owner still sees it intact — the probes changed nothing.
    const list = await apiCall(server.baseUrl, 'GET', '/plans', apiKey);
    const stillThere = (list.body.plans as Array<{ id: string }>).some(
      (p) => p.id === id,
    );
    expect(stillThere).toBe(true);
  });

  it('UPDATE/DELETE: predefined catalog plans are immutable (404)', async () => {
    const list = await apiCall(server.baseUrl, 'GET', '/plans', apiKey);
    const predefined = (list.body.plans as Array<{
      id: string;
      name: string;
      isPredefined: boolean;
    }>).find((p) => p.isPredefined && p.name === 'Premium');
    expect(predefined).toBeDefined();

    const update = await apiCall(
      server.baseUrl,
      'PATCH',
      `/plans/${predefined!.id}`,
      apiKey,
      { monthlyAllowance: 1 },
    );
    expect(update.status).toBe(404);

    const remove = await apiCall(
      server.baseUrl,
      'DELETE',
      `/plans/${predefined!.id}`,
      apiKey,
    );
    expect(remove.status).toBe(404);
  });

  it('DELETE: 409 while bound, 200 after rebinding the subject elsewhere', async () => {
    // A custom USER plan bound to a user cannot disappear out from under
    // live quota decisions.
    const plan = await createGoldPlan({ name: 'BoundPlan', monthlyAllowance: 50, maxUnitsPerRequest: 5 });
    const planId = plan.body.plan.id as string;

    await apiCall(server.baseUrl, 'POST', '/users', apiKey, {
      userId: 'bound-user',
      planId,
    });

    const blocked = await apiCall(server.baseUrl, 'DELETE', `/plans/${planId}`, apiKey);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.detail)).toContain('bound');

    // Rebind the user to a predefined plan — the custom plan is released.
    const rebind = await apiCall(
      server.baseUrl,
      'PATCH',
      '/users/bound-user/plan',
      apiKey,
      { planName: 'Premium' },
    );
    expect(rebind.status).toBe(200);
    expect(rebind.body.user.plan.name).toBe('Premium');

    const removed = await apiCall(server.baseUrl, 'DELETE', `/plans/${planId}`, apiKey);
    expect(removed.status).toBe(200);
    expect(removed.body.deleted).toBe(true);

    // Truly gone from the catalog.
    const list = await apiCall(server.baseUrl, 'GET', '/plans', apiKey);
    const stillListed = (list.body.plans as Array<{ id: string }>).some(
      (p) => p.id === planId,
    );
    expect(stillListed).toBe(false);
  });

  it('user plan change enforces USER-type plans and tenant scoping', async () => {
    await apiCall(server.baseUrl, 'POST', '/users', apiKey, {
      userId: 'rebind-user',
      planName: 'Basic',
    });

    // Binding an ACCOUNT-type plan to a user is a 409 (type guard).
    const wrongType = await apiCall(
      server.baseUrl,
      'PATCH',
      '/users/rebind-user/plan',
      apiKey,
      { planName: 'Pro' },
    );
    expect(wrongType.status).toBe(409);

    // Unknown user → 404.
    const missing = await apiCall(
      server.baseUrl,
      'PATCH',
      '/users/no-such-user/plan',
      apiKey,
      { planName: 'Premium' },
    );
    expect(missing.status).toBe(404);

    // A valid rebind reports the new plan.
    const ok = await apiCall(
      server.baseUrl,
      'PATCH',
      '/users/rebind-user/plan',
      apiKey,
      { planName: 'Premium' },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.user.plan).toMatchObject({ name: 'Premium', monthlyAllowance: 300 });
  });
});
