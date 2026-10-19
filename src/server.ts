import { createApp } from './app.js';
import { closePool } from './database/connection.js';
import { env } from './config/env.js';

/**
 * Server lifecycle manager.
 *
 * Graceful shutdown contract:
 *   1. Stop accepting NEW connections (server.close).
 *   2. Let in-flight requests finish (they hold pooled DB clients).
 *   3. Drain the pool (closePool) so PostgreSQL sees clean disconnects.
 *   4. Exit. A hard-exit timer guarantees we never hang forever.
 */

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(
    `[server] usage-metering-quota-engine listening on :${env.PORT} ` +
      `(env=${env.NODE_ENV}, poolMax=${env.DB_POOL_MAX}, log=${env.LOG_LEVEL})`,
  );
});

// 5s default keep-alive + close() wait; hard-exit deadline well beyond it.
const SHUTDOWN_DEADLINE_MS = 10_000;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received — draining connections…`);

  const forceExit = setTimeout(() => {
    console.error('[server] graceful shutdown timed out — exiting anyway');
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS);
  forceExit.unref();

  try {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await closePool();
    console.log('[server] drained — goodbye');
    process.exit(0);
  } catch (error) {
    console.error(
      `[server] shutdown error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  // A rejected promise that escaped a handler is a bug — log loudly but do
  // NOT kill the process mid-flight; the error middleware already rendered
  // the HTTP response, this is a supervisor signal.
  console.error(
    '[server] unhandled promise rejection:',
    reason instanceof Error ? reason.stack ?? reason.message : reason,
  );
});

process.on('uncaughtException', (error) => {
  // Unrecoverable: the process state is now undefined. Log & exit(1); the
  // container supervisor (docker-compose `init: true` / k8s) restarts us.
  console.error(`[server] uncaught exception: ${error.stack ?? error.message}`);
  process.exit(1);
});
