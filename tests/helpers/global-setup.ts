import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Vitest global setup.
 *
 * Guarantees every test file sees a fully-migrated, seeded database, in one
 * of two modes:
 *
 *   1. TEST_DATABASE_URL is set   → use that PostgreSQL as-is (CI with a
 *      service container; the database is reset externally).
 *   2. Otherwise                  → boot a THROWAWAY embedded PostgreSQL
 *      (binaries shipped by the `embedded-postgres` devDependency) in a
 *      temp directory. No Docker required; every run starts pristine.
 *
 * In both modes the connection string is exported via process.env.DATABASE_URL
 * BEFORE any test file is imported — the app's import-time env validation
 * therefore always succeeds.
 */

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const externalUrl = process.env.TEST_DATABASE_URL;

  if (externalUrl !== undefined && externalUrl !== '') {
    process.env.DATABASE_URL = externalUrl;
    await migrateAndSeed(externalUrl);
    console.log('[global-setup] using TEST_DATABASE_URL — migrated & seeded.');
    return undefined;
  }

  // Embedded mode ----------------------------------------------------------
  const { default: EmbeddedPostgres } = await import('embedded-postgres');

  const port = 5433 + Math.floor(Math.random() * 400);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'metering-pg-'));

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('metering');

  const connectionString = `postgres://postgres:postgres@127.0.0.1:${port}/metering`;
  process.env.DATABASE_URL = connectionString;
  process.env.DB_POOL_MAX = '20';

  await migrateAndSeed(connectionString);
  console.log(
    `[global-setup] embedded PostgreSQL ready on 127.0.0.1:${port} (data dir: ${dataDir}).`,
  );

  return async () => {
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    console.log('[global-setup] embedded PostgreSQL stopped, temp dir removed.');
  };
}

async function migrateAndSeed(connectionString: string): Promise<void> {
  const { runMigrations } = await import('../../src/database/migrator.js');
  const { seedPredefinedPlans } = await import('../../scripts/seed.js');
  const summary = await runMigrations(connectionString);
  await seedPredefinedPlans(connectionString);
  console.log(
    `[global-setup] migrations: ${summary.totalApplied} applied (${summary.appliedNow.length} new this run); plans seeded.`,
  );
}
