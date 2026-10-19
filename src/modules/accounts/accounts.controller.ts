import type { Request, Response } from 'express';
import type { ChangePlanDto, CreateAccountDto } from '../../domain/types.js';
import * as accountsService from './accounts.service.js';

/**
 * Accounts controller. `POST /accounts` is the single public (bootstrap)
 * route; every other route runs behind the auth middleware.
 */

export async function createAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const created = await accountsService.createAccount(req.body as CreateAccountDto);
  res.status(201).json({
    account: {
      id: created.id,
      name: created.name,
      createdAt: created.createdAt,
      plan: created.plan,
    },
    // Plaintext key — the ONLY time it is ever returned.
    apiKey: created.apiKey,
  });
}

export async function getAccount(
  req: Request,
  res: Response,
): Promise<void> {
  const profile = await accountsService.getProfile(req.auth!.accountId);
  res.status(200).json({ account: profile });
}

export async function rotateKey(
  req: Request,
  res: Response,
): Promise<void> {
  const apiKey = await accountsService.rotateApiKey(req.auth!.accountId);
  res.status(200).json({
    apiKey,
    warning: 'Store this key now — it is shown only once.',
  });
}

export async function changePlan(
  req: Request,
  res: Response,
): Promise<void> {
  const account = await accountsService.changePlan(
    req.auth!.accountId,
    req.body as ChangePlanDto,
  );
  res.status(200).json({ account });
}
