import { type ScheduleTarget } from '../../shared';
import { type Db, type DbLogger } from '../config/db';
import { type LockManager } from './lock-manager';
import { type Scheduler } from '../scheduling/scheduler';
import { type JobContext, type JobOutcome } from '../scheduling/jobs';
import { type AuditLog } from '../security/audit-log';
import picomatch from 'picomatch';

/**
 * Lock/unlock schedule windows (T42).
 *
 * When a 'lock' schedule fires, it acquires locks over all paths matching the glob
 * in the target. When an 'unlock' schedule fires, it releases them. The interaction
 * with TNC-origin locks is critical: a TNC lock always wins and must never be
 * overridden by a scheduled action.
 *
 * This class registers the 'lock' and 'unlock' job handlers on the Scheduler's
 * JobRegistry, so the two are tightly bound at composition time.
 */

export interface ScheduleLockWindowManagerOptions {
  readonly db: Db;
  readonly locks: LockManager;
  readonly scheduler: Scheduler;
  readonly logger?: DbLogger;
  readonly audit?: AuditLog;
}

export class ScheduleLockWindowManager {
  private readonly db: Db;
  private readonly locks: LockManager;
  private readonly logger: DbLogger | undefined;
  private readonly audit: AuditLog | undefined;

  constructor(options: ScheduleLockWindowManagerOptions) {
    this.db = options.db;
    this.locks = options.locks;
    this.logger = options.logger;
    this.audit = options.audit;

    // Register the job handlers with the scheduler's registry
    options.scheduler.jobs.register('lock', (ctx) => this.handleLockWindow(ctx));
    options.scheduler.jobs.register('unlock', (ctx) => this.handleUnlockWindow(ctx));
  }

  /**
   * Acquires locks when a lock schedule fires.
   *
   * The glob pattern from the target is evaluated over every file in the share to find
   * matching paths. For each match, we attempt to acquire a lock with origin='schedule'.
   * If a TNC lock already exists, we skip it (TNC wins).
   *
   * Returns a summary of how many were locked and how many were skipped due to conflicts.
   */
  private handleLockWindow(ctx: JobContext): JobOutcome | void {
    const target = ctx.target;
    if (target?.shareId === undefined || target?.pathGlob === undefined) {
      return { skipped: true, detail: 'no target or path glob specified' };
    }

    const shareId = target.shareId;
    const glob = target.pathGlob;

    // Check if the share exists
    const share = this.db.get('SELECT id FROM shares WHERE id = @id', { id: shareId });
    if (share === undefined) {
      return { skipped: true, detail: `share ${shareId} not found` };
    }

    // Fetch all files in the share that are not already locked
    const files = this.db.all<{ rel_path: string }>(
      `SELECT DISTINCT rel_path FROM file_index WHERE share_id = @shareId
       AND NOT EXISTS (
         SELECT 1 FROM locks
         WHERE locks.share_id = @shareId
         AND locks.rel_path = file_index.rel_path
         AND locks.released_at IS NULL
       )`,
      { shareId },
    );

    // Compile the glob pattern
    const matcher = picomatch(glob, { noglobstar: false });

    let locked = 0;
    let skipped = 0;

    for (const file of files) {
      if (!matcher(file.rel_path)) {
        continue;
      }

      // Check again for a TNC-origin lock (race condition safety)
      const existing = this.locks.getActive(shareId, file.rel_path);
      if (existing !== undefined) {
        // If it's a TNC lock, it always wins — skip this path
        if (existing.origin === 'tnc') {
          skipped += 1;
          this.logger?.debug(
            { shareId, relPath: file.rel_path, lockId: existing.id },
            'skipping lock window on path with active TNC lock',
          );
          continue;
        }
        // Some other lock is in place — also skip
        skipped += 1;
        continue;
      }

      // Acquire the lock
      try {
        this.locks.acquire({
          shareId,
          relPath: file.rel_path,
          origin: 'schedule',
          ownerLabel: `Schedule ${ctx.scheduleId}`,
          ttlSeconds: target.durationMinutes ? target.durationMinutes * 60 : null,
          note: `Locked by schedule window "${ctx.scheduleName}"`,
        });
        locked += 1;
      } catch (err) {
        this.logger?.warn(
          { shareId, relPath: file.rel_path, err },
          'failed to acquire scheduled lock',
        );
      }
    }

    return { detail: `locked ${locked} paths${skipped > 0 ? `, ${skipped} already held` : ''}` };
  }

  /**
   * Releases locks when an unlock schedule fires.
   *
   * Only releases locks with origin='schedule' — manual and TNC locks are left alone,
   * which is a safety measure: if an operator locks something manually, we should not
   * accidentally release it as a side effect of an automated schedule.
   *
   * We do not filter by glob here, because once a window has started, its scheduled locks
   * are already identified by origin='schedule'. The glob is only used to decide which
   * paths to lock in the first place.
   */
  private handleUnlockWindow(ctx: JobContext): JobOutcome | void {
    const target = ctx.target;
    if (target?.shareId === undefined) {
      return { skipped: true, detail: 'no target share specified' };
    }

    const shareId = target.shareId;

    // Check if the share exists
    const share = this.db.get('SELECT id FROM shares WHERE id = @id', { id: shareId });
    if (share === undefined) {
      return { skipped: true, detail: `share ${shareId} not found` };
    }

    // Fetch all active locks with origin='schedule' for this share
    const locks = this.db.all<{ id: number; rel_path: string }>(
      `SELECT id, rel_path FROM locks
       WHERE share_id = @shareId AND origin = 'schedule' AND released_at IS NULL`,
      { shareId },
    );

    let released = 0;

    for (const lock of locks) {
      try {
        this.locks.release(lock.id, {
          reason: `Released by unlock schedule window "${ctx.scheduleName}"`,
        });
        released += 1;
      } catch (err) {
        this.logger?.warn(
          { shareId, lockId: lock.id, relPath: lock.rel_path, err },
          'failed to release scheduled lock',
        );
      }
    }

    return {
      detail: released > 0 ? `released ${released} locks` : 'no scheduled locks to release',
    };
  }
}
