import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type VersioningConfig } from '../../shared';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { AuditLog, installAuditGuards } from '../security/audit-log';
import { BlobStore } from './blob-store';
import { VersionCleanup, formatBytes } from './cleanup';
import { VersionStore } from './version-store';

const DAY = 86_400;
const NOW = 1_700_000_000;

let db: Db;
let blobs: BlobStore;
let versions: VersionStore;
let cleanup: VersionCleanup;
let cacheRoot: string;
let shareId: number;
let clock: number;
let policy: VersioningConfig;

async function capture(relPath: string, content: string, ageDays = 0): Promise<number> {
  const absolute = join(cacheRoot, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
  clock = NOW - ageDays * DAY;
  const { version } = await versions.capture({
    shareId,
    relPath,
    sourcePath: absolute,
    origin: 'server',
  });
  return version.id;
}

beforeEach(async () => {
  db = tmpDb();
  runMigrations(db);
  installAuditGuards(db);
  clock = NOW;
  policy = { enabled: true, keepCount: 3, keepDays: 30, maxStoreGb: 10 };

  const base = tmpDir('tnc-cleanup-');
  cacheRoot = join(base, 'cache');
  await mkdir(cacheRoot, { recursive: true });
  blobs = new BlobStore({ root: join(base, 'versions') });
  versions = new VersionStore({ db, blobs, now: () => clock });
  cleanup = new VersionCleanup({ versions, policy: () => policy });

  shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', @cache, @now, @now)`,
      { now: NOW, cache: cacheRoot },
    ).lastInsertRowid,
  );
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('formatBytes', () => {
  it('scales through units', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('dryRun', () => {
  it('plans deletions without performing them', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }

    const report = cleanup.dryRun(NOW);

    expect(report.plan.prune.length).toBeGreaterThan(0);
    // Nothing actually removed.
    expect(versions.list({ shareId }).total).toBe(6);
  });

  it('excludes blobs still shared with a surviving version from the byte estimate', async () => {
    // Five captures of identical content: one blob, five rows.
    for (let i = 0; i < 5; i += 1) {
      await capture('P.H', 'IDENTICAL', 5 - i);
    }

    const report = cleanup.dryRun(NOW);

    // keepCount 3 of 5 leaves 2 to prune — and they free nothing at all, because the
    // three survivors still reference the single shared blob. Summing the pruned rows'
    // sizes instead would report a saving that never materialises.
    expect(report.plan.prune.length).toBe(2);
    expect(report.estimatedBytesFreed).toBe(0);
  });

  it('counts bytes for a blob whose every referencing row is pruned', async () => {
    await capture('P.H', 'NEWEST', 0);
    await capture('P.H', 'SECOND', 1);
    await capture('P.H', 'THIRD', 2);
    await capture('P.H', 'UNIQUE-OLD-CONTENT', 100);

    const report = cleanup.dryRun(NOW);

    expect(report.estimatedBytesFreed).toBe('UNIQUE-OLD-CONTENT'.length);
  });
});

describe('run', () => {
  it('deletes versions beyond the keep count', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `VERSION-${String(i)}`, 6 - i);
    }

    const report = await cleanup.run(NOW);

    expect(report.skipped).toBe(false);
    expect(report.versionsDeleted).toBe(3);
    expect(versions.list({ shareId }).total).toBe(3);
  });

  it('never deletes a pinned version', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(await capture('P.H', `V${String(i)}`, 6 - i));
    }
    // Pin the oldest, which the count rule would otherwise remove first.
    versions.setPinned(ids[0]!, true);

    await cleanup.run(NOW);

    expect(versions.get(ids[0]!)).toBeDefined();
  });

  it('never deletes a version a conflict points at', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(await capture('P.H', `V${String(i)}`, 6 - i));
    }
    db.run(
      `INSERT INTO conflicts (ts, share_id, rel_path, mode_applied, winner, loser_version_id)
       VALUES (@ts, @shareId, 'P.H', 'last_write_wins', 'remote', @versionId)`,
      { ts: NOW, shareId, versionId: ids[0]! },
    );

    await cleanup.run(NOW);

    // A conflict pointing at content nobody can inspect defeats the point of logging it.
    expect(versions.get(ids[0]!)).toBeDefined();
  });

  it('always keeps the newest version of a path, however old', async () => {
    const id = await capture('DORMANT.H', 'UNTOUCHED FOR A YEAR', 400);

    await cleanup.run(NOW);

    expect(versions.get(id)).toBeDefined();
  });

  it('keeps the blob while another version still shares its content', async () => {
    for (let i = 0; i < 5; i += 1) {
      await capture('P.H', 'IDENTICAL', 5 - i);
    }
    const survivingHash = versions.list({ shareId }).items[0]!.hash;

    const report = await cleanup.run(NOW);

    expect(report.versionsDeleted).toBe(2);
    expect(report.blobsDeleted).toBe(0);
    expect(report.bytesFreed).toBe(0);
    await expect(blobs.has(survivingHash)).resolves.toBe(true);
  });

  it('does nothing when versioning is disabled', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }
    policy = { ...policy, enabled: false };

    const report = await cleanup.run(NOW);

    expect(report.skipped).toBe(true);
    expect(report.versionsDeleted).toBe(0);
    expect(versions.list({ shareId }).total).toBe(6);
  });

  it('reads the policy fresh on each run', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }
    policy = { ...policy, keepCount: 10, keepDays: 0 };

    const first = await cleanup.run(NOW);
    expect(first.versionsDeleted).toBe(0);

    policy = { ...policy, keepCount: 2 };
    const second = await cleanup.run(NOW);
    expect(second.versionsDeleted).toBeGreaterThan(0);
  });

  it('records the pass in the audit log', async () => {
    const audit = new AuditLog(db, undefined, () => NOW);
    const audited = new VersionCleanup({ versions, policy: () => policy, audit });
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }

    await audited.run(NOW);

    const entries = audit.query({ action: 'version.prune' });
    expect(entries.total).toBe(1);
    expect(entries.items[0]?.detail).toMatch(/versions/);
  });

  it('scopes to one share when a target says so', async () => {
    const other = Number(
      db.run(
        `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
         VALUES ('other', '//fs/x$', '/mnt/other', '/srv/other', @now, @now)`,
        { now: NOW },
      ).lastInsertRowid,
    );
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }
    // Six versions on the other share, which must be untouched.
    for (let i = 0; i < 6; i += 1) {
      db.run(
        `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at, pinned)
         VALUES (@shareId, 'Q.H', @hash, 10, 0, 'server', @createdAt, 0)`,
        { shareId: other, hash: String(i).padStart(64, '0'), createdAt: NOW - i * DAY },
      );
    }

    await cleanup.run(NOW, shareId);

    expect(versions.list({ shareId: other }).total).toBe(6);
  });

  it('continues past a failing deletion rather than blocking all future pruning', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }
    const original = versions.delete.bind(versions);
    let calls = 0;
    const failing = new VersionCleanup({
      versions: Object.assign(Object.create(Object.getPrototypeOf(versions) as object), versions, {
        delete: async (id: number) => {
          calls += 1;
          if (calls === 1) {
            throw new Error('blob is unreadable');
          }
          return original(id);
        },
      }) as VersionStore,
      policy: () => policy,
    });

    const report = await failing.run(NOW);

    // One failure recorded, the rest still processed.
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toBe('blob is unreadable');
    expect(report.versionsDeleted).toBe(2);
  });
});

describe('sweepOrphans', () => {
  it('removes a blob no version row references', async () => {
    await capture('P.H', 'REFERENCED');
    const orphan = await blobs.putBuffer(Buffer.from('WRITTEN BUT NEVER RECORDED'));

    const result = await cleanup.sweepOrphans();

    expect(result.deleted).toBe(1);
    expect(result.bytesFreed).toBe('WRITTEN BUT NEVER RECORDED'.length);
    await expect(blobs.has(orphan.hash)).resolves.toBe(false);
  });

  it('leaves every referenced blob alone', async () => {
    await capture('A.H', 'ONE');
    await capture('B.H', 'TWO');

    const result = await cleanup.sweepOrphans();

    expect(result.deleted).toBe(0);
    await expect(blobs.stats()).resolves.toMatchObject({ blobs: 2 });
  });

  it('is a no-op on an empty store', async () => {
    await expect(cleanup.sweepOrphans()).resolves.toEqual({ deleted: 0, bytesFreed: 0 });
  });
});

describe('asJobHandler', () => {
  const ctx = (over: Record<string, unknown> = {}) =>
    ({
      trigger: 'cron' as const,
      scheduleId: 1,
      scheduleName: 'nightly prune',
      target: null,
      firedAt: NOW,
      ...over,
    }) as Parameters<ReturnType<VersionCleanup['asJobHandler']>>[0];

  it('reports what it freed', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `VERSION-${String(i)}`, 6 - i);
    }

    const outcome = await cleanup.asJobHandler()(ctx());

    expect(outcome.detail).toMatch(/3 versions/);
    expect(outcome.skipped).toBeUndefined();
  });

  it('distinguishes "nothing to prune" from a skip', async () => {
    await capture('P.H', 'ONLY ONE');

    const outcome = await cleanup.asJobHandler()(ctx());

    expect(outcome.detail).toBe('nothing to prune');
    expect(outcome.skipped).toBeUndefined();
  });

  it('reports a skip when versioning is disabled', async () => {
    policy = { ...policy, enabled: false };

    const outcome = await cleanup.asJobHandler()(ctx());

    expect(outcome.skipped).toBe(true);
    expect(outcome.detail).toBe('versioning is disabled');
  });

  it('honours a share-scoped target', async () => {
    for (let i = 0; i < 6; i += 1) {
      await capture('P.H', `V${String(i)}`, 6 - i);
    }

    const outcome = await cleanup.asJobHandler()(ctx({ target: { shareId } }));

    expect(outcome.detail).toMatch(/versions/);
  });
});
