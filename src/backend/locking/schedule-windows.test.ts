import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { ConfigManager } from '../config/config-manager';
import { JobRegistry, type JobContext } from '../scheduling/jobs';
import { Scheduler } from '../scheduling/scheduler';
import { LockManager } from './lock-manager';
import { ScheduleLockWindowManager } from './schedule-windows';

let db: Db;
let config: ConfigManager;
let locks: LockManager;
let scheduler: Scheduler;
let manager: ScheduleLockWindowManager;
let clock: number;
let jobs: JobRegistry;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  config = new ConfigManager(db);
  clock = 1_700_000_000;
  locks = new LockManager({ db, config, now: () => clock });
  jobs = new JobRegistry();
  scheduler = new Scheduler({ db, jobs, now: () => clock });

  // Instantiate the manager, which registers the handlers
  manager = new ScheduleLockWindowManager({ db, locks, scheduler });

  // Create a test share
  db.run(
    `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
     VALUES (@name, @unc, @mount, @cache, @now, @now)`,
    {
      name: 'test-share',
      unc: '//server/share$',
      mount: '/mnt/test-share',
      cache: '/srv/tnc/test-share',
      now: clock,
    },
  );

  // Insert test files
  const shareId = 1;
  const files = [
    'programs/part1.H',
    'programs/part2.H',
    'programs/folder/part3.H',
    'data/log.txt',
    'readme.md',
  ];

  for (const relPath of files) {
    db.run(
      `INSERT INTO file_index (share_id, rel_path, rel_path_ci)
       VALUES (@shareId, @relPath, @relPathCi)`,
      {
        shareId,
        relPath,
        relPathCi: relPath.toLowerCase(),
      },
    );
  }
});

afterEach(async () => {
  await scheduler.stop();
  cleanupTmpDbs();
});

describe('ScheduleLockWindowManager', () => {
  describe('lock window', () => {
    it('acquires locks on matching paths', async () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly lock',
        target: { shareId: 1, pathGlob: '**/*.H' },
        firedAt: clock,
      };

      const outcome = manager['handleLockWindow'](ctx);

      // Should have locked the three .H files
      expect(outcome?.detail).toContain('locked 3 paths');

      // Verify the locks exist
      const activeLocks = db.all(
        `SELECT rel_path FROM locks WHERE share_id = 1 AND released_at IS NULL ORDER BY rel_path`,
      );
      expect(activeLocks).toHaveLength(3);
      expect(activeLocks.map((l: { rel_path: string }) => l.rel_path)).toEqual([
        'programs/folder/part3.H',
        'programs/part1.H',
        'programs/part2.H',
      ]);
    });

    it('skips paths already locked by TNC', () => {
      // Pre-lock a file as if a TNC acquired it
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part1.H',
        origin: 'tnc',
        tncIp: '192.168.1.100',
        ownerLabel: 'TNC-640-Halle1',
      });

      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly lock',
        target: { shareId: 1, pathGlob: '**/*.H' },
        firedAt: clock,
      };

      const outcome = manager['handleLockWindow'](ctx);

      // The SQL query excludes already-locked files, so only 2 of 3 .H files are attempted
      expect(outcome?.detail).toContain('locked 2 paths');

      // Verify the TNC lock is still there
      const tnclocks = db.all(
        `SELECT id, origin FROM locks WHERE rel_path = 'programs/part1.H' AND released_at IS NULL`,
      );
      expect(tnclocks).toHaveLength(1);
      expect((tnclocks[0] as { origin: string }).origin).toBe('tnc');
    });

    it('respects durationMinutes for TTL', () => {
      const durationMinutes = 480; // 8 hours
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly lock',
        target: { shareId: 1, pathGlob: 'programs/*.H', durationMinutes },
        firedAt: clock,
      };

      manager['handleLockWindow'](ctx);

      // Check that the locks have an expiration time
      const locks_rows = db.all(
        `SELECT expires_at FROM locks WHERE share_id = 1 AND released_at IS NULL`,
      );
      for (const lock of locks_rows) {
        const expiresAt = (lock as { expires_at: number }).expires_at;
        expect(expiresAt).toBe(clock + durationMinutes * 60);
      }
    });

    it('handles missing share gracefully', () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly lock',
        target: { shareId: 999, pathGlob: '**/*.H' },
        firedAt: clock,
      };

      const outcome = manager['handleLockWindow'](ctx);

      expect(outcome?.skipped).toBe(true);
      expect(outcome?.detail).toContain('share 999 not found');
    });

    it('handles missing target gracefully', () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly lock',
        target: null,
        firedAt: clock,
      };

      const outcome = manager['handleLockWindow'](ctx);

      expect(outcome?.skipped).toBe(true);
    });
  });

  describe('unlock window', () => {
    it('releases scheduled locks', () => {
      // Create some scheduled locks
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part1.H',
        origin: 'schedule',
        ownerLabel: 'Schedule 1',
      });
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part2.H',
        origin: 'schedule',
        ownerLabel: 'Schedule 1',
      });

      // Verify they're locked
      expect(
        db.pluck(`SELECT count(*) FROM locks WHERE share_id = 1 AND released_at IS NULL`),
      ).toBe(2);

      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: { shareId: 1 },
        firedAt: clock + 3600,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.detail).toContain('released 2 locks');

      // Verify they're released
      expect(
        db.pluck(`SELECT count(*) FROM locks WHERE share_id = 1 AND released_at IS NULL`),
      ).toBe(0);
    });

    it('does not release TNC locks', () => {
      // Create a TNC lock and a scheduled lock on the same share
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part1.H',
        origin: 'tnc',
        tncIp: '192.168.1.100',
        ownerLabel: 'TNC-640',
      });
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part2.H',
        origin: 'schedule',
        ownerLabel: 'Schedule 1',
      });

      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: { shareId: 1 },
        firedAt: clock + 3600,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.detail).toContain('released 1 locks');

      // Verify only the scheduled lock was released
      const remaining = db.all(
        `SELECT origin FROM locks WHERE share_id = 1 AND released_at IS NULL`,
      );
      expect(remaining).toHaveLength(1);
      expect((remaining[0] as { origin: string }).origin).toBe('tnc');
    });

    it('does not release manual locks', () => {
      // Create a manual lock and a scheduled lock
      locks.createManual(1, {
        relPath: 'programs/part1.H',
        note: 'operator lock',
      });
      locks.acquire({
        shareId: 1,
        relPath: 'programs/part2.H',
        origin: 'schedule',
        ownerLabel: 'Schedule 1',
      });

      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: { shareId: 1 },
        firedAt: clock + 3600,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.detail).toContain('released 1 locks');

      // Verify only the scheduled lock was released
      const remaining = db.all(
        `SELECT origin FROM locks WHERE share_id = 1 AND released_at IS NULL`,
      );
      expect(remaining).toHaveLength(1);
      expect((remaining[0] as { origin: string }).origin).toBe('manual');
    });

    it('handles missing target share gracefully', () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: { shareId: 999 },
        firedAt: clock,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.skipped).toBe(true);
    });

    it('handles missing target gracefully', () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: null,
        firedAt: clock,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.skipped).toBe(true);
    });

    it('returns detail when no locks to release', () => {
      const ctx: JobContext = {
        trigger: 'cron',
        scheduleId: 1,
        scheduleName: 'nightly unlock',
        target: { shareId: 1 },
        firedAt: clock,
      };

      const outcome = manager['handleUnlockWindow'](ctx);

      expect(outcome?.detail).toContain('no scheduled locks');
    });
  });

  describe('integration with scheduler', () => {
    it('registers lock handler with job registry', () => {
      expect(jobs.has('lock')).toBe(true);
      expect(jobs.get('lock')).toBeDefined();
    });

    it('registers unlock handler with job registry', () => {
      expect(jobs.has('unlock')).toBe(true);
      expect(jobs.get('unlock')).toBeDefined();
    });

    it('handlers are callable via scheduler', async () => {
      // Create a schedule and verify we can execute it
      await scheduler.start();

      locks.acquire({
        shareId: 1,
        relPath: 'programs/part1.H',
        origin: 'schedule',
        ownerLabel: 'Schedule 1',
      });

      const schedule = scheduler.create({
        name: 'test unlock',
        kind: 'unlock',
        cron: '0 3 * * *',
        target: { shareId: 1 },
        enabled: true,
      });

      const result = await scheduler.execute(schedule.id, 'manual');
      expect(result).toBe('ok');

      // Verify the lock was released
      expect(
        db.pluck(`SELECT count(*) FROM locks WHERE share_id = 1 AND released_at IS NULL`),
      ).toBe(0);

      await scheduler.stop();
    });
  });
});
