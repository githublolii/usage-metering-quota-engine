import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { ValidationError } from '../domain/errors.js';

/**
 * Generic Zod DTO validator.
 *
 * Usage:
 *   router.post('/', validate({ body: ConsumeSchema }), handler)
 *   router.get('/', validate({ query: UsageQuerySchema }), handler)
 *   router.patch('/:id', validate({ params: PlanIdParamsSchema, body: … }), handler)
 *
 * On success the parsed (and `.strict()`-enforced, coerced, trimmed) value
 * replaces `req.body` / `req.validatedQuery` / `req.validatedParams`. On
 * failure the request dies right here with a 400 problem+json — controllers
 * can assume valid shapes.
 */
export function validate(schemas: {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}): (req: Request, _res: Response, next: NextFunction) => void {
  return (req, _res, next) => {
    try {
      if (schemas.body !== undefined) {
        req.body = schemas.body.parse(req.body ?? {});
      }
      if (schemas.query !== undefined) {
        req.validatedQuery = schemas.query.parse(req.query);
      }
      if (schemas.params !== undefined) {
        req.validatedParams = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(ValidationError.fromZodError(error));
        return;
      }
      next(error);
    }
  };
}
