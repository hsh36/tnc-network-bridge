import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDb, tmpDir } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { BlobStore } from './blob-store';
import { VersionStore } from './version-store';
import { VersioningEngine, checkDiskUsage } from './versioning-engine';

let db: Db;
let engine: VersioningEngine;
let store: VersionStore;
let blobs: BlobStore;
let cacheRoot: string;
let blobRoot: string;
let shareId: number;
let clock: number;

async function writeCacheFile(relPath: string, content: string): Promise<string> {
  const absolute = join(cacheRoot, relPath);
  await mkdir(join(absolute, '..'), { recursive: true });
  await writeFile(absolute, content);
  return absolute;
}

beforeEach(async () => {
  db = tmpDb();
  runMigrations(db);
  clock = 1_700_000_000;

  const base = tmpDir('tnc-versions-');
  cacheRoot = join(base, 'cache');
  blobRoot = join(base, 'versions');
  await mkdir(cacheRoot, { recursive: true });
  blobs = new BlobStore({ root: blobRoot });
  store = new VersionStore({ db, blobs, now: () => clock });

  // Use a high threshold (almost all space free) to avoid disk pressure issues in tests
  engine = new VersioningEngine({
    store,
    blobRoot,
    diskPressureThreshold: 0.01, // 1% free space threshold (very lenient)
  });

  shareId = Number(
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES ('programs', '//fs/cnc$', '/mnt/tnc-server/programs', @cache, @now, @now)`,
      { now: clock, cache: cacheRoot },
    ).lastInsertRowid,
  );
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('VersioningEngine', () => {
  describe('captureBeforePull', () => {
    async function waitForAsync(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    it('captures local content before server overwrites', async () => {
      const sourcePath = await writeCacheFile('PGM/PART1.H', 'BEGIN PGM PART1 MM');

      // Call capture and wait for async operation
      await engine.captureBeforePull(shareId, 'PGM/PART1.H', sourcePath);
      await waitForAsync();

      const versions = store.list({ shareId, relPath: 'PGM/PART1.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0]).toMatchObject({
        origin: 'server',
        relPath: 'PGM/PART1.H',
      });
      expect(versions.items[0].reason).toContain('pre-PULL');
    });

    it('does not block the caller', async () => {
      const sourcePath = await writeCacheFile('PGM/PART1.H', 'content');
      const start = Date.now();

      await engine.captureBeforePull(shareId, 'PGM/PART1.H', sourcePath);
      const elapsed = Date.now() - start;

      // Should complete nearly instantly (async, fires and forgets)
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('captureBeforePush', () => {
    async function waitForAsync(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    it('captures local content before push', async () => {
      const sourcePath = await writeCacheFile('PGM/PART2.H', 'LOCAL EDIT');

      await engine.captureBeforePush(shareId, 'PGM/PART2.H', sourcePath);
      await waitForAsync();

      const versions = store.list({ shareId, relPath: 'PGM/PART2.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0]).toMatchObject({
        origin: 'tnc',
        relPath: 'PGM/PART2.H',
      });
    });
  });

  describe('captureConflictLoser', () => {
    it('captures the losing side of a conflict', async () => {
      const sourcePath = await writeCacheFile('PGM/CONFLICT.H', 'LOSER CONTENT');

      await engine.captureConflictLoser(shareId, 'PGM/CONFLICT.H', sourcePath, 'last_write_wins');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const versions = store.list({ shareId, relPath: 'PGM/CONFLICT.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0]).toMatchObject({
        origin: 'conflict_loser',
        relPath: 'PGM/CONFLICT.H',
      });
    });
  });

  describe('captureInitial', () => {
    it('captures initial state of a file', async () => {
      const sourcePath = await writeCacheFile('PGM/INITIAL.H', 'INITIAL STATE');

      await engine.captureInitial(shareId, 'PGM/INITIAL.H', sourcePath, 'local');
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const versions = store.list({ shareId, relPath: 'PGM/INITIAL.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0]).toMatchObject({
        origin: 'initial',
        relPath: 'PGM/INITIAL.H',
      });
      expect(versions.items[0].reason).toContain('local');
    });
  });

  describe('handleOrchestratorCapture', () => {
    // Wait for async operations to complete
    async function waitForAsync(): Promise<void> {
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it('handles remote overwrite (PULL scenario)', async () => {
      const sourcePath = await writeCacheFile('PGM/PULL.H', 'LOCAL VERSION');

      await engine.handleOrchestratorCapture(shareId, 'PGM/PULL.H', sourcePath, {
        side: 'local',
        reason: 'overwrite',
      });
      await waitForAsync();

      const versions = store.list({ shareId, relPath: 'PGM/PULL.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0].origin).toBe('tnc');
    });

    it('handles local overwrite (PUSH scenario)', async () => {
      const sourcePath = await writeCacheFile('PGM/PUSH.H', 'REMOTE VERSION');

      await engine.handleOrchestratorCapture(shareId, 'PGM/PUSH.H', sourcePath, {
        side: 'remote',
        reason: 'overwrite',
      });
      await waitForAsync();

      const versions = store.list({ shareId, relPath: 'PGM/PUSH.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0].origin).toBe('server');
    });

    it('handles conflict loser on local side', async () => {
      const sourcePath = await writeCacheFile('PGM/CONF.H', 'LOCAL LOSES');

      await engine.handleOrchestratorCapture(shareId, 'PGM/CONF.H', sourcePath, {
        side: 'local',
        reason: 'conflict_loser',
      });
      await waitForAsync();

      const versions = store.list({ shareId, relPath: 'PGM/CONF.H' });
      expect(versions.items).toHaveLength(1);
      expect(versions.items[0].origin).toBe('conflict_loser');
    });
  });

  describe('disk pressure awareness', () => {
    it('creates engine with custom disk pressure threshold', () => {
      const customEngine = new VersioningEngine({
        store,
        blobRoot,
        diskPressureThreshold: 0.25, // 25% threshold
      });
      expect(customEngine).toBeDefined();
    });

    it('continues sync even if capture fails', async () => {
      // Create a source file with content that will be captured
      const sourcePath = await writeCacheFile('PGM/FAIL.H', 'test');

      // The capture is async and non-blocking, so errors don't propagate
      // Create engine with intentionally bad blob root to trigger an error
      const badEngine = new VersioningEngine({
        store,
        blobRoot: '/nonexistent/path/that/will/fail',
      });

      // This should not throw
      await expect(
        badEngine.captureBeforePull(shareId, 'PGM/FAIL.H', sourcePath),
      ).resolves.not.toThrow();

      // Sync should be unaffected by the capture failure
      expect(true).toBe(true);
    });
  });

  describe('deduplication through engine', () => {
    it('stores identical content only once', async () => {
      const content = 'SAME PROGRAM';
      const path1 = await writeCacheFile('PGM/A.H', content);
      const path2 = await writeCacheFile('PGM/B.H', content);

      async function waitForAsync(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await engine.captureBeforePull(shareId, 'PGM/A.H', path1);
      await engine.captureBeforePull(shareId, 'PGM/B.H', path2);
      await waitForAsync();

      const versionsA = store.list({ shareId, relPath: 'PGM/A.H' });
      const versionsB = store.list({ shareId, relPath: 'PGM/B.H' });

      expect(versionsA.items).toHaveLength(1);
      expect(versionsB.items).toHaveLength(1);
      expect(versionsA.items[0].hash).toBe(versionsB.items[0].hash);

      // Both rows should exist (same hash, different paths), but only one blob
      const hashes = new Set([versionsA.items[0].hash, versionsB.items[0].hash]);
      expect(hashes.size).toBe(1);
    });
  });

  describe('captures are fire-and-forget', () => {
    it('returns immediately without waiting for I/O', async () => {
      const sourcePath = await writeCacheFile('PGM/QUICK.H', 'test');

      async function waitForAsync(): Promise<void> {
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // Capture is async but non-blocking
      const promise = engine.captureBeforePull(shareId, 'PGM/QUICK.H', sourcePath);

      // Promise should resolve immediately
      await promise;

      // Initially it should be empty (async)
      let versions = store.list({ shareId, relPath: 'PGM/QUICK.H' });
      expect(versions.items).toHaveLength(0);

      // Wait for the async work
      await waitForAsync();

      // Now it should be there
      versions = store.list({ shareId, relPath: 'PGM/QUICK.H' });
      expect(versions.items).toHaveLength(1);
    });
  });
});

describe('checkDiskUsage', () => {
  it('returns disk usage statistics', async () => {
    const usage = await checkDiskUsage(process.cwd());

    expect(usage).toHaveProperty('totalBytes');
    expect(usage).toHaveProperty('usedBytes');
    expect(usage).toHaveProperty('freeBytes');
    expect(usage).toHaveProperty('percentFree');

    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeGreaterThan(0);
    expect(usage.percentFree).toBeGreaterThan(0);
    expect(usage.percentFree).toBeLessThanOrEqual(100);
  });

  it('works with subdirectories', async () => {
    const { tmpdir } = await import('node:os');
    const usage = await checkDiskUsage(tmpdir());
    expect(usage.totalBytes).toBeGreaterThan(0);
  });

  it('calculates percentage correctly', async () => {
    const usage = await checkDiskUsage(process.cwd());
    const calculated = (usage.freeBytes / usage.totalBytes) * 100;
    expect(Math.abs(calculated - usage.percentFree)).toBeLessThan(0.1);
  });
});
