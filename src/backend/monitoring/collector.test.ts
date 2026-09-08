import { tmpdir } from 'node:os';
import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { MetricsCollector, readDiskUsage } from './collector';
import { createBridgeMetrics, type BridgeMetrics } from './registry';

const NOW = 1_700_000_000;

let db: Db;
let metrics: BridgeMetrics;
let collector: MetricsCollector;
let clock: number;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  clock = NOW;
  metrics = createBridgeMetrics();
  collector = new MetricsCollector({
    db,
    metrics,
    cachePath: tmpdir(),
    now: () => clock,
    startedAt: Date.now() - 5000,
  });
});

afterEach(() => {
  collector.stop();
  cleanupTmpDbs();
});

describe('readDiskUsage', () => {
  it('reports a plausible usage for a real filesystem', async () => {
    const usage = await readDiskUsage(tmpdir());

    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(usage.freeBytes).toBeGreaterThanOrEqual(0);
    expect(usage.usedPct).toBeGreaterThanOrEqual(0);
    expect(usage.usedPct).toBeLessThanOrEqual(100);
  });

  it('never reports more free space than the filesystem holds', async () => {
    const usage = await readDiskUsage(tmpdir());
    expect(usage.freeBytes).toBeLessThanOrEqual(usage.totalBytes);
  });
});

describe('collect', () => {
  it('fills the gauges and returns the samples', async () => {
    const samples = await collector.collect();

    const names = samples.map((s) => s.metric);
    expect(names).toContain('cpu.load');
    expect(names).toContain('mem.used_pct');
    expect(names).toContain('uptime.seconds');
    expect(metrics.uptime.get()).toBeGreaterThan(0);
  });

  it('counts only unreleased locks', async () => {
    db.run(
      `INSERT INTO shares (id, name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (1, 'main', '//srv/s', '/mnt/main', '/srv/main', @now, @now)`,
      { now: NOW },
    );
    db.run(
      `INSERT INTO locks (share_id, rel_path, origin, acquired_at) VALUES (1, 'a.h', 'tnc', @now)`,
      { now: NOW },
    );
    db.run(
      `INSERT INTO locks (share_id, rel_path, origin, acquired_at, released_at)
       VALUES (1, 'b.h', 'tnc', @now, @now)`,
      { now: NOW },
    );

    await collector.collect();

    expect(metrics.locks.get()).toBe(1);
  });

  it('persists a row per sample', async () => {
    await collector.collect();

    const count = db.pluck<number>('SELECT count(*) FROM metrics_samples') ?? 0;
    expect(count).toBeGreaterThan(0);
    const ts = db.pluck<number>('SELECT DISTINCT ts FROM metrics_samples');
    expect(ts).toBe(NOW);
  });

  it('survives two passes within the same second', async () => {
    // The primary key is (ts, metric, share_id); a plain INSERT would abort the whole
    // transaction and lose the pass.
    await collector.collect();
    await expect(collector.collect()).resolves.toBeDefined();

    const distinct = db.pluck<number>('SELECT count(DISTINCT ts) FROM metrics_samples') ?? 0;
    expect(distinct).toBe(1);
  });

  it('does not throw when the cache path does not exist', async () => {
    const broken = new MetricsCollector({
      db,
      metrics,
      cachePath: '/definitely/not/a/real/path/anywhere',
      now: () => clock,
    });

    // A metrics pass must never be the thing that takes the service down.
    await expect(broken.collect()).resolves.toBeDefined();
    broken.stop();
  });

  it('counts shares that are neither offline nor errored as online', async () => {
    const now = NOW;
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, status, created_at, updated_at)
       VALUES ('a', '//s/a', '/mnt/a', '/srv/a', 'idle', @now, @now)`,
      { now },
    );
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, status, created_at, updated_at)
       VALUES ('b', '//s/b', '/mnt/b', '/srv/b', 'offline', @now, @now)`,
      { now },
    );
    db.run(
      `INSERT INTO shares (name, server_unc, mount_point, cache_path, status, created_at, updated_at)
       VALUES ('c', '//s/c', '/mnt/c', '/srv/c', 'error', @now, @now)`,
      { now },
    );

    await collector.collect();

    expect(metrics.sharesOnline.get()).toBe(1);
  });

  it('collects sync throughput metrics', async () => {
    metrics.syncFiles.inc(5, { direction: 'pull' });
    metrics.syncFiles.inc(3, { direction: 'push' });
    metrics.syncBytes.inc(1_000_000, { direction: 'pull' });
    metrics.syncBytes.inc(500_000, { direction: 'push' });

    const samples = await collector.collect();

    const metrics_ = samples.map((s) => s.metric);
    expect(metrics_).toContain('sync.bytes_in');
    expect(metrics_).toContain('sync.bytes_out');
  });

  it('collects queue depth metrics', async () => {
    db.run(
      `INSERT INTO shares (id, name, server_unc, mount_point, cache_path, created_at, updated_at)
       VALUES (1, 'main', '//srv/s', '/mnt/main', '/srv/main', @now, @now)`,
      { now: NOW },
    );
    db.run(
      `INSERT INTO file_index (share_id, rel_path, rel_path_ci, state)
       VALUES (1, 'file1.h', 'file1.h', 'pending_push')`,
    );
    db.run(
      `INSERT INTO file_index (share_id, rel_path, rel_path_ci, state)
       VALUES (1, 'file2.h', 'file2.h', 'pending_pull')`,
    );

    const samples = await collector.collect();

    const queueMetric = samples.find((s) => s.metric === 'queue.depth');
    expect(queueMetric).toBeDefined();
    expect(queueMetric?.value).toBe(2);
  });

  it('collects CPU temperature (or 0 if unavailable)', async () => {
    const samples = await collector.collect();

    const tempMetric = samples.find((s) => s.metric === 'cpu.temp');
    expect(tempMetric).toBeDefined();
    expect(tempMetric?.value).toBeGreaterThanOrEqual(0);
  });

  it('collects network statistics', async () => {
    const samples = await collector.collect();

    const rxMetric = samples.find((s) => s.metric === 'net.rx_bytes');
    const txMetric = samples.find((s) => s.metric === 'net.tx_bytes');
    expect(rxMetric).toBeDefined();
    expect(txMetric).toBeDefined();
    expect(rxMetric?.value).toBeGreaterThanOrEqual(0);
    expect(txMetric?.value).toBeGreaterThanOrEqual(0);
  });
});

describe('start and stop', () => {
  it('is idempotent and stoppable', () => {
    collector.start(60_000);
    collector.start(60_000);
    collector.stop();
    collector.stop();
    // Reaching here without a hang or a throw is the assertion.
    expect(true).toBe(true);
  });
});

describe('rollUp', () => {
  it('averages old raw samples into hourly buckets', () => {
    // Three samples inside one hour, all older than the retention window.
    const hourStart = 1_699_000_000 - (1_699_000_000 % 3600);
    for (const [offset, value] of [
      [10, 10],
      [20, 20],
      [30, 60],
    ] as const) {
      db.run(
        `INSERT INTO metrics_samples (ts, metric, share_id, value)
         VALUES (@ts, 'cpu.load', 0, @value)`,
        { ts: hourStart + offset, value },
      );
    }

    const result = collector.rollUp(3600, NOW);

    expect(result.deleted).toBe(3);
    expect(result.rolledUp).toBe(1);

    const rows = db.all<{ ts: number; value: number }>(
      'SELECT ts, value FROM metrics_samples ORDER BY ts',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ts).toBe(hourStart);
    expect(rows[0]?.value).toBeCloseTo(30);
  });

  it('leaves samples inside the retention window untouched', () => {
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value)
       VALUES (@ts, 'cpu.load', 0, 5)`,
      { ts: NOW - 60 },
    );

    const result = collector.rollUp(3600, NOW);

    expect(result.deleted).toBe(0);
    expect(db.pluck<number>('SELECT count(*) FROM metrics_samples')).toBe(1);
  });

  it('keeps separate buckets per metric and share', () => {
    const hourStart = 1_699_000_000 - (1_699_000_000 % 3600);
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value)
       VALUES (@ts, 'cpu.load', 0, 10)`,
      { ts: hourStart + 1 },
    );
    db.run(
      `INSERT INTO metrics_samples (ts, metric, share_id, value)
       VALUES (@ts, 'sync.bytes_in', 2, 99)`,
      { ts: hourStart + 2 },
    );

    const result = collector.rollUp(3600, NOW);

    expect(result.rolledUp).toBe(2);
    const rows = db.all<{ metric: string; share_id: number }>(
      'SELECT metric, share_id FROM metrics_samples ORDER BY metric',
    );
    expect(rows).toEqual([
      { metric: 'cpu.load', share_id: 0 },
      { metric: 'sync.bytes_in', share_id: 2 },
    ]);
  });

  it('is a no-op on an empty table', () => {
    expect(collector.rollUp(3600, NOW)).toEqual({ rolledUp: 0, deleted: 0 });
  });
});
