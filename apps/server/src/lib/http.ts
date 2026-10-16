import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodType } from 'zod';

export class HttpError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500, message: string, readonly details?: unknown, readonly retryAfterSec?: number) {
    super(status, { message });
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = 'Not signed in') => new HttpError(401, msg);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

/** zod validator with a consistent 400 error body. */
export function validate<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        { error: 'Invalid input', issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
        400,
      );
    }
    return undefined;
  });
}
