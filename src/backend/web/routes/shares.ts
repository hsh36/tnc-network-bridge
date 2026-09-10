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
 * Bring the running syncs in line with what was just written.
 *
 * Fire-and-forget on purpose: the caller asked to save a share, and a mount that takes
 * twenty seconds to time out must not hold their save open. Whether a share syncs is
 * decided by its `enabled` column, which is now stored — reconciliation is how that
 * becomes true, not a second thing the operator has to ask for.
 */
function reconcile(ctx: AppContext): void {
  void ctx.sync?.reconcile();
}

/**
 * `/shares` — the bridge's central object: one server export, mirrored into a local
 * cache, re-served to the machines.
 *
 * Actions act on the running supervisor. `scan` and `resync` bring the next cycle
 * forward; `pause` and `resume` suspend transfers without unmounting or losing the
 * index. `mount`/`unmount` are reconciliation in disguise — what decides whether a
 * share is mounted is whether it is enabled — so they are answered by asking the
 * supervisor to converge rather than by poking the mount directly.
 */

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

/** Maps a share action onto the supervisor. Returns false when the share is not running. */
function runAction(ctx: AppContext, shareId: number, action: string): boolean {
  const sync = ctx.sync;
  if (sync === undefined) {
    return false;
  }
  switch (action) {
    case 'pause':
      return sync.setPaused(shareId, true);
    case 'resume':
      return sync.setPaused(shareId, false);
    case 'mount':
    case 'unmount':
      // Both are "make the running state match the configuration", which is exactly
      // what reconcile does — and unlike poking the mount, it cannot leave the two
      // disagreeing.
      void sync.reconcile();
      return true;
    default:
      // scan and resync: bring the next cycle forward.
      return sync.runNow(shareId);
  }
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
      reconcile(ctx);
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
      reconcile(ctx);
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
      reconcile(ctx);
      ok(res, { acknowledged: true as const });
    } catch (error) {
      throw toHttp(error);
    }
  });

  router.post('/shares/:id/:action', requireSession(ctx), requireCsrf(ctx), (req, res) => {
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
        ...(req.ip === undefined ? {} : { ip: req.ip }),
      });
      if (ctx.sync === undefined) {
        // No supervisor means this process is not the one that syncs — a test, or the
        // dev server. Claiming the work was queued would leave the caller waiting on an
        // event stream that will never carry a result.
        throw new HttpError(
          503,
          'SERVICE_UNAVAILABLE',
          `Share actions need the sync engine, which is not running in this process (requested: ${action})`,
        );
      }

      const accepted = runAction(ctx, id, action);
      if (!accepted) {
        throw new HttpError(
          409,
          'CONFLICT',
          `"${share.name}" is not syncing. Enable the share first.`,
        );
      }
      ok(res, {
        accepted: true as const,
        operationId: `${action}-${String(id)}-${String(Date.now())}`,
      });
    } catch (error) {
      throw toHttp(error);
    }
  });

  return router;
}
