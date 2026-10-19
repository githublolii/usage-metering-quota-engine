import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';

// ===========================================================================
// Branded nominal types
//
// Plain strings are ambiguous: a `string` could be an internal user UUID,
// an external id, or a period. Branded types make cross-contamination a
// compile-time error, which matters in a system where confusing the
// caller-supplied `userId` (external) with the internal `users.id` would
// create an IDOR vulnerability.
// ===========================================================================

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type AccountId = Brand<string, 'AccountId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type UserId = Brand<string, 'UserId'>;
export type ExternalUserId = Brand<string, 'ExternalUserId'>;
export type RequestId = Brand<string, 'RequestId'>;
export type ApiKey = Brand<string, 'ApiKey'>;
export type ApiKeyHash = Brand<string, 'ApiKeyHash'>;
export type Period = Brand<string, 'Period'>;

// ===========================================================================
// Periods — UTC calendar months 'YYYY-MM'
// ===========================================================================

export const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;

/** Type predicate: is `value` a syntactically valid 'YYYY-MM' period? */
export function isValidPeriod(value: string): value is Period {
  return PERIOD_PATTERN.test(value);
}

/** The UTC calendar month containing `date`, as a branded Period. */
export function currentUtcPeriod(date: Date = new Date()): Period {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}` as Period;
}

// ===========================================================================
// Core domain vocabulary
// ===========================================================================

export type PlanType = 'ACCOUNT' | 'USER';

export type RejectionSource = 'account' | 'user';

export type RejectionRule = 'monthly_allowance' | 'max_units_per_request';

/** Everything needed to evaluate one plan against one usage counter. */
export interface QuotaRuleSet {
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

/** A monotonic cumulative counter snapshot (never a decrementing balance). */
export interface QuotaUsage {
  readonly unitsConsumed: number;
}

/** Stored plan projection used by the read side (usage views). */
export interface PlanSnapshot {
  readonly id: PlanId;
  readonly name: string;
  readonly type: PlanType;
  readonly isPredefined: boolean;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
}

/** The usage view returned to clients: plan rules + live monotonic usage. */
export interface PlanUsageView {
  readonly planName: string;
  readonly planType: PlanType;
  readonly monthlyAllowance: number;
  readonly maxUnitsPerRequest: number;
  readonly unitsConsumed: number;
  readonly remaining: number;
}

/** RFC 7807-shaped structured violation (see spec §1.5). */
export interface Violation {
  readonly source: RejectionSource;
  readonly rule: RejectionRule;
  readonly limit: number;
  readonly requestedUnits: number;
  readonly currentUsage: number;
}

export type ConsumeResponseBody =
  | {
      readonly accepted: true;
      readonly requestId: string;
      readonly period: Period;
      readonly unitsConsumed: number;
      readonly usage: {
        readonly account: PlanUsageView;
        readonly user: PlanUsageView;
      };
    }
  | {
      readonly accepted: false;
      readonly requestId: string;
      readonly period: Period;
      readonly reason: string;
      readonly violation: Violation;
    };

/** Result of a consume call, after idempotency & transaction handling. */
export interface ConsumeOutcome {
  readonly statusCode: number;
  readonly replayed: boolean;
  readonly payload: ConsumeResponseBody;
}

/** Attached to `req` by the auth middleware after API-key verification. */
export interface AuthContext {
  readonly accountId: AccountId;
  readonly accountName: string;
  readonly planId: PlanId;
}

// Express type augmentation (checked at compile time, zero runtime cost).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Parsed query produced by the validate middleware. */
      validatedQuery?: unknown;
      /** Parsed path parameters produced by the validate middleware. */
      validatedParams?: unknown;
    }
  }
}

// ===========================================================================
// Zod DTO schemas — the single validation source of truth.
// `.strict()` everywhere: unknown fields are 400s, not silently ignored.
// ===========================================================================

const planNameSchema = z.string().trim().min(1).max(100);
const planIdSchema = z.string().uuid();
const externalUserIdSchema = z
  .string()
  .trim()
  .min(1, 'userId must not be empty')
  .max(255);

/** Plan reference fields shared by account/user/plan endpoints. */
const planReferenceFields = {
  planName: planNameSchema.optional(),
  planId: planIdSchema.optional(),
};

/** At most one of planName / planId; the service applies a default if absent. */
function atMostOnePlanReference(
  value: { planName?: unknown; planId?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (value.planName !== undefined && value.planId !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planId'],
      message: 'Provide either planName or planId, not both',
    });
  }
}

/** Exactly one of planName / planId. */
function exactlyOnePlanReference(
  value: { planName?: unknown; planId?: unknown },
  ctx: z.RefinementCtx,
): void {
  atMostOnePlanReference(value, ctx);
  if (value.planName === undefined && value.planId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['planName'],
      message: 'One of planName or planId is required',
    });
  }
}

export const CreateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    ...planReferenceFields,
  })
  .strict()
  .superRefine(atMostOnePlanReference);

export const ChangePlanSchema = z
  .object({
    ...planReferenceFields,
  })
  .strict()
  .superRefine(exactlyOnePlanReference);

export const RotateKeySchema = z.object({}).strict();

export const CreatePlanSchema = z
  .object({
    name: planNameSchema,
    type: z.enum(['ACCOUNT', 'USER']),
    monthlyAllowance: z
      .number()
      .int('monthlyAllowance must be an integer')
      .min(0)
      .max(1_000_000_000),
    maxUnitsPerRequest: z
      .number()
      .int('maxUnitsPerRequest must be an integer')
      .min(1)
      .max(1_000_000_000),
  })
  .strict();

/**
 * Custom-plan mutation: every field optional, but at least one required —
 * a PATCH that changes nothing is a client bug, not a no-op success.
 */
export const UpdatePlanSchema = z
  .object({
    name: planNameSchema.optional(),
    monthlyAllowance: z
      .number()
      .int('monthlyAllowance must be an integer')
      .min(0)
      .max(1_000_000_000)
      .optional(),
    maxUnitsPerRequest: z
      .number()
      .int('maxUnitsPerRequest must be an integer')
      .min(1)
      .max(1_000_000_000)
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.monthlyAllowance !== undefined ||
      value.maxUnitsPerRequest !== undefined,
    { message: 'At least one of name, monthlyAllowance, or maxUnitsPerRequest is required' },
  );

/** Path parameter shapes for the new mutation routes. */
export const PlanIdParamsSchema = z
  .object({ id: planIdSchema })
  .strict();

export const UserExternalIdParamsSchema = z
  .object({ userId: externalUserIdSchema })
  .strict();

export const CreateUserSchema = z
  .object({
    userId: externalUserIdSchema,
    ...planReferenceFields,
  })
  .strict()
  .superRefine(atMostOnePlanReference);

export const ConsumeSchema = z
  .object({
    userId: externalUserIdSchema,
    units: z
      .number()
      .int('units must be an integer')
      .min(1, 'units must be a positive non-zero integer')
      .max(1_000_000_000),
    requestId: z.string().uuid('requestId must be a UUID'),
  })
  .strict();

export const UsageQuerySchema = z
  .object({
    userId: externalUserIdSchema.optional(),
    period: z
      .string()
      .regex(PERIOD_PATTERN, 'period must be a valid UTC month: YYYY-MM')
      .optional(),
  })
  .strict();

export const HistoryQuerySchema = z
  .object({
    userId: externalUserIdSchema.optional(),
    period: z
      .string()
      .regex(PERIOD_PATTERN, 'period must be a valid UTC month: YYYY-MM')
      .optional(),
    accepted: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type CreateAccountDto = z.infer<typeof CreateAccountSchema>;
export type ChangePlanDto = z.infer<typeof ChangePlanSchema>;
export type CreatePlanDto = z.infer<typeof CreatePlanSchema>;
export type UpdatePlanDto = z.infer<typeof UpdatePlanSchema>;
export type CreateUserDto = z.infer<typeof CreateUserSchema>;
export type ConsumeDto = z.infer<typeof ConsumeSchema>;
export type UsageQueryDto = z.infer<typeof UsageQuerySchema>;
export type HistoryQueryDto = z.infer<typeof HistoryQuerySchema>;

// ---------------------------------------------------------------------------
// API key helpers (SHA-256). Defined here — next to the branded types — so
// every layer shares ONE canonical implementation.
// ---------------------------------------------------------------------------

/** SHA-256 hex digest (64 chars) of an API key. Plaintext is never stored. */
export function hashApiKey(key: string): ApiKeyHash {
  return createHash('sha256').update(key, 'utf8').digest('hex') as ApiKeyHash;
}

/**
 * Generate a new 256-bit API key: `mk_<43 base64url chars>`.
 * Only ever returned once, at creation or rotation time.
 */
export function generateApiKey(): ApiKey {
  const body = randomBytes(32).toString('base64url');
  return `mk_${body}` as ApiKey;
}
