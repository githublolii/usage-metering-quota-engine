import type { NextFunction, Request, Response } from 'express';
import type { PoolClient } from 'pg';
import type { AccountId, ApiKeyHash, PlanId } from '../domain/types.js';
import { hashApiKey } from '../domain/types.js';
import { AuthenticationError } from '../domain/errors.js';
import { pool } from '../database/connection.js';
import { asyncHandler } from './error.middleware.js';

/**
 * API key verification middleware.
 *
 * Security properties:
 *   - Accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 *   - Only the SHA-256 hex digest ever touches the wire to PostgreSQL;
 *     plaintext keys are never stored, logged, or persisted anywhere.
 *   - Lookup is an O(log n) index hit on `accounts.api_key_hash UNIQUE`.
 *   - The authenticated account is attached to `req.auth`; every later
 *     query filters on `account_id`, which is what makes cross-tenant
 *     IDOR structurally impossible rather than merely untested.
 */

interface AuthenticatedAccountRow {
  readonly id: string;
  readonly name: string;
  readonly plan_id: string;
}

/** Extract the raw API key from supported headers (or null). */
export function extractApiKey(req: Request): string | null {
  const headerKey = req.get('x-api-key');
  if (headerKey !== undefined && headerKey.trim().length > 0) {
    return headerKey.trim();
  }

  const authorization = req.get('authorization');
  if (authorization !== undefined) {
    const [scheme, token] = authorization.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() === 'bearer' && token && token.length > 0) {
      return token;
    }
  }

  return null;
}

/** Resolve an account (and its plan binding) from an API key digest. */
export async function findAccountByKeyHash(
  keyHash: ApiKeyHash,
  client: PoolClient | null = null,
): Promise<AuthenticatedAccountRow | null> {
  const sql = 'SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1';
  const result =
    client !== null
      ? await client.query<AuthenticatedAccountRow>(sql, [keyHash])
      : await pool.query<AuthenticatedAccountRow>(sql, [keyHash]);
  return result.rows[0] ?? null;
}

export const authMiddleware = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction) => {
    const rawKey = extractApiKey(req);
    if (rawKey === null) {
      throw new AuthenticationError(
        'Missing API key. Send it via the X-API-Key header or as "Authorization: Bearer <key>".',
      );
    }

    const account = await findAccountByKeyHash(hashApiKey(rawKey));
    if (account === null) {
      throw new AuthenticationError('Invalid API key.');
    }

    req.auth = {
      accountId: account.id as AccountId,
      accountName: account.name,
      planId: account.plan_id as PlanId,
    };
    next();
  },
);

export { hashApiKey };
