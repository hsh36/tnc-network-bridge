import { statfsSync } from 'node:fs';
import { freemem, hostname, loadavg, networkInterfaces, release, totalmem, uptime } from 'node:os';
import { Router } from 'express';
import {
  applyUpdateRequestSchema,
  type NetworkInterface,
  type SystemInfo,
  type UpdateStatus,
  updateHistoryQuerySchema,
} from '../../../shared';
import { type AppContext } from '../context';
import { ok, requireSessionOrToken, requireSession } from '../middleware';

function readDisk(mountPoint: string): SystemInfo['disks'][number] | undefined {
  try {
    const stats = statfsSync(mountPoint);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    return {
      mountPoint,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    };
  } catch {
    return undefined;
  }
}

function collectInterfaces(lan?: string, tnc?: string): NetworkInterface[] {
  const result: NetworkInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (addresses === undefined || addresses.length === 0) {
      continue;
    }
    const first = addresses[0];
    result.push({
      name,
      mac: first?.mac !== undefined && first.mac !== '00:00:00:00:00:00' ? first.mac : null,
      addresses: addresses.map((a) => a.address),
      up: !addresses.every((a) => a.internal),
      speedMbps: null,
      mtu: 1500,
      role: name === lan ? 'lan' : name === tnc ? 'tnc' : 'other',
      rxBytes: 0,
      txBytes: 0,
    });
  }
  return result;
}

/** `/system` (T30) — host facts drawn straight from `node:os`, no privileged helper involved. */
export function systemRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/system', requireSessionOrToken(ctx), (_req, res) => {
    const network = ctx.config.get('network');
    const totalBytes = totalmem();
    const freeBytes = freemem();
    const usedBytes = totalBytes - freeBytes;
    const disks = [readDisk('/')].filter((d): d is SystemInfo['disks'][number] => d !== undefined);
    const [one = 0, five = 0, fifteen = 0] = loadavg();

    const info: SystemInfo = {
      hostname: hostname(),
      version: ctx.version,
      nodeVersion: process.version,
      osRelease: release(),
      uptimeSeconds: Math.floor(uptime()),
      loadAverage: [one, five, fifteen],
      memory: {
        totalBytes,
        usedBytes,
        usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
      },
      cpuTempC: null,
      throttling: {
        underVoltageNow: false,
        underVoltageOccurred: false,
        frequencyCappedNow: false,
        throttledNow: false,
        throttledOccurred: false,
      },
      disks,
      interfaces: collectInterfaces(network.lan.interface, network.tnc.interface),
    };
    ok(res, info);
  });

  /*
   * `/update/*` — every one of these delegates to the single UpdateManager on the
   * context.
   *
   * They used to answer from literals: `/update/status` returned `lastCheckAt: null`
   * unconditionally while `/update/check` returned a fresh timestamp that it then threw
   * away. The UI polls status, so a finished check left the screen still reading "no
   * checks performed yet" — the check worked, the reporting did not.
   */
  const idleStatus = (): UpdateStatus => ({
    currentVersion: ctx.version,
    available: null,
    phase: 'idle',
    progressPct: null,
    lastCheckAt: null,
    lastError: null,
    rollbackVersion: null,
  });

  router.get('/update/status', requireSessionOrToken(ctx), (_req, res) => {
    ok(res, ctx.updates?.getStatus() ?? idleStatus());
  });

  router.post('/update/check', requireSession(ctx), (_req, res, next) => {
    if (ctx.updates === undefined) {
      ok(res, idleStatus());
      return;
    }
    ctx.updates
      .check()
      .then((status) => {
        ok(res, status);
      })
      .catch((error: unknown) => {
        // The check reached a definite negative answer — GitHub was unreachable, or
        // named a repository that does not exist. That is a result, not a server
        // fault, and the operator needs to read it: the status now carries the
        // message and a fresh `lastCheckAt`, so answering 200 with that status tells
        // the truth where a 500 would only say "something went wrong".
        ctx.logger?.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'update check failed',
        );
        if (ctx.updates === undefined) {
          next(error);
          return;
        }
        ok(res, ctx.updates.getStatus());
      });
  });

  router.post('/update/apply', requireSession(ctx), (req, res, next) => {
    if (ctx.updates === undefined) {
      next(new Error('Updates are not available on this instance'));
      return;
    }
    const body = applyUpdateRequestSchema.parse(req.body ?? {});
    // Accepted, not awaited: applying takes minutes and ends in a restart that would
    // never let the response out. Progress reaches the UI over SSE.
    void ctx.updates.apply(body.version).catch((error: unknown) => {
      ctx.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'update apply failed',
      );
    });
    ok(res, { accepted: true });
  });

  router.post('/update/rollback', requireSession(ctx), (_req, res, next) => {
    if (ctx.updates === undefined) {
      next(new Error('Updates are not available on this instance'));
      return;
    }
    void ctx.updates.rollback().catch((error: unknown) => {
      ctx.logger?.error(
        { error: error instanceof Error ? error.message : String(error) },
        'update rollback failed',
      );
    });
    ok(res, { accepted: true });
  });

  router.get('/update/history', requireSessionOrToken(ctx), (req, res) => {
    const query = updateHistoryQuerySchema.parse(req.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const page = ctx.updates?.getHistory(limit, offset) ?? { items: [], total: 0 };
    ok(res, { items: page.items, total: page.total, offset, limit });
  });

  return router;
}
