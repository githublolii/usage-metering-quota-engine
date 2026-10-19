import { Router } from 'express';
import { authMiddleware } from '../../middleware/auth.middleware.js';
import { validate } from '../../middleware/validate.middleware.js';
import { asyncHandler } from '../../middleware/error.middleware.js';
import {
  CreatePlanSchema,
  PlanIdParamsSchema,
  UpdatePlanSchema,
} from '../../domain/types.js';
import * as controller from './plans.controller.js';

/**
 * Plan management routes. All routes require authentication — plans are
 * either the public system catalog (readable) or tenant-private resources.
 *
 *   GET    /plans        — predefined catalog + this account's custom plans
 *   POST   /plans        — create a custom plan for this account
 *   PATCH  /plans/:id    — update a custom plan owned by this account
 *   DELETE /plans/:id    — delete a custom plan (only while unbound)
 */
export const plansRouter = Router();

plansRouter.use(authMiddleware);

plansRouter.get(
  '/',
  asyncHandler(controller.listPlans),
);

plansRouter.post(
  '/',
  validate({ body: CreatePlanSchema }),
  asyncHandler(controller.createPlan),
);

plansRouter.patch(
  '/:id',
  validate({ params: PlanIdParamsSchema, body: UpdatePlanSchema }),
  asyncHandler(controller.updatePlan),
);

plansRouter.delete(
  '/:id',
  validate({ params: PlanIdParamsSchema }),
  asyncHandler(controller.deletePlan),
);
