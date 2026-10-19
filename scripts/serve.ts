import { once } from 'node:events';

/**
 * Self-contained API server launcher (development convenience).
 *
 *   npx tsx scripts/serve.ts            → API on :3000, zero setup
 *
 * Behavior:
 *   1. If DATABASE_URL is set (env or .env) → use that PostgreSQL as-is.
 *   2. Otherwise → boot a throwaway embedded PostgreSQL (migrated + seeded
 *      automatically) so the API runs with ZERO configuration.
 *
 * Note: for production, run `npm run build && npm start` against a real
 * managed PostgreSQL — this script exists for local exploration.
 */

// Prepare the environment BEFORE importing app modules (the pg pool and
// validated config are captured at import time).
if (process.env.DATABASE_URL === undefined) {
  const dotenv = await import('dotenv');
  dotenv.config();
}

let stopDatabase: (() => Promise<void>) | null = null;

if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '') {
  console.log('[serve] no DATABASE_URL configured — booting embedded PostgreSQL…');
  const { startEmbeddedPostgres } = await import('./dev-db.js');
  const database = await startEmbeddedPostgres();
  process.env.DATABASE_URL = database.connectionString;
  stopDatabase = () => database.stop();
}

const { createApp } = await import('../src/app.js');
const { closePool } = await import('../src/database/connection.js');
const { env } = await import('../src/config/env.js');

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[serve] API ready on http://localhost:${env.PORT}`);
  console.log(`[serve] dashboard: http://localhost:${env.PORT}/  (provision, consume, replay, plan switch, history, guided tour)`);
  console.log(`[serve] try:  GET /health   (liveness + database check)`);
  console.log(`[serve]       GET /accounts/me   → 401 problem+json without a key`);
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[serve] ${signal} received — shutting down…`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();

  (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
  await stopDatabase?.();
  console.log('[serve] goodbye');
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await once(server, 'listening');
