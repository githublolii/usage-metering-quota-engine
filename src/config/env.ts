import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration — validated once at boot with Zod.
 *
 * The process refuses to start with an invalid configuration instead of
 * limping along with silent defaults ("fail fast" on operator error).
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // 0 = listen on an ephemeral port (used by tests & the benchmark harness).
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL must be set (see .env.example)'),
  DB_POOL_MAX: z.coerce.number().int().positive().max(10_000).default(20),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  CORS_ORIGIN: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    console.error('[config] Invalid environment configuration:\n' + issues);
    process.exit(1);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

/** Comma-separated CORS origins (empty list means "reflect request origin"). */
export const corsOrigins: string[] = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  : [];

/**
 * Managed Postgres providers (Render, Heroku, Fly…) issue connections strings
 * with `sslmode=require`. We only opt into TLS when the operator asked for it,
 * and keep `rejectUnauthorized: false` for providers whose certificates chain
 * to system CAs in unusual ways. Self-hosted local development stays plain.
 */
export function shouldUseSsl(databaseUrl: string): boolean {
  return /sslmode=(require|verify-ca|verify-full|prefer)/i.test(databaseUrl);
}
