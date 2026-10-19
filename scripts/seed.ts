import { Client } from 'pg';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Seed script — idempotent: safe to run any number of times.
 *
 * Installs the predefined (system-wide, account_id NULL) plan catalog:
 *
 *   ACCOUNT plans (bindable by accounts):
 *     Starter —   100 units / month, max  10 per request
 *     Pro     —   500 units / month, max  50 per request
 *
 *   USER plans (assignable to individual users):
 *     Basic   —   100 units / month, max  20 per request
 *     Premium —   300 units / month, max  50 per request
 *
 * Exported `seedPredefinedPlans(connectionString)` is reused by the test
 * suite's global setup so CI exercises the same seeding path as production.
 */

export interface SeedPlan {
  readonly name: string;
  readonly type: 'ACCOUNT' | 'USER';
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

export const PREDEFINED_PLANS: readonly SeedPlan[] = [
  { name: 'Starter', type: 'ACCOUNT', monthlyAllowance: 100, maxUnitsPerRequest: 10 },
  { name: 'Pro',     type: 'ACCOUNT', monthlyAllowance: 500, maxUnitsPerRequest: 50 },
  { name: 'Basic',   type: 'USER',    monthlyAllowance: 100, maxUnitsPerRequest: 20 },
  { name: 'Premium', type: 'USER',    monthlyAllowance: 300, maxUnitsPerRequest: 50 },
];

export async function seedPredefinedPlans(
  connectionString: string,
): Promise<readonly SeedPlan[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SET TIME ZONE \'UTC\'');

    const inserted: SeedPlan[] = [];
    for (const plan of PREDEFINED_PLANS) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO plans (name, type, is_predefined, monthly_allowance, max_units_per_request)
         VALUES ($1, $2, TRUE, $3, $4)
         ON CONFLICT ON CONSTRAINT unique_plan_name_scope DO UPDATE
            SET monthly_allowance = EXCLUDED.monthly_allowance,
                max_units_per_request = EXCLUDED.max_units_per_request,
                updated_at = NOW()
         RETURNING id`,
        [
          plan.name,
          plan.type,
          plan.monthlyAllowance,
          plan.maxUnitsPerRequest,
        ],
      );

      if (result.rowCount === 1) {
        inserted.push(plan);
      }
    }
    return inserted;
  } finally {
    await client.end();
  }
}

/** CLI entrypoint -------------------------------------------------------- */
async function main(): Promise<void> {
  const { env } = await import('../src/config/env.js');

  try {
    const plans = await seedPredefinedPlans(env.DATABASE_URL);
    console.log('[seed] predefined plan catalog is ready:');
    for (const plan of plans) {
      console.log(
        `  ${plan.type.padEnd(7)} ${plan.name.padEnd(8)} ` +
          `${String(plan.monthlyAllowance).padStart(6)} units/month  ` +
          `max ${String(plan.maxUnitsPerRequest).padStart(3)}/request`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('plans" does not exist') || message.includes('relation "plans"')) {
      console.error('[seed] the plans table is missing — run `npm run migrate` first');
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(
      `[seed] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
