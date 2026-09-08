import { type NextFunction, type Request, type Response } from 'express';
import { type ApiToken } from '../../shared';
import { newRequestId, withCorrelationId } from '../logging/logger';
import { type SessionRecord } from './auth';
import { type AppContext } from './context';
import { errorBody, HttpError, toHttpError } from './envelope';

/**
 * The middleware stack every route in `routes/*.ts` is mounted behind (T29).
 *
 * Kept deliberately small: a request-id/correlation wrapper, two auth guards (session
 * and session-or-token) that attach a typed principal to the request, a CSRF check for
 * mutating session routes, and one error handler that is the only place an Express
 * response gets written on failure. Nothing here reaches for a module-level singleton —
 * every guard closes over the {@link AppContext} it is given by `createApp`.
 */

export const SESSION_COOKIE_NAME = 'tnc_session';
const API_KEY_HEADER = 'x-api-key';
const CSRF_HEADER = 'x-csrf-token';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    session?: SessionRecord;
    apiToken?: ApiToken;
  }
}

/** Assigns a per-request correlation id and keeps every log line inside the handler tagged with it. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming !== undefined && incoming.length > 0 && incoming.length <= 128 ? incoming : newRequestId();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  withCorrelationId(id, next);
}

/**
 * Requires a valid session cookie. On success `req.session` is set; on failure the
 * request never reaches the handler — it falls straight to {@link errorHandler}.
 */
export function requireSession(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cookieValue = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
    if (cookieValue === undefined) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
      return;
    }
    try {
      req.session = ctx.auth.validateSession(cookieValue);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Session **or** a read-only `X-API-Key` — the mode every monitoring-friendly GET
 * endpoint uses. A session takes precedence when both are present.
 */
export function requireSessionOrToken(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const cookieValue = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
    if (cookieValue !== undefined) {
      try {
        req.session = ctx.auth.validateSession(cookieValue);
        next();
        return;
      } catch (err) {
        next(err);
        return;
      }
    }
    const apiKey = req.header(API_KEY_HEADER);
    if (apiKey === undefined || apiKey.length === 0) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
      return;
    }
    try {
      req.apiToken = ctx.auth.validateToken(apiKey);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Double-submit CSRF check for mutating session routes. Every `mutates: true` endpoint
 * in the contract is `auth: 'session'`, so this only ever runs after {@link requireSession}.
 */
export function requireCsrf(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.session === undefined) {
      next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required'));
      return;
    }
    try {
      ctx.auth.verifyCsrf(req.session, req.header(CSRF_HEADER));
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Wraps an async handler so a rejected promise reaches {@link errorHandler} instead of hanging. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

/** Sends the standard success envelope. */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

/** The one place a thrown error becomes an HTTP response. Must be mounted last. */
export function errorHandler(ctx: AppContext) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const httpErr = toHttpError(err);
    if (httpErr.status >= 500) {
      ctx.logger?.error(
        { err, requestId: req.requestId, path: req.path },
        'unhandled error in route handler',
      );
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(httpErr.status).json(errorBody(httpErr, req.requestId));
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .json(errorBody(new HttpError(404, 'NOT_FOUND', 'Unknown endpoint'), req.requestId));
}
