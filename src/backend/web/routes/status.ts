import { Router } from 'express';
import { type Status } from '../../../shared';
import { ShareStore } from '../../sync/share-store';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

/**
 * `/status` and `/health` (T30).
 *
 * Aggregates what genuinely exists: the shares and their per-share counts, the lock
 * and conflict tables, and whether the process itself is healthy. Fields with no
 * subsystem behind them yet — throughput, the server link probe — report their honest
 * zero or null rather than a placeholder.
 *
 * `shares` used to be a hardcoded empty array left over from before share CRUD existed.
 * The file browser reads its share picker from here, so the picker was permanently
 * empty and the page looked broken from the first click.
 */
/**
 * An appliance with more shares than this has other problems; the cap is here so a
 * status poll can never turn into an unbounded query.
 */
const SHARE_LIST_CAP = 200;

export function statusRoutes(ctx: AppContext): Router {
  const router = Router();
  const store = new ShareStore({ db: ctx.db, config: ctx.config });

  router.get('/status', requireSessionOrToken(ctx), (_req, res) => {
    const filesIndexed = ctx.db.pluck<number>('SELECT count(*) FROM file_index') ?? 0;
    const filesPending =
      ctx.db.pluck<number>(
        `SELECT count(*) FROM file_index WHERE state IN ('pending_push', 'pending_pull')`,
      ) ?? 0;
    const activeLocks =
      ctx.db.pluck<number>('SELECT count(*) FROM locks WHERE released_at IS NULL') ?? 0;
    const unacknowledgedConflicts =
      ctx.db.pluck<number>('SELECT count(*) FROM conflicts WHERE acknowledged = 0') ?? 0;
    const sharesEnabled =
      ctx.db.pluck<number>('SELECT count(*) FROM shares WHERE enabled = 1') ?? 0;

    const status: Status = {
      version: ctx.version,
      uptimeSeconds: Math.max(0, Math.floor(ctx.now() / 1000) - Math.floor(ctx.startedAt / 1000)),
      setupRequired: !ctx.config.getFlag<boolean>('setup.completed', false),
      serverLink: {
        reachable: false,
        dialect: null,
        signing: null,
        encryption: null,
        lastProbeAt: null,
        lastError: null,
      },
      shares: store.list(SHARE_LIST_CAP, 0).items,
      totals: {
        sharesEnabled,
        filesIndexed,
        filesPending,
        activeLocks,
        unacknowledgedConflicts,
        bytesInPerSec: 0,
        bytesOutPerSec: 0,
      },
      readOnlyReason: null,
    };
    ok(res, status);
  });

  router.get('/health', (req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const isLocal =
      remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '';
    if (!isLocal) {
      res.status(403).json({
        ok: false,
        error: { code: 'FORBIDDEN', message: '/health is reachable from localhost only' },
      });
      return;
    }

    const database = ctx.db.isOpen;
    const migrations = (ctx.db.pluck<number>('PRAGMA user_version') ?? 0) > 0;
    const httpServer = true;
    const samba = false; // T12/T13 (smb.conf generation and service control) are not wired up yet.
    const allOk = database && migrations && httpServer;

    res.status(200).json({
      ok: true,
      data: {
        status: allOk ? ('ok' as const) : ('degraded' as const),
        version: ctx.version,
        uptimeSeconds: Math.max(0, Math.floor(ctx.now() / 1000) - Math.floor(ctx.startedAt / 1000)),
        checks: { database, migrations, httpServer, samba },
      },
    });
  });

  return router;
}
