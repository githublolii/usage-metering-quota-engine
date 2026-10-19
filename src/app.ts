import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { corsOrigins, env } from './config/env.js';
import { pool } from './database/connection.js';
import { notFoundHandler, problemDetailsHandler } from './middleware/error.middleware.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { accountsRouter } from './modules/accounts/accounts.routes.js';
import { plansRouter } from './modules/plans/plans.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { meteringRouter } from './modules/metering/metering.routes.js';

/**
 * Express application assembly.
 *
 * Security posture:
 *   - helmet: hardened default headers (HSTS, no-sniff, frameguard, …)
 *   - strict JSON body limit: quota requests are tiny; anything larger is
 *     waste or abuse.
 *   - CORS allow-list from configuration (never `*` in production).
 *   - One central error renderer (RFC 7807) — stack traces never leak.
 */
/**
 * Dashboard static assets. Candidate order covers every execution layout:
 *   1. <cwd>/public      — `npm run serve`/`npm run dev` from the repo root,
 *                          and the Docker runtime (WORKDIR /app).
 *   2. <dist>/../public  — compiled layout (dist/src/app.js → <root>/public).
 *   3. <src>/../public   — tsx layout (src/app.ts → <root>/public).
 * Falls back to the first candidate when nothing exists (e.g. API-only
 * deployments); the routers and problem+json 404 handler take it from there.
 */
function resolvePublicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), 'public'),
    path.resolve(here, '..', '..', 'public'),
    path.resolve(here, '..', 'public'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return candidates[0] ?? process.cwd();
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins.length > 0 ? corsOrigins : true,
      methods: ['GET', 'POST', 'PATCH'],
    }),
  );
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(resolvePublicDir(), { index: 'index.html' }));

  // Liveness + readiness in one: process up AND database reachable.
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        poolMax: env.DB_POOL_MAX,
      });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unreachable' });
    }
  });

  app.use('/accounts', accountsRouter);
  app.use('/plans', authMiddleware, plansRouter);
  app.use('/users', authMiddleware, usersRouter);
  app.use('/metering', authMiddleware, meteringRouter);

  app.use(notFoundHandler);
  app.use(problemDetailsHandler);

  return app;
}

export const app = createApp();
