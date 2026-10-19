import { Router } from 'express';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../middleware/error.middleware.js';
import {
  ConsumeSchema,
  HistoryQuerySchema,
  UsageQuerySchema,
} from '../../domain/types.js';
import * as controller from './metering.controller.js';

/**
 * Metering routes (auth applied by the app at mount time — these are the
 * engine's protected core).
 *
 *   POST /metering/consume   — the quota decision endpoint (idempotent)
 *   GET  /metering/usage     — live usage views (account + optional user)
 *   GET  /metering/history   — paginated consumption audit trail
 */
export const meteringRouter = Router();

meteringRouter.post(
  '/consume',
  validate({ body: ConsumeSchema }),
  asyncHandler(controller.consume),
);

meteringRouter.get(
  '/usage',
  validate({ query: UsageQuerySchema }),
  asyncHandler(controller.usage),
);

meteringRouter.get(
  '/history',
  validate({ query: HistoryQuerySchema }),
  asyncHandler(controller.history),
);
