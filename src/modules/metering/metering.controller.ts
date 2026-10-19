import type { Request, Response } from 'express';
import type {
  ConsumeDto,
  HistoryQueryDto,
  UsageQueryDto,
} from '../../domain/types.js';
import * as meteringService from './metering.service.js';

/**
 * Metering controller.
 *
 * The consume endpoint's status-code contract:
 *   - 200 OK        accepted, OR an idempotent replay of an accepted decision
 *   - 422 Unprocessable Entity  rejected (well-formed request violating quota
 *                   policy), OR replay of a rejected decision — semantic
 *                   rejections, not transport failures
 *   - 400/401/404/409/500  via problem+json from the error middleware
 */

export async function consume(
  req: Request,
  res: Response,
): Promise<void> {
  const outcome = await meteringService.consume(req.auth!, req.body as ConsumeDto);
  res.setHeader('X-Idempotent-Replay', outcome.replayed ? 'true' : 'false');
  res.status(outcome.statusCode).json(outcome.payload);
}

export async function usage(
  req: Request,
  res: Response,
): Promise<void> {
  const report = await meteringService.getUsage(
    req.auth!,
    req.validatedQuery as UsageQueryDto,
  );
  res.status(200).json(report);
}

export async function history(
  req: Request,
  res: Response,
): Promise<void> {
  const report = await meteringService.getHistory(
    req.auth!,
    req.validatedQuery as HistoryQueryDto,
  );
  res.status(200).json(report);
}
