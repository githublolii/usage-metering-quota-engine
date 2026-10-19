import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../middleware/error.middleware.js';
import {
  ChangePlanSchema,
  CreateUserSchema,
  UserExternalIdParamsSchema,
} from '../../domain/types.js';
import * as controller from './users.controller.js';

/**
 * User registration routes (strictly account-scoped).
 *
 *   POST   /users                — register a user under the authenticated account
 *   GET    /users                — list this account's users
 *   PATCH  /users/:userId/plan   — runtime user plan mutation (usage preserved)
 */
export const usersRouter = Router();

usersRouter.use(authMiddleware);

usersRouter.post(
  '/',
  validate({ body: CreateUserSchema }),
  asyncHandler(controller.createUser),
);

usersRouter.get(
  '/',
  asyncHandler(controller.listUsers),
);

usersRouter.patch(
  '/:userId/plan',
  validate({ params: UserExternalIdParamsSchema, body: ChangePlanSchema }),
  asyncHandler(controller.changePlan),
);
