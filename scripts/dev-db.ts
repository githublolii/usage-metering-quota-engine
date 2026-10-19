import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Embedded PostgreSQL bootstrap (development & benchmarking utility).
 *
 * Boots a REAL PostgreSQL 17 server (binaries shipped by the
 * `embedded-postgres` devDependency — no Docker, no admin rights) inside a
 * temp directory, migrates it, and seeds the predefined plan catalog.
 *
 * Three consumers share this module:
 *   - `npm run dev:db`   → long-running dev database (Ctrl+C to stop)
 *   - `scripts/load-test.ts` → self-contained, reproducible benchmark DB
 *   - `src/client/demo.ts`   → zero-config demo database
 *   - `tests/helpers/global-setup.ts` → pristine per-run test database
 *
 * In production the app always talks to a real managed/external PostgreSQL
 * via DATABASE_URL; this helper exists purely so the repo runs end-to-end
 * on any developer machine in seconds.
 */

export interface EmbeddedPostgresInstance {
  readonly connectionString: string;
  readonly stop: () => Promise<void>;
}

export async function startEmbeddedPostgres(): Promise<EmbeddedPostgresInstance> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { runMigrations } = await import(
    '../src/database/migrator.js'
  );
  const { seedPredefinedPlans } = await import('./seed.js');

  const port = 55432 + Math.floor(Math.random() * 400);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'metering-pg-'));

  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await instance.initialise();
  await instance.start();
  await instance.createDatabase('metering');

  const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/metering`;
  await runMigrations(connectionString);
  await seedPredefinedPlans(connectionString);

  return {
    connectionString,
    stop: async () => {
      await instance.stop();
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  console.log('[dev-db] booting embedded PostgreSQL (no Docker required)…');
  const instance = await startEmbeddedPostgres();
  console.log(`[dev-db] ready: ${instance.connectionString}`);
  console.log('[dev-db] point DATABASE_URL at it and run `npm run dev`.');
  console.log('[dev-db] press Ctrl+C to stop.');

  const shutdown = async (): Promise<void> => {
    console.log('\n[dev-db] stopping…');
    await instance.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
