import type { Request, Response } from 'express';
import type { ChangePlanDto, CreateUserDto } from '../../domain/types.js';
import * as usersService from './users.service.js';

export async function createUser(
  req: Request,
  res: Response,
): Promise<void> {
  const user = await usersService.createUser(
    req.auth!.accountId,
    req.body as CreateUserDto,
  );
  res.status(201).json({ user });
}

export async function listUsers(
  req: Request,
  res: Response,
): Promise<void> {
  const users = await usersService.listUsers(req.auth!.accountId);
  res.status(200).json({ users });
}

export async function changePlan(
  req: Request,
  res: Response,
): Promise<void> {
  const { userId } = req.validatedParams as { userId: string };
  const user = await usersService.changeUserPlan(
    req.auth!.accountId,
    userId,
    req.body as ChangePlanDto,
  );
  res.status(200).json({ user });
}
