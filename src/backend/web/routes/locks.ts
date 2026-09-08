import { Router } from 'express';
import {
  createLockRequestSchema,
  listLocksQuerySchema,
  releaseLockQuerySchema,
} from '../../../shared';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession, requireSessionOrToken } from '../middleware';

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

/** `/locks` (T30), over T24's {@link AppContext.locks}. */
export function locksRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/locks', requireSessionOrToken(ctx), (req, res) => {
    const query = listLocksQuerySchema.parse(req.query);
    ok(res, ctx.locks.list(query));
  });

  router.post('/locks', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = createLockRequestSchema.parse(req.body);
    const lock = ctx.locks.createManual(body.shareId, body);
    ok(res, lock, 201);
  });

  router.delete('/locks/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const query = releaseLockQuerySchema.parse(req.query);
    ctx.locks.release(id, {
      forced: true,
      ...(query.reason !== undefined ? { reason: query.reason } : {}),
    });
    ok(res, { acknowledged: true as const });
  });

  return router;
}
