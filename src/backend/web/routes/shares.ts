import { Router } from 'express';

import {
  createShareRequestSchema,
  paginationQuerySchema,
  shareActionSchema,
  updateShareRequestSchema,
} from '../../../shared';
import { ShareError, ShareStore } from '../../sync/share-store';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession, requireSessionOrToken } from '../middleware';

/**
 * `/shares` — the bridge's central object: one server export, mirrored into a local
 * cache, re-served to the machines.
 *
 * CRUD is real; actions are not. The sync orchestrator is not yet part of the running
 * service, so `scan`, `resync`, `mount` and the rest answer 503 rather than the
 * contract's `{accepted: true, operationId}` — that shape promises queued work the
 * caller can follow on the event stream, and answering it while doing nothing would
 * leave the UI waiting forever for a scan that never starts.
 */

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

function toHttp(error: unknown): unknown {
  if (error instanceof ShareError) {
    return error.kind === 'not_found'
      ? new HttpError(404, 'NOT_FOUND', error.message)
      : new HttpError(409, 'CONFLICT', error.message);
  }
  return error;
}

export function sharesRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ShareStore({ db: ctx.db, config: ctx.config });

  router.get('/shares', requireSessionOrToken(ctx), (req, res) => {
    const { limit, offset } = paginationQuerySchema.parse(req.query);
    const { items, total } = store.list(limit, offset);
    ok(res, { items, total, limit, offset });
  });

  router.post('/shares', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = createShareRequestSchema.parse(req.body);
    try {
      const share = store.create(body);
      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.create',
        target: share.name,
        detail: `serverUnc=${share.serverUnc}`,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      ok(res, share, 201);
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.get('/shares/:id', requireSessionOrToken(ctx), (req, res) => {
    try {
      ok(res, store.get(idParam(req.params.id)));
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.patch('/shares/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const body = updateShareRequestSchema.parse(req.body);
    try {
      const share = store.update(id, body);
      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.update',
        target: share.name,
        detail: Object.keys(body).join(', '),
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      ok(res, share);
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.delete('/shares/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    try {
      const share = store.get(id);
      store.delete(id);
      ctx.audit?.record({
        actor: 'admin',
        action: 'shares.delete',
        target: share.name,
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      ok(res, { acknowledged: true as const });
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.post('/shares/:id/:action', requireSession(ctx), requireCsrf(ctx), (req) => {
    const id = idParam(req.params.id);
    const action = shareActionSchema.parse(req.params.action);
    try {
      // Resolve the share first, so an action against a share that does not exist is
      // still a 404 rather than being masked by the 503 below.
      const share = store.get(id);
      ctx.audit?.record({
        actor: 'admin',
        action: `shares.${action}`,
        target: share.name,
        result: 'denied',
        detail: 'the sync orchestrator is not running in this build',
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      // The contract's success shape is `{accepted: true, operationId}` — a promise
      // that work was queued and can be followed on the event stream. Nothing was
      // queued, so answering 200 with that shape would leave the UI waiting for a scan
      // that is never going to start. 503 says what is actually true.
      throw new HttpError(
        503,
        'SERVICE_UNAVAILABLE',
        `Share actions need the sync engine, which is not running in this build (requested: ${action})`,
      );
    } catch (error) {
      throw toHttp(error);
    }
  });

  return router;
}
