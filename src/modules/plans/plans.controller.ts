import type { Request, Response } from 'express';
import type { CreatePlanDto, UpdatePlanDto } from '../../domain/types.js';
import * as plansService from './plans.service.js';

/**
 * Plans controller. Controllers are deliberately thin: authenticate (via
 * middleware), validate (via middleware), delegate, render. Every business
 * decision lives in the service/domain layers.
 */

export async function listPlans(
  req: Request,
  res: Response,
): Promise<void> {
  const plans = await plansService.listPlans(req.auth!.accountId);
  res.status(200).json({ plans });
}

export async function createPlan(
  req: Request,
  res: Response,
): Promise<void> {
  const plan = await plansService.createCustomPlan(
    req.auth!.accountId,
    req.body as CreatePlanDto,
  );
  res.status(201).json({ plan });
}

export async function updatePlan(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.validatedParams as { id: string };
  const plan = await plansService.updateCustomPlan(
    req.auth!.accountId,
    id,
    req.body as UpdatePlanDto,
  );
  res.status(200).json({ plan });
}

export async function deletePlan(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.validatedParams as { id: string };
  await plansService.deleteCustomPlan(req.auth!.accountId, id);
  res.status(200).json({ deleted: true, planId: id });
}
