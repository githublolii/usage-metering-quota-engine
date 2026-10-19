import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Native SQL migration engine.
 *
 * Design goals:
 *  - Zero third-party migration dependencies; migrations are plain .sql
 *    files so reviewers can audit exactly what hits the database.
 *  - Each migration file runs inside its own transaction: it either fully
 *    applies or fully rolls back (PostgreSQL DDL is transactional).
 *  - A session-level advisory lock serializes concurrent migrators (e.g.
 *    two app instances racing on boot, or CI racing a deploy), which is
 *    otherwise a classic cause of duplicated/failed migrations.
 *  - Applied files are recorded with a SHA-256 checksum in
 *    `schema_migrations`; any local edit to an already-applied file is a
 *    hard error instead of being silently ignored.
 *
 * The engine is exported as functions (usable from tests/scripts) and has a
 * small CLI: `tsx src/database/migrator.ts [up|status]`.
 */

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Advisory-lock key: arbitrary constant; must be stable across processes. */
const MIGRATION_ADVISORY_LOCK_KEY = 722_421;

export interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  readonly name: string;
  readonly checksum: string;
  readonly applied: boolean;
}

export interface MigrationSummary {
  readonly appliedNow: string[];
  readonly totalApplied: number;
  readonly pending: number;
}

interface MigrationFile {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

function checksumOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function listMigrationFiles(): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch (error) {
    throw new Error(
      `Cannot read migrations directory at ${MIGRATIONS_DIR}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return entries
    .filter((entry) => entry.endsWith('.sql'))
    .sort() // deterministic lexicographic order == application order
    .map((name) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      return { name, sql, checksum: checksumOf(sql) };
    });
}

async function ensureBookkeepingTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT        NOT NULL PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrations(
  client: Client,
): Promise<Map<string, AppliedMigration>> {
  const result = await client.query<{
    name: string;
    checksum: string;
    applied_at: Date;
  }>(
    'SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name',
  );
  return new Map(
    result.rows.map((row) => [
      row.name,
      {
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
      } satisfies AppliedMigration,
    ]),
  );
}

/** Apply all pending migrations. Returns what was applied in this run. */
export async function runMigrations(
  connectionString: string,
): Promise<MigrationSummary> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query('SET TIME ZONE \'UTC\'');
    // Session-level lock: released automatically when the connection ends.
    await client.query('SELECT pg_advisory_lock($1)', [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]);

    await ensureBookkeepingTable(client);
    const applied = await appliedMigrations(client);
    const files = listMigrationFiles();

    // Integrity check FIRST: never apply new migrations on top of a
    // tampered history.
    for (const file of files) {
      const record = applied.get(file.name);
      if (record && record.checksum !== file.checksum) {
        throw new Error(
          `Migration "${file.name}" was already applied with checksum ` +
            `${record.checksum} but the local file now hashes to ` +
            `${file.checksum}. Migrations are immutable once applied — ` +
            `write a new migration instead of editing an old one.`,
        );
      }
    }

    const appliedNow: string[] = [];
    for (const file of files) {
      if (applied.has(file.name)) continue;

      try {
        await client.query('BEGIN');
        // Multi-statement simple-query protocol: the whole file is one unit.
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file.name, file.checksum],
        );
        await client.query('COMMIT');
        appliedNow.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(
          `Migration "${file.name}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const totalApplied = applied.size + appliedNow.length;
    return {
      appliedNow,
      totalApplied,
      pending: files.length - totalApplied,
    };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]).catch(() => undefined);
    await client.end();
  }
}

/** Report applied/pending migrations without changing anything. */
export async function migrationStatus(
  connectionString: string,
): Promise<MigrationStatus[]> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('SET TIME ZONE \'UTC\'');
    await ensureBookkeepingTable(client);
    const applied = await appliedMigrations(client);
    return listMigrationFiles().map((file) => ({
      name: file.name,
      checksum: file.checksum,
      applied: applied.has(file.name),
    }));
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const { env } = await import('../config/env.js');
  const databaseUrl = env.DATABASE_URL;

  if (command === 'status') {
    const status = await migrationStatus(databaseUrl);
    for (const entry of status) {
      console.log(
        `${entry.applied ? '[applied]' : '[pending]'} ${entry.name}  (${entry.checksum.slice(0, 12)}…)`,
      );
    }
    return;
  }

  if (command !== 'up') {
    console.error(`Unknown command "${command}". Usage: migrator [up|status]`);
    process.exitCode = 1;
    return;
  }

  const summary = await runMigrations(databaseUrl);
  for (const name of summary.appliedNow) {
    console.log(`[migrator] applied  ${name}`);
  }
  console.log(
    `[migrator] database is up to date — ${summary.totalApplied} applied, ${summary.pending} pending`,
  );
}

// Run the CLI only when executed directly (not when imported by tests).
const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(
      `[migrator] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
