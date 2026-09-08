import { Router } from 'express';
import { type Status } from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken } from '../middleware';

/**
 * `/status` and `/health` (T30).
 *
 * Phase 1's sync engine, SMB bridge and share CRUD are not wired up yet (see
 * `docs/TASKS.md` T15-T26) — so rather than fabricate share and throughput data, this
 * aggregates the state that genuinely exists today: the lock and conflict tables, and
 * whether the process itself is healthy. Every field the schema promises is present;
 * the ones with no real subsystem behind them yet report their honest zero/null value
 * instead of a placeholder.
 */
export function statusRoutes(ctx: AppContext): Router {
  const router = Router();

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
    const sharesEnabled = ctx.db.pluck<number>('SELECT count(*) FROM shares WHERE enabled = 1') ?? 0;

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
      shares: [],
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
        uptimeSeconds: Math.max(
          0,
          Math.floor(ctx.now() / 1000) - Math.floor(ctx.startedAt / 1000),
        ),
        checks: { database, migrations, httpServer, samba },
      },
    });
  });

  return router;
}
