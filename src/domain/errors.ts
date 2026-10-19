import type { ZodError } from 'zod';

/**
 * Domain error taxonomy.
 *
 * Operational failures (bad credentials, missing entities, validation,
 * conflicts) become typed exceptions that the central error middleware maps
 * to RFC 7807 `application/problem+json` responses. Because each error
 * carries its own HTTP status, controllers never invent status codes —
 * the *domain* owns semantics, the transport layer only renders them.
 */

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'INTERNAL';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance: string;
  readonly errors?: ReadonlyArray<{
    readonly path: string;
    readonly message: string;
    readonly code?: string;
  }>;
}

export class DomainError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: ReadonlyArray<{
    path: string;
    message: string;
    code?: string;
  }>;

  constructor(init: {
    status: number;
    code: ErrorCode;
    title: string;
    detail?: string;
    errors?: ReadonlyArray<{ path: string; message: string; code?: string }>;
  }) {
    super(init.title);
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors;
  }

  /** RFC 7807 representation (extension member `errors` for validation). */
  toProblemDetails(instance: string): ProblemDetails {
    return {
      type: `urn:quota-engine:errors:${this.code}`,
      title: this.title,
      status: this.status,
      detail: this.detail,
      instance,
      errors: this.errors,
    };
  }
}

/** 401 — missing/invalid API key. */
export class AuthenticationError extends DomainError {
  constructor(detail: string) {
    super({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'Authentication required',
      detail,
    });
  }
}

/** 403 — authenticated but not permitted for this resource. */
export class ForbiddenError extends DomainError {
  constructor(detail: string) {
    super({
      status: 403,
      code: 'FORBIDDEN',
      title: 'Access forbidden',
      detail,
    });
  }
}

/** 404 — resource does not exist *within the authenticated tenant*. */
export class NotFoundError extends DomainError {
  constructor(detail: string) {
    super({
      status: 404,
      code: 'NOT_FOUND',
      title: 'Resource not found',
      detail,
    });
  }
}

/** 409 — state conflict (duplicate key, name collision, etc.). */
export class ConflictError extends DomainError {
  constructor(detail: string) {
    super({
      status: 409,
      code: 'CONFLICT',
      title: 'Request conflicts with current state',
      detail,
    });
  }
}

/** 400 — request shape violates the DTO schema. */
export class ValidationError extends DomainError {
  constructor(
    errors: ReadonlyArray<{ path: string; message: string; code?: string }>,
  ) {
    super({
      status: 400,
      code: 'VALIDATION_FAILED',
      title: 'Request validation failed',
      detail: 'One or more request fields failed schema validation.',
      errors,
    });
  }

  /**
   * Convert a Zod failure into a client-safe issue list. Raw *values* are
   * deliberately dropped — echoing unvalidated input back is both an
   * information leak and a log-injection vector.
   */
  static fromZodError(error: ZodError): ValidationError {
    return new ValidationError(
      error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        code: issue.code,
      })),
    );
  }
}

/** 500 — unexpected internal failure; never leaks internals to clients. */
export class InternalError extends DomainError {
  constructor(detail: string) {
    super({
      status: 500,
      code: 'INTERNAL',
      title: 'Internal server error',
      detail,
    });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Narrow a PostgreSQL error to its SQLSTATE + constraint name without
 * relying on `instanceof` (pg errors are plain error objects).
 */
export interface PgErrorShape {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

export function asPgError(error: unknown): PgErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as PgErrorShape;
  return typeof candidate.code === 'string' ? candidate : null;
}

/** SQLSTATE 23505 — unique_violation. */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  const pgError = asPgError(error);
  if (pgError?.code !== '23505') return false;
  return constraint === undefined || pgError.constraint === constraint;
}
