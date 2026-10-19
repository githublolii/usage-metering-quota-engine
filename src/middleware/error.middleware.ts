import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { isDomainError, ValidationError } from '../domain/errors.js';

/**
 * Central RFC 7807 error handler.
 *
 * Exactly ONE place maps errors → HTTP responses:
 *   - DomainError        → its own status + problem+json
 *   - ZodError           → 400 validation problem+json (defensive; the
 *                          validate middleware normally converts these)
 *   - anything else      → 500 with a generic body (never leaks stacks,
 *                          SQL, or file paths to clients) + server-side log
 */

/** Wrap an async handler so rejections reach the error middleware. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** 404 for unmatched routes — same problem+json shape as everything else. */
export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  res.status(404).json({
    type: 'urn:quota-engine:errors:NOT_FOUND',
    title: 'Resource not found',
    status: 404,
    detail: `No route matches ${req.method} ${req.originalUrl}`,
    instance: req.originalUrl,
  });
}

export function problemDetailsHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Headers already sent: the only correct move is to tear down the socket.
  if (res.headersSent) {
    res.destroy();
    return;
  }

  if (isDomainError(error)) {
    const status = error.status;
    if (status >= 500) {
      console.error(
        `[http] ${status} ${req.method} ${req.originalUrl}: ${error.detail ?? error.title}`,
      );
    } else {
      console.warn(
        `[http] ${status} ${req.method} ${req.originalUrl}: ${error.detail ?? error.title}`,
      );
    }
    res
      .status(status)
      .contentType('application/problem+json')
      .json(error.toProblemDetails(req.originalUrl));
    return;
  }

  // Malformed JSON bodies: body-parser attaches status 400 + type
  // 'entity.parse.failed' to its SyntaxError. Surface it as a proper 400
  // problem+json instead of an opaque 500.
  if (
    error instanceof SyntaxError &&
    (error as SyntaxError & { status?: number; type?: string }).status === 400
  ) {
    res.status(400).contentType('application/problem+json').json({
      type: 'urn:quota-engine:errors:VALIDATION_FAILED',
      title: 'Malformed request body',
      status: 400,
      detail: 'The request body is not valid JSON.',
      instance: req.originalUrl,
    });
    return;
  }

  if (error instanceof ZodError) {
    const validationError = ValidationError.fromZodError(error);
    console.warn(
      `[http] 400 ${req.method} ${req.originalUrl}: request body failed schema validation`,
    );
    res
      .status(400)
      .contentType('application/problem+json')
      .json(validationError.toProblemDetails(req.originalUrl));
    return;
  }

  // Unknown/unexpected: log loudly, respond generically.
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(
    `[http] 500 ${req.method} ${req.originalUrl}: unhandled ${message}\n${stack ?? '(no stack)'}`,
  );
  res
    .status(500)
    .contentType('application/problem+json')
    .json({
      type: 'urn:quota-engine:errors:INTERNAL',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected internal error occurred.',
      instance: req.originalUrl,
    });
}
