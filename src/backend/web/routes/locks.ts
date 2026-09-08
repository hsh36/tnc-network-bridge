import { Router } from 'express';
import {
  createLockRequestSchema,
  listLocksQuerySchema,
  releaseLockQuerySchema,
} from '../../../shared';
import { type AppContext } from '../context';
import { HttpError } from '../envelope';
import { ok, requireCsrf, requireSession, requireSessionOrToken } from '../middleware';
import { previewRuns } from '../../scheduling/scheduler';

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

  /**
   * Get a preview of upcoming lock/unlock schedule windows (T42).
   *
   * Shows what scheduled locks are expected to be active in the next `days` days,
   * grouped by share. The response includes when each lock window starts and when
   * it is expected to end.
   *
   * Query params:
   * - `days`: Number of days to look ahead (default 7, max 90)
   * - `share`: Optional share ID to filter to one share
   */
  router.get('/locks/schedule/preview', requireSessionOrToken(ctx), (req, res) => {
    const days = Math.min(Number(req.query.days ?? 7), 90);
    const shareFilter = req.query.share ? Number(req.query.share) : undefined;

    if (!Number.isInteger(days) || days < 1) {
      throw new HttpError(400, 'VALIDATION_FAILED', 'days must be a positive integer');
    }

    // Get all lock/unlock schedules that are enabled
    const { items: schedules } = ctx.schedules.list({
      kind: 'lock',
      enabled: true,
      limit: 1000,
    });
    const { items: unlockSchedules } = ctx.schedules.list({
      kind: 'unlock',
      enabled: true,
      limit: 1000,
    });

    const allSchedules = [...schedules, ...unlockSchedules];
    const now = ctx.now();
    const cutoff = now + days * 86_400;

    const windows = allSchedules
      .filter((s) => {
        if (shareFilter !== undefined && s.target?.shareId !== shareFilter) {
          return false;
        }
        return s.target?.shareId !== undefined;
      })
      .map((schedule) => {
        // Generate the next occurrence within our window
        const runs = previewRuns(schedule.cron, 10);

        return runs
          .filter((date: Date) => {
            const ts = Math.floor(date.getTime() / 1000);
            return ts > now && ts <= cutoff;
          })
          .map((date: Date) => {
            const ts = Math.floor(date.getTime() / 1000);
            const durationSeconds =
              schedule.kind === 'lock' && schedule.target?.durationMinutes
                ? schedule.target.durationMinutes * 60
                : 3600; // Default 1 hour if not specified
            return {
              scheduleId: schedule.id,
              scheduleName: schedule.name,
              kind: schedule.kind as 'lock' | 'unlock',
              shareId: schedule.target?.shareId ?? 0,
              pathGlob: schedule.target?.pathGlob,
              startsAt: ts,
              endsAt: schedule.kind === 'lock' ? ts + durationSeconds : null,
            };
          });
      })
      .flat()
      .sort((a, b) => a.startsAt - b.startsAt);

    ok(res, { windows, days, count: windows.length });
  });

  return router;
}
