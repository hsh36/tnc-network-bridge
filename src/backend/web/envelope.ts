import { type ZodError } from 'zod';
import { type ApiErrorCode, type FieldError } from '../../shared';
import {
  AuthError,
  InvalidCredentialsError,
  InvalidCsrfError,
  InvalidTokenError,
  RateLimitedError,
  SessionExpiredError,
} from './auth';
import { ConfigError, ConfigValidationError } from '../config/config-manager';
import { CertificateError } from './https-setup';
import { LockError, LockHeldError, LockNotFoundError } from '../locking/lock-manager';
import { PrivilegedCallError } from '../privileged/client';

/**
 * Turns whatever a handler throws into the one shape every response body can be
 * (T26/T29's "error responses are actionable" AC): an HTTP status plus the
 * `apiErrorSchema` envelope, never a stack trace and never a bare Express default page.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: FieldError[],
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorBody {
  readonly ok: false;
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly details?: FieldError[];
    readonly requestId?: string;
    readonly retryAfterSeconds?: number;
  };
}

export function errorBody(err: HttpError, requestId?: string): ErrorBody {
  return {
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    },
  };
}

export function fieldErrorsFromZod(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * Maps a thrown value to an {@link HttpError}. Every specific error class this backend
 * defines is listed by name — falling through to a generic 500 is the deliberate
 * default for anything unrecognised, so a new failure mode is loud (a 500 an operator
 * notices) rather than silently mis-mapped to the wrong status code.
 */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) {
    return err;
  }
  if (err instanceof ConfigValidationError) {
    return new HttpError(
      400,
      'VALIDATION_FAILED',
      err.message,
      err.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  if (err instanceof LockHeldError) {
    return new HttpError(409, 'PATH_LOCKED', err.message);
  }
  if (err instanceof LockNotFoundError) {
    return new HttpError(404, 'NOT_FOUND', err.message);
  }
  if (err instanceof LockError) {
    return new HttpError(400, 'VALIDATION_FAILED', err.message);
  }
  if (err instanceof RateLimitedError) {
    return new HttpError(429, 'RATE_LIMITED', err.message, undefined, err.retryAfterSeconds);
  }
  if (err instanceof InvalidCredentialsError) {
    return new HttpError(401, 'INVALID_CREDENTIALS', err.message);
  }
  if (err instanceof SessionExpiredError) {
    return new HttpError(401, 'SESSION_EXPIRED', err.message);
  }
  if (err instanceof InvalidCsrfError) {
    return new HttpError(403, 'CSRF_INVALID', err.message);
  }
  if (err instanceof InvalidTokenError) {
    return new HttpError(401, 'INVALID_CREDENTIALS', err.message);
  }
  if (err instanceof AuthError) {
    return new HttpError(400, 'VALIDATION_FAILED', err.message);
  }
  if (err instanceof CertificateError) {
    return new HttpError(400, 'CERTIFICATE_INVALID', err.message);
  }
  if (err instanceof ConfigError) {
    return new HttpError(500, 'DATABASE_ERROR', err.message);
  }
  if (err instanceof PrivilegedCallError) {
    return new HttpError(500, 'PRIVILEGED_HELPER_FAILED', err.message);
  }
  if (err instanceof Error) {
    return new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
  }
  return new HttpError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}
