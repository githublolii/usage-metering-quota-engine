import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * `globalSetup` boots the database BEFORE any test file is imported (so the
 * app modules' import-time env validation always succeeds), runs migrations,
 * and seeds the predefined plan catalog.
 *
 * `fileParallelism` is intentionally off: DB-backed suites share one
 * PostgreSQL cluster; intra-file parallelism (Promise.all over HTTP) is
 * where the real concurrency lives.
 */
export default defineConfig({
  test: {
    globalSetup: ['tests/helpers/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 120_000,
    reporters: ['default'],
  },
});
