import { Router } from 'express';
import {
  createScheduleRequestSchema,
  listSchedulesQuerySchema,
  updateScheduleRequestSchema,
} from '../../../shared';
import { InvalidCronError, ScheduleNotFoundError, previewRuns } from '../../scheduling/scheduler';
import { isManagedSchedule } from '../../system/managed-schedules';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import {
  asyncHandler,
  ok,
  requireCsrf,
  requireSession,
  requireSessionOrToken,
} from '../middleware';

/** `/schedules` (T36/T37), over {@link AppContext.schedules}. */

function idParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a positive integer id');
  }
  return n;
}

function toHttp(err: unknown): unknown {
  if (err instanceof ScheduleNotFoundError) {
    return new HttpError(404, 'NOT_FOUND', err.message);
  }
  if (err instanceof InvalidCronError) {
    // A cron the parser rejects is a user mistake in a form field, not a server fault.
    return new HttpError(400, 'VALIDATION_FAILED', err.message, [
      { path: 'cron', message: err.message },
    ]);
  }
  return err;
}

export function schedulesRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/schedules', requireSessionOrToken(ctx), (req, res) => {
    const query = listSchedulesQuerySchema.parse(req.query);
    const page = ctx.schedules.list({
      ...(query.kind !== undefined ? { kind: query.kind } : {}),
      ...(query.enabled !== undefined ? { enabled: query.enabled } : {}),
      limit: query.limit,
      offset: query.offset,
    });
    ok(res, { items: page.items, total: page.total, limit: query.limit, offset: query.offset });
  });

  router.post('/schedules', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = createScheduleRequestSchema.parse(req.body);
    try {
      ok(res, ctx.schedules.create(body), 201);
    } catch (err) {
      throw toHttp(err);
    }
  });

  /**
   * Preview the next occurrences of an expression without saving it.
   *
   * The single most useful thing a scheduling UI can do is show an operator when their
   * expression will actually fire, *before* they commit to it — "0 0 30 2 *" looks
   * perfectly reasonable and never runs.
   */
  router.post('/schedules/preview', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const body = req.body as { cron?: unknown };
    if (typeof body.cron !== 'string') {
      throw new HttpError(400, 'VALIDATION_FAILED', 'Expected a cron expression', [
        { path: 'cron', message: 'Required' },
      ]);
    }
    try {
      const runs = previewRuns(body.cron, 5);
      ok(res, { cron: body.cron, nextRuns: runs.map((d) => Math.floor(d.getTime() / 1000)) });
    } catch (err) {
      throw toHttp(err);
    }
  });

  router.get('/schedules/:id', requireSessionOrToken(ctx), (req, res) => {
    const id = idParam(req.params.id);
    try {
      ok(res, ctx.schedules.require(id));
    } catch (err) {
      throw toHttp(err);
    }
  });

  router.patch('/schedules/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    const body = updateScheduleRequestSchema.parse(req.body);
    try {
      refuseIfManaged(ctx.schedules.require(id).name);
      ok(res, ctx.schedules.update(id, body));
    } catch (err) {
      throw toHttp(err);
    }
  });

  router.delete('/schedules/:id', requireSession(ctx), requireCsrf(ctx), (req, res) => {
    const id = idParam(req.params.id);
    try {
      refuseIfManaged(ctx.schedules.require(id).name);
      ctx.schedules.delete(id);
      ok(res, { acknowledged: true as const });
    } catch (err) {
      throw toHttp(err);
    }
  });

  /**
   * Runs a schedule immediately. Used by the UI's "test this now" button.
   *
   * Deliberately *not* guarded against managed schedules: running one by hand is
   * exactly what an operator should be able to do from here. What they cannot do is
   * change when it runs, because that value lives elsewhere.
   */
  router.post(
    '/schedules/:id/run',
    requireSession(ctx),
    requireCsrf(ctx),
    asyncHandler(async (req, res) => {
      const id = idParam(req.params.id);
      try {
        ctx.schedules.require(id);
        const result = await ctx.schedules.execute(id, 'manual');
        ok(res, { accepted: true as const, result });
      } catch (err) {
        throw toHttp(err);
      }
    }),
  );

  return router;
}

/**
 * Managed schedules are projections of the update config, and reconciled from it.
 *
 * Editing one here would change a value the next reconcile overwrites — silently, and
 * probably minutes later. Refusing and naming the real setting is the honest answer;
 * accepting the edit and quietly reverting it is how an operator concludes the
 * schedule page does not work.
 */
function refuseIfManaged(name: string): void {
  if (isManagedSchedule(name)) {
    throw new HttpError(
      409,
      'CONFLICT',
      `"${name}" is configured under Settings > Updates and cannot be edited here`,
    );
  }
}
