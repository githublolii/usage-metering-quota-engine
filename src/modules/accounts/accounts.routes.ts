import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../middleware/error.middleware.js';
import {
  ChangePlanSchema,
  CreateAccountSchema,
  RotateKeySchema,
} from '../../domain/types.js';
import * as controller from './accounts.controller.js';

/**
 * Account lifecycle routes.
 *
 *   POST   /accounts        PUBLIC  — provision account + API key (once)
 *   GET    /accounts/me     AUTH    — profile, bound plan, live usage
 *   POST   /accounts/rotate-key  AUTH — invalidate old key, issue new one
 *   PATCH  /accounts/plan   AUTH    — runtime plan mutation (no restart)
 */
export const accountsRouter = Router();

// Bootstrap route: intentionally public (chicken-and-egg with auth).
accountsRouter.post(
  '/',
  validate({ body: CreateAccountSchema }),
  asyncHandler(controller.createAccount),
);

accountsRouter.get(
  '/me',
  authMiddleware,
  asyncHandler(controller.getAccount),
);

accountsRouter.post(
  '/rotate-key',
  authMiddleware,
  validate({ body: RotateKeySchema }),
  asyncHandler(controller.rotateKey),
);

accountsRouter.patch(
  '/plan',
  authMiddleware,
  validate({ body: ChangePlanSchema }),
  asyncHandler(controller.changePlan),
);
