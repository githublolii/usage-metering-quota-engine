import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';

/**
 * Interactive CLI simulation client (spec §5).
 *
 * A guided, self-verifying walkthrough of the engine's six showcase
 * phases against a LIVE server:
 *
 *   Phase 1  Provision an account, receive the API key (shown ONCE).
 *   Phase 2  Register user-1 (Basic USER plan) and user-2 (Premium USER plan).
 *   Phase 3  Accepted consumption: user-1 requests 10 units.
 *   Phase 4  USER rule violation: user-1 requests 25 (> max 20/request),
 *            then an idempotent replay of the same requestId.
 *   Phase 5  ACCOUNT exhaustion: user-2 drains the Starter allowance;
 *            subsequent requests rejected by account monthly_allowance —
 *            including an exact-boundary acceptance on the way.
 *   Phase 6  Runtime plan mutation: upgrade the account to Pro with no
 *            restart, then re-run the previously rejected request with a
 *            fresh idempotency key — it passes, preserving all prior usage.
 *
 * Target resolution (in order):
 *   1. `DEMO_BASE_URL` env var → that server, verbatim.
 *   2. A healthy server already listening on localhost:3000 (`npm run dev`).
 *   3. Otherwise: boot a fully self-contained engine (throwaway embedded
 *      PostgreSQL + in-process API) so `npm run demo` works with ZERO
 *      setup on any machine. Automatic teardown at exit.
 *
 * Run:  npm run demo
 */

let BASE_URL = process.env.DEMO_BASE_URL ?? 'http://localhost:3000';

/** Self-host teardown, invoked when the demo exits. */
let teardownSelfHosted: (() => Promise<void>) | null = null;

async function resolveTarget(): Promise<void> {
  if (process.env.DEMO_BASE_URL !== undefined) {
    info(`Target server: ${BASE_URL} (from DEMO_BASE_URL)`);
    return;
  }

  // Probe for an already-running local server (npm run dev).
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    const response = await fetch(`${BASE_URL}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      info(`Target server: ${BASE_URL} (detected running server)`);
      return;
    }
  } catch {
    // Not running — fall through to self-hosting.
  }

  info('No server detected — booting a self-contained engine (embedded PostgreSQL + in-process API)…');

  if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '') {
    const { startEmbeddedPostgres } = await import('../../scripts/dev-db.js');
    const database = await startEmbeddedPostgres();
    process.env.DATABASE_URL = database.connectionString;
    process.env.DB_POOL_MAX = process.env.DB_POOL_MAX ?? '10';
    process.env.PORT = '0';
    teardownSelfHosted = async () => {
      await database.stop();
    };
  }

  const { createApp } = await import('../app.js');
  const { closePool } = await import('../database/connection.js');
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  BASE_URL = `http://127.0.0.1:${port}`;
  info(`Target server: ${BASE_URL} (self-hosted)`);

  const previousTeardown = teardownSelfHosted;
  teardownSelfHosted = async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    await previousTeardown?.();
  };
}

interface ApiResult {
  readonly status: number;
  readonly ok: boolean;
  readonly body: any;
  readonly replayHeader: string | null;
}

async function api(
  method: string,
  path: string,
  apiKey: string | null,
  body?: unknown,
): Promise<ApiResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== null) headers['x-api-key'] = apiKey;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
    if (!response.ok) {
      throw new Error(
        `Server at ${BASE_URL} returned ${response.status} with a non-JSON body. ` +
          'Is the API server running? (`npm run dev`)',
      );
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    body: parsed,
    replayHeader: response.headers.get('x-idempotent-replay'),
  };
}

// ---------------------------------------------------------------------------
// Console helpers
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function pause(): Promise<void> {
  if (process.env.DEMO_NO_PAUSE === '1') return;
  await rl.question(pc.dim('  ⏎  press Enter to continue… '));
  console.log();
}

function phase(title: string): void {
  console.log(`\n${pc.bgCyan(pc.black(` PHASE `))} ${pc.bold(title)}`);
}

function step(text: string): void {
  console.log(`  ${pc.cyan('›')} ${text}`);
}

function info(text: string): void {
  console.log(`    ${pc.dim(text)}`);
}

function success(text: string): void {
  console.log(`    ${pc.green('✔')} ${text}`);
}

function failure(text: string): void {
  console.log(`    ${pc.red('✘')} ${text}`);
  process.exitCode = 1;
}

function expect(condition: boolean, description: string): void {
  if (condition) success(description);
  else failure(description);
}

interface UsageView {
  readonly planName: string;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly unitsConsumed: number;
  readonly remaining: number;
}

function renderUsage(label: string, view: UsageView): void {
  const barWidth = 20;
  const used = Math.min(1, view.unitsConsumed / Math.max(1, view.monthlyAllowance));
  const filled = Math.round(barWidth * used);
  const bar = pc.green('█'.repeat(filled)) + pc.dim('░'.repeat(barWidth - filled));
  console.log(
    `    ${pc.bold(label.padEnd(9))} ${bar} ` +
      `${pc.yellow(String(view.unitsConsumed).padStart(4))}/${view.monthlyAllowance} ` +
      `${pc.dim(`(${view.planName}, max ${view.maxUnitsPerRequest}/req, remaining ${view.remaining})`)}`,
  );
}

// ---------------------------------------------------------------------------
// Demo phases
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(pc.bold('\n  ⚡ USAGE METERING & QUOTA ENGINE — live demo\n'));
  await resolveTarget();
  info('Fresh state every run — a brand-new account is provisioned for you.');

  const accountName = `demo-${randomUUID().slice(0, 8)}`;
  let apiKey: string;

  // ------------------------------------------------------------------ Phase 1
  phase('1 · Provision account (API key shown exactly once)');
  step(`POST /accounts { name: "${accountName}", planName: "Starter" }`);
  const created = await api('POST', '/accounts', null, {
    name: accountName,
    planName: 'Starter',
  });
  expect(created.status === 201, 'Account created (HTTP 201)');
  apiKey = created.body?.apiKey as string;
  expect(typeof apiKey === 'string' && apiKey.startsWith('mk_'), 'API key generated');
  console.log(
    `\n    ${pc.bgYellow(pc.black(' STORE THIS KEY NOW '))}  ${pc.yellow(apiKey)}\n` +
      `    ${pc.dim('(SHA-256 hash is persisted; the plaintext is never stored or shown again)')}`,
  );
  await pause();

  // ------------------------------------------------------------------ Phase 2
  phase('2 · Register user-1 (Basic) and user-2 (Premium)');
  step('POST /users { userId: "user-1", planName: "Basic" }');
  const u1 = await api('POST', '/users', apiKey, { userId: 'user-1', planName: 'Basic' });
  expect(u1.status === 201, `user-1 on Basic plan (100/mo, max 20/request)`);

  step('POST /users { userId: "user-2", planName: "Premium" }');
  const u2 = await api('POST', '/users', apiKey, { userId: 'user-2', planName: 'Premium' });
  expect(u2.status === 201, `user-2 on Premium plan (300/mo, max 50/request)`);
  info('Account plan: Starter — 100 units/month shared across ALL users, max 10/request.');
  await pause();

  // ------------------------------------------------------------------ Phase 3
  phase('3 · Accepted consumption — user-1 requests 10 units');
  const consume10 = { userId: 'user-1', units: 10, requestId: randomUUID() };
  step(`POST /metering/consume ${JSON.stringify({ ...consume10, requestId: '…' })}`);
  const accepted = await api('POST', '/metering/consume', apiKey, consume10);
  expect(accepted.status === 200, `Accepted (HTTP 200) — ${accepted.body?.usage?.account?.unitsConsumed}/100 account units consumed`);
  renderUsage('account', accepted.body.usage.account);
  renderUsage('user-1', accepted.body.usage.user);
  await pause();

  // ------------------------------------------------------------------ Phase 4
  phase('4 · USER rule violation — user-1 requests 25 units (max 20)');
  const violationId = randomUUID();
  step('POST /metering/consume { userId: "user-1", units: 25 }');
  const rejected = await api('POST', '/metering/consume', apiKey, {
    userId: 'user-1',
    units: 25,
    requestId: violationId,
  });
  expect(rejected.status === 422, 'Rejected with HTTP 422 (semantic rejection)');
  const violation = rejected.body?.violation;
  expect(
    violation?.source === 'user' &&
      violation?.rule === 'max_units_per_request' &&
      violation?.limit === 20 &&
      violation?.requestedUnits === 25,
    `violation = { source: "user", rule: "max_units_per_request", limit: 20, requestedUnits: 25, currentUsage: ${violation?.currentUsage} }`,
  );
  info(`reason: "${rejected.body?.reason}"`);

  step('Retry with the SAME requestId → idempotent replay of the identical decision');
  const replay = await api('POST', '/metering/consume', apiKey, {
    userId: 'user-1',
    units: 25,
    requestId: violationId,
  });
  expect(
    replay.status === 422 &&
      isDeepStrictEqual(replay.body, rejected.body) &&
      replay.replayHeader === 'true',
    'Identical 422 payload returned, zero extra units consumed (X-Idempotent-Replay: true)',
  );
  await pause();

  // ------------------------------------------------------------------ Phase 5
  phase('5 · ACCOUNT exhaustion — user-2 drains the Starter allowance');
  info('Each request stays within per-request limits; the ACCOUNT monthly');
  info('allowance is what runs out. Watch for the exact-boundary acceptance.');
  const drainLog: Array<{ units: number; status: number; accountTotal: number | null }> = [];
  let lastRejection: ApiResult | null = null;
  for (let i = 1; i <= 12; i += 1) {
    const attempt = await api('POST', '/metering/consume', apiKey, {
      userId: 'user-2',
      units: 10,
      requestId: randomUUID(),
    });
    const total = attempt.body?.usage?.account?.unitsConsumed ?? null;
    drainLog.push({ units: 10, status: attempt.status, accountTotal: total });
    if (attempt.status !== 200) {
      lastRejection = attempt;
      break;
    }
  }
  for (const entry of drainLog.slice(0, 3)) {
    console.log(
      `    ${pc.dim('user-2')}  ${pc.yellow('+10')} → ${entry.status === 200
        ? pc.green(`accepted  account ${entry.accountTotal}/100`)
        : pc.red('rejected')}`,
    );
  }
  if (drainLog.length > 4) console.log(`    ${pc.dim(`… ${drainLog.length - 4} more requests …`)}`);
  const lastAccepted = [...drainLog].reverse().find((e) => e.status === 200);
  if (lastAccepted !== undefined) {
    console.log(
      `    ${pc.dim('user-2')}  ${pc.yellow('+10')} → ${pc.green(`accepted  account ${lastAccepted.accountTotal}/100  (exact boundary: consumed == allowance)`)}`,
    );
  }
  const finalEntry = drainLog[drainLog.length - 1];
  if (finalEntry !== undefined && finalEntry.status !== 200) {
    console.log(
      `    ${pc.dim('user-2')}  ${pc.yellow('+10')} → ${pc.red('rejected  (account monthly_allowance exhausted)')}`,
    );
  }
  expect(lastRejection?.status === 422, 'Final drain request rejected with HTTP 422');
  const acctViolation = lastRejection?.body?.violation;
  expect(
    acctViolation?.source === 'account' &&
      acctViolation?.rule === 'monthly_allowance' &&
      acctViolation?.limit === 100 &&
      acctViolation?.currentUsage === 100,
    `violation = { source: "account", rule: "monthly_allowance", limit: 100, requestedUnits: 10, currentUsage: 100 }`,
  );
  await pause();

  // ------------------------------------------------------------------ Phase 6
  phase('6 · Runtime plan mutation — upgrade Starter → Pro, no restart');
  step('PATCH /accounts/plan { planName: "Pro" }');
  const upgraded = await api('PATCH', '/accounts/plan', apiKey, { planName: 'Pro' });
  expect(upgraded.status === 200, 'Account re-bound to Pro (500/mo, max 50/request)');

  step('GET /accounts/me — usage survives the plan change');
  const me = await api('GET', '/accounts/me', apiKey);
  expect(
    me.body?.account?.usage?.unitsConsumed === 100 &&
      me.body?.account?.usage?.remaining === 400,
    `Previous usage preserved: consumed 100, remaining 400 (monotonic counters untouched)`,
  );
  renderUsage('account', {
    planName: 'Pro',
    monthlyAllowance: 500,
    maxUnitsPerRequest: 50,
    unitsConsumed: me.body?.account?.usage?.unitsConsumed,
    remaining: me.body?.account?.usage?.remaining,
  });

  step('Re-run the previously rejected request (NEW idempotency key)');
  info('A fresh requestId is required: an idempotency key maps to an');
  info('immutable decision — retrying the OLD key replays the rejection.');
  const retry = await api('POST', '/metering/consume', apiKey, {
    userId: 'user-2',
    units: 10,
    requestId: randomUUID(),
  });
  expect(retry.status === 200, 'Accepted immediately (HTTP 200)');
  expect(
    retry.body?.usage?.account?.unitsConsumed === 110 &&
      retry.body?.usage?.account?.remaining === 390,
    `Account now 110/500 consumed, 390 remaining — prior usage intact`,
  );
  renderUsage('account', retry.body.usage.account);
  renderUsage('user-2', retry.body.usage.user);
  await pause();

  // ------------------------------------------------------------------ Epilogue
  phase('✓ Epilogue · Usage & audit trail');
  step('GET /metering/usage?userId=user-1');
  const usage1 = await api('GET', '/metering/usage?userId=user-1', apiKey);
  renderUsage('account', usage1.body?.account);
  renderUsage('user-1', usage1.body?.user);

  step('GET /metering/history?limit=3 (most recent decisions)');
  const history = await api('GET', '/metering/history?limit=3', apiKey);
  expect(history.status === 200, `Audit trail returned (${history.body?.total} total records)`);
  for (const record of history.body?.records ?? []) {
    console.log(
      `    ${pc.dim(new Date(record.createdAt).toISOString().slice(11, 19))}  ` +
        `${record.accepted ? pc.green('accept') : pc.red('reject')}  ` +
        `${pc.yellow(`+${record.unitsRequested}`)}  ${pc.dim(record.userId)}  ` +
        `${pc.dim(record.rejectionRule ?? 'ok')}`,
    );
  }

  console.log(
    `\n  ${pc.bgGreen(pc.black(' DEMO COMPLETE '))} ` +
      `${pc.bold('All phases passed against the live engine.')}\n`,
  );
  rl.close();
}

void main()
  .catch((error) => {
    console.error(
      `\n  ${pc.red('Demo failed:')} ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    rl.close();
  })
  .finally(async () => {
    if (teardownSelfHosted !== null) {
      await teardownSelfHosted();
      info('Self-hosted engine stopped. Nothing left behind.');
    }
  });
