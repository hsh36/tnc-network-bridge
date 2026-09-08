import { readFile, statfs } from 'node:fs/promises';
import { loadavg, totalmem, freemem } from 'node:os';
import { type MetricName } from '../../shared';
import { type Db, type DbLogger } from '../config/db';
import { type BridgeMetrics } from './registry';

/**
 * Fills the live gauges and persists a sample row (T45).
 *
 * Two outputs from one pass, deliberately. The Prometheus endpoint wants *current*
 * values and the dashboard wants *history*, and collecting each separately would let
 * them disagree — the classic symptom being a UI graph that does not match the number
 * shown beside it. Here one collection produces both.
 *
 * The sample rows go into `metrics_samples`, which is `WITHOUT ROWID` and keyed
 * `(ts, metric, share_id)`; writing a whole pass in one transaction turns ~10 index
 * insertions into one commit, which on an SD card is the difference between a background
 * task nobody notices and a periodic write stall.
 */

export interface CollectorOptions {
  readonly db: Db;
  readonly metrics: BridgeMetrics;
  /** Filesystem whose usage is reported — the local cache root. */
  readonly cachePath: string;
  readonly logger?: DbLogger;
  readonly now?: () => number;
  readonly startedAt?: number;
}

export interface CollectedSample {
  readonly metric: MetricName;
  readonly shareId: number;
  readonly value: number;
}

/** Disk usage of one filesystem, in bytes. */
export interface DiskUsage {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedBytes: number;
  readonly usedPct: number;
}

/**
 * Reads filesystem usage.
 *
 * Uses `bavail` (blocks available to an unprivileged process), not `bfree`. On ext4 a
 * few percent is reserved for root, so `bfree` overstates what the bridge can actually
 * write by exactly that reserve — and a disk-full guard built on it would let the cache
 * fill until writes started failing.
 */
export async function readDiskUsage(path: string): Promise<DiskUsage> {
  const stats = await statfs(path);
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedBytes = totalBytes - Number(stats.bfree) * blockSize;
  const usedPct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return { totalBytes, freeBytes, usedBytes, usedPct };
}

interface SyncStats {
  readonly filesIn: number;
  readonly filesOut: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly errorCount: number;
}

type NetworkStats = Record<
  string,
  {
    readonly rxBytes: number;
    readonly txBytes: number;
  }
>;

export class MetricsCollector {
  private readonly db: Db;
  private readonly metrics: BridgeMetrics;
  private readonly cachePath: string;
  private readonly logger: DbLogger | undefined;
  private readonly now: () => number;
  private readonly startedAt: number;

  private timer: NodeJS.Timeout | undefined;
  private lastSyncStats: SyncStats | undefined;
  private lastCollectTime: number | undefined;
  private tempReadFailed = false; // Log temperature read failure once

  constructor(options: CollectorOptions) {
    this.db = options.db;
    this.metrics = options.metrics;
    this.cachePath = options.cachePath;
    this.logger = options.logger;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.startedAt = options.startedAt ?? Date.now();
  }

  /**
   * Reads sync statistics from the metrics registry and computes throughput.
   * Calculates files/s and error rate based on counters.
   */
  private readSyncStats(): SyncStats {
    // Get current counters from the registry
    const filesInTotal = this.metrics.syncFiles.get({ direction: 'pull' });
    const filesOutTotal = this.metrics.syncFiles.get({ direction: 'push' });
    const bytesInTotal = this.metrics.syncBytes.get({ direction: 'pull' });
    const bytesOutTotal = this.metrics.syncBytes.get({ direction: 'push' });

    // Count recent errors from the error log
    const now = this.now();
    const recentErrorCount =
      this.db.pluck<number>(
        `SELECT count(*) FROM log_entries
         WHERE source IN ('sync', 'lock', 'smb') AND level IN ('error', 'fatal')
           AND ts >= @since`,
        { since: (now - 60) * 1000 }, // Last 60 seconds
      ) ?? 0;

    return {
      filesIn: filesInTotal,
      filesOut: filesOutTotal,
      bytesIn: bytesInTotal,
      bytesOut: bytesOutTotal,
      errorCount: recentErrorCount,
    };
  }

  /** Reads CPU temperature from Raspberry Pi's thermal zone, or returns 0 if unavailable. */
  private async readCpuTemperature(): Promise<number> {
    try {
      const tempStr = await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      const tempMilliC = Number.parseInt(tempStr.trim(), 10);
      return Number.isFinite(tempMilliC) && tempMilliC >= 0 ? tempMilliC / 1000 : 0;
    } catch {
      if (!this.tempReadFailed) {
        this.logger?.debug({}, 'CPU temperature unavailable (not a Pi or missing sysfs)');
        this.tempReadFailed = true;
      }
      return 0;
    }
  }

  /** Reads network interface RX/TX bytes from /proc/net/dev. */
  private async readNetworkStats(): Promise<NetworkStats> {
    const stats: NetworkStats = {};
    try {
      const content = await readFile('/proc/net/dev', 'utf8');
      const lines = content.split('\n');
      // Skip header lines (first 2)
      for (const line of lines.slice(2)) {
        const match = /^\s*(\S+):\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/.exec(
          line,
        );
        if (match) {
          const [, iface, rxStr, txStr] = match;
          if (iface && rxStr && txStr) {
            stats[iface] = {
              rxBytes: Number.parseInt(rxStr, 10),
              txBytes: Number.parseInt(txStr, 10),
            };
          }
        }
      }
    } catch (err) {
      this.logger?.debug({ err }, 'could not read network stats');
    }
    return stats;
  }

  /** Reads current queue depth by querying in-flight transfers. */
  private readQueueDepth(): number {
    // Query pending transfers from the database by checking file_index state
    // and recent sync activity
    try {
      const queuedCount =
        this.db.pluck<number>(
          `SELECT count(*) FROM file_index
           WHERE state IN ('pending_push', 'pending_pull')`,
        ) ?? 0;
      return queuedCount;
    } catch {
      return 0;
    }
  }

  /**
   * One collection pass: refresh the gauges, then persist the sample row.
   *
   * Never throws. A metrics pass that takes the service down would be a monitoring
   * system causing the outage it exists to report — failures are logged and the pass is
   * abandoned until the next interval.
   */
  async collect(): Promise<CollectedSample[]> {
    const samples: CollectedSample[] = [];
    const ts = this.now();

    try {
      const disk = await readDiskUsage(this.cachePath);
      this.metrics.diskUsage.set(disk.usedBytes);
      this.metrics.diskFree.set(disk.freeBytes);
      samples.push({ metric: 'disk.used_pct', shareId: 0, value: disk.usedPct });
      samples.push({ metric: 'disk.free_bytes', shareId: 0, value: disk.freeBytes });
    } catch (err) {
      this.logger?.warn({ err, path: this.cachePath }, 'could not read disk usage');
    }

    const load = loadavg()[0] ?? 0;
    samples.push({ metric: 'cpu.load', shareId: 0, value: load });

    // CPU temperature
    try {
      const temp = await this.readCpuTemperature();
      samples.push({ metric: 'cpu.temp', shareId: 0, value: temp });
    } catch (err) {
      this.logger?.debug({ err }, 'could not read CPU temperature');
    }

    const total = totalmem();
    const memUsedPct = total > 0 ? ((total - freemem()) / total) * 100 : 0;
    samples.push({ metric: 'mem.used_pct', shareId: 0, value: memUsedPct });

    const uptimeSeconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.metrics.uptime.set(uptimeSeconds);
    samples.push({ metric: 'uptime.seconds', shareId: 0, value: uptimeSeconds });

    // Sync statistics and throughput
    try {
      const syncStats = this.readSyncStats();

      // Raw counters for total bytes and files
      samples.push({ metric: 'sync.bytes_in', shareId: 0, value: syncStats.bytesIn });
      samples.push({ metric: 'sync.bytes_out', shareId: 0, value: syncStats.bytesOut });

      // Files per second (calculated from delta)
      const now = this.now();
      if (this.lastSyncStats !== undefined && this.lastCollectTime !== undefined) {
        const timeDelta = now - this.lastCollectTime;
        if (timeDelta > 0) {
          const filesDelta =
            syncStats.filesIn +
            syncStats.filesOut -
            (this.lastSyncStats.filesIn + this.lastSyncStats.filesOut);
          const filesPerS = filesDelta / timeDelta;
          samples.push({ metric: 'sync.files_per_s', shareId: 0, value: Math.max(0, filesPerS) });

          // Error rate: errors in the last minute
          const errorRate = syncStats.errorCount / 60; // errors per second
          samples.push({ metric: 'sync.error_rate', shareId: 0, value: errorRate });
        }
      }

      this.lastSyncStats = syncStats;
      this.lastCollectTime = now;
    } catch (err) {
      this.logger?.warn({ err }, 'could not read sync statistics');
    }

    // Queue depth
    try {
      const queueDepth = this.readQueueDepth();
      this.metrics.queueDepth.set(queueDepth);
      samples.push({ metric: 'queue.depth', shareId: 0, value: queueDepth });
    } catch (err) {
      this.logger?.warn({ err }, 'could not read queue depth');
    }

    // Network interface statistics
    try {
      const netStats = await this.readNetworkStats();
      let totalRx = 0;
      let totalTx = 0;

      for (const stats of Object.values(netStats)) {
        totalRx += stats.rxBytes;
        totalTx += stats.txBytes;
      }

      samples.push({ metric: 'net.rx_bytes', shareId: 0, value: totalRx });
      samples.push({ metric: 'net.tx_bytes', shareId: 0, value: totalTx });
    } catch (err) {
      this.logger?.debug({ err }, 'could not read network statistics');
    }

    try {
      const activeLocks =
        this.db.pluck<number>('SELECT count(*) FROM locks WHERE released_at IS NULL') ?? 0;
      this.metrics.locks.set(activeLocks);
      samples.push({ metric: 'locks.active', shareId: 0, value: activeLocks });

      const versionCount = this.db.pluck<number>('SELECT count(*) FROM file_versions') ?? 0;
      this.metrics.versionsStored.set(versionCount);

      const onlineShares =
        this.db.pluck<number>(
          "SELECT count(*) FROM shares WHERE enabled = 1 AND status NOT IN ('offline', 'error')",
        ) ?? 0;
      this.metrics.sharesOnline.set(onlineShares);
    } catch (err) {
      this.logger?.warn({ err }, 'could not read metrics from the database');
    }

    this.persist(ts, samples);
    return samples;
  }

  /** Writes one pass in a single transaction. */
  persist(ts: number, samples: readonly CollectedSample[]): void {
    if (samples.length === 0) {
      return;
    }
    try {
      this.db.transaction(() => {
        for (const sample of samples) {
          // INSERT OR REPLACE: two passes within the same second would otherwise collide
          // on the (ts, metric, share_id) primary key and abort the whole transaction.
          this.db.run(
            `INSERT OR REPLACE INTO metrics_samples (ts, metric, share_id, value)
             VALUES (@ts, @metric, @shareId, @value)`,
            { ts, metric: sample.metric, shareId: sample.shareId, value: sample.value },
          );
        }
      });
    } catch (err) {
      this.logger?.warn({ err }, 'could not persist a metrics sample');
    }
  }

  /** Begins periodic collection. Idempotent. */
  start(intervalMs: number): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => {
      void this.collect();
    }, intervalMs);
    // Never hold the event loop open for a metrics timer: the process must be able to
    // exit on shutdown without waiting for the next tick.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Deletes samples older than `retainDays`, and rolls the rest up.
   *
   * Raw samples at a ten-second interval are ~8 600 rows per metric per day. Kept
   * indefinitely on an SD card that is a genuine wear problem, so anything past the
   * retention window is averaged into hourly buckets — which is all the dashboard can
   * render at that zoom level anyway.
   */
  rollUp(olderThanSeconds: number, now = this.now()): { rolledUp: number; deleted: number } {
    const cutoff = now - olderThanSeconds;

    return this.db.transaction(() => {
      const hourly = this.db.all<{ bucket: number; metric: string; share_id: number; avg: number }>(
        `SELECT (ts / 3600) * 3600 AS bucket, metric, share_id, avg(value) AS avg
           FROM metrics_samples
          WHERE ts < @cutoff
          GROUP BY bucket, metric, share_id`,
        { cutoff },
      );

      const deleted = this.db.run('DELETE FROM metrics_samples WHERE ts < @cutoff', {
        cutoff,
      }).changes;

      for (const row of hourly) {
        this.db.run(
          `INSERT OR REPLACE INTO metrics_samples (ts, metric, share_id, value)
           VALUES (@ts, @metric, @shareId, @value)`,
          { ts: row.bucket, metric: row.metric, shareId: row.share_id, value: row.avg },
        );
      }

      return { rolledUp: hourly.length, deleted };
    });
  }
}
