import { type VersioningConfig } from '../../shared';
import { type DbLogger } from '../config/db';
import { type JobContext, type JobOutcome } from '../scheduling/jobs';
import { type AuditLog } from '../security/audit-log';
import { planRetention, type RetentionPlan } from './retention';
import { type VersionStore } from './version-store';

/**
 * Version cleanup (T39) — the job that turns a {@link RetentionPlan} into deletions.
 *
 * The plan is computed first, in full, and only then executed. That ordering is what
 * makes {@link VersionCleanup.dryRun} possible, and a dry run is not a nicety here: this
 * is the one background job whose bug costs an operator work they cannot get back.
 *
 * ## What is never deleted
 *
 * Three protections, enforced in {@link planRetention} and re-asserted here:
 *
 * - **Pinned** versions.
 * - Versions **referenced by a conflict row** — deleting one leaves a conflict record
 *   pointing at content nobody can inspect, which defeats the point of logging it.
 * - The **newest version of every path**, regardless of age.
 *
 * ## Blobs versus rows
 *
 * Deleting a version row does not necessarily delete a blob: deduplication means one
 * blob can back many rows. The blob goes only when its last referencing row does, which
 * is why `bytesFreed` is measured from the blobs actually unlinked rather than summed
 * from the rows removed. Reporting the row sum would routinely overstate the saving by
 * an order of magnitude on a share full of near-identical programs.
 *
 * ## Orphans
 *
 * A crash between writing a blob and inserting its row leaves a blob nothing references.
 * {@link VersionCleanup.sweepOrphans} reclaims those. It is deliberately a separate,
 * explicit pass rather than part of every prune: it lists the entire store, which is far
 * too expensive to do routinely, and an orphan wastes space without threatening
 * correctness.
 */

export interface CleanupOptions {
  readonly versions: VersionStore;
  /** Reads the live `versioning` section, so a policy change takes effect next run. */
  readonly policy: () => VersioningConfig;
  readonly logger?: DbLogger;
  readonly audit?: AuditLog;
  readonly now?: () => number;
}

export interface CleanupReport {
  /** Version rows removed. */
  readonly versionsDeleted: number;
  /** Blobs actually unlinked — always ≤ `versionsDeleted`, thanks to dedup. */
  readonly blobsDeleted: number;
  /** Bytes reclaimed on disk. Counts only blobs that were really removed. */
  readonly bytesFreed: number;
  /** Rows the plan wanted to remove but could not, with the reason. */
  readonly failures: readonly { versionId: number; error: string }[];
  readonly durationMs: number;
  /** True when nothing was deleted because the policy is disabled. */
  readonly skipped: boolean;
}

export interface DryRunReport {
  readonly plan: RetentionPlan;
  /** What `bytesFreed` would be, accounting for blobs shared with surviving versions. */
  readonly estimatedBytesFreed: number;
}

export class VersionCleanup {
  private readonly versions: VersionStore;
  private readonly policy: () => VersioningConfig;
  private readonly logger: DbLogger | undefined;
  private readonly audit: AuditLog | undefined;

  constructor(options: CleanupOptions) {
    this.versions = options.versions;
    this.policy = options.policy;
    this.logger = options.logger;
    this.audit = options.audit;
  }

  /**
   * Computes the plan without deleting anything.
   *
   * The byte estimate is the honest one: a pruned version whose blob is still referenced
   * by a surviving version frees nothing, so its size is excluded.
   */
  dryRun(now: number, shareId?: number): DryRunReport {
    const config = this.policy();
    const all = this.versions.allForShare(shareId);
    const plan = planRetention({
      versions: all,
      policy: { keepCount: config.keepCount, keepDays: config.keepDays },
      referencedIds: this.versions.referencedVersionIds(),
      now,
    });

    // A blob is only freed when *every* row citing it is being pruned.
    const doomedIds = new Set(plan.prune.map((p) => p.version.id));
    const survivingHashes = new Set(all.filter((v) => !doomedIds.has(v.id)).map((v) => v.hash));
    const freedHashes = new Map<string, number>();
    for (const { version } of plan.prune) {
      if (!survivingHashes.has(version.hash)) {
        freedHashes.set(version.hash, version.size);
      }
    }
    let estimatedBytesFreed = 0;
    for (const size of freedHashes.values()) {
      estimatedBytesFreed += size;
    }

    return { plan, estimatedBytesFreed };
  }

  /**
   * Applies the retention policy.
   *
   * Deletions are independent: one failure — a blob already gone, a permissions problem —
   * is recorded and the pass continues. Aborting on the first error would mean a single
   * unreadable file permanently blocks all future pruning, and the store grows without
   * bound while appearing to run its cleanup nightly.
   */
  async run(now: number, shareId?: number): Promise<CleanupReport> {
    const startedAt = Date.now();
    const config = this.policy();

    if (!config.enabled) {
      return {
        versionsDeleted: 0,
        blobsDeleted: 0,
        bytesFreed: 0,
        failures: [],
        durationMs: Date.now() - startedAt,
        skipped: true,
      };
    }

    const { plan } = this.dryRun(now, shareId);
    const failures: { versionId: number; error: string }[] = [];
    let versionsDeleted = 0;
    let blobsDeleted = 0;
    let bytesFreed = 0;

    for (const decision of plan.prune) {
      try {
        const { blobDeleted } = await this.versions.delete(decision.version.id);
        versionsDeleted += 1;
        if (blobDeleted) {
          blobsDeleted += 1;
          bytesFreed += decision.version.size;
        }
      } catch (err) {
        failures.push({
          versionId: decision.version.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const report: CleanupReport = {
      versionsDeleted,
      blobsDeleted,
      bytesFreed,
      failures,
      durationMs: Date.now() - startedAt,
      skipped: false,
    };

    if (versionsDeleted > 0 || failures.length > 0) {
      this.logger?.info(
        {
          versionsDeleted,
          blobsDeleted,
          bytesFreed,
          failures: failures.length,
          durationMs: report.durationMs,
        },
        'version retention pass complete',
      );
      this.audit?.record({
        actor: 'system',
        action: 'version.prune',
        result: failures.length > 0 ? 'error' : 'ok',
        detail: `${String(versionsDeleted)} versions, ${String(blobsDeleted)} blobs, ${String(bytesFreed)} bytes`,
      });
    }

    return report;
  }

  /**
   * Deletes blobs no `file_versions` row references.
   *
   * Reads the live hash set *before* listing the store, never the other way round: a
   * capture that lands between the two would otherwise have its brand-new blob look like
   * an orphan and be deleted out from under its own row. Getting this backwards is the
   * classic mark-and-sweep race, and here it would silently destroy a version the UI
   * still lists.
   */
  async sweepOrphans(): Promise<{ deleted: number; bytesFreed: number }> {
    const live = this.versions.liveHashes();
    const blobs = this.versions.blobStore;
    const stored = await blobs.list();

    let deleted = 0;
    let bytesFreed = 0;
    for (const hash of stored) {
      if (live.has(hash)) {
        continue;
      }
      const found = await blobs.locate(hash);
      const size = found?.storedSize ?? 0;
      if (await blobs.delete(hash)) {
        deleted += 1;
        bytesFreed += size;
      }
    }

    if (deleted > 0) {
      this.logger?.info({ deleted, bytesFreed }, 'reclaimed orphaned version blobs');
    }
    return { deleted, bytesFreed };
  }

  /**
   * The `prune` job handler, for {@link JobRegistry}.
   *
   * Reports what it did in the schedule history, so "prune ran, freed nothing" and
   * "prune ran, freed 400 MB" are distinguishable without opening the logs.
   */
  asJobHandler(): (ctx: JobContext) => Promise<JobOutcome> {
    return async (ctx: JobContext): Promise<JobOutcome> => {
      const shareId = ctx.target?.shareId;
      const report = await this.run(ctx.firedAt, shareId);

      if (report.skipped) {
        return { skipped: true, detail: 'versioning is disabled' };
      }
      if (report.versionsDeleted === 0 && report.failures.length === 0) {
        return { detail: 'nothing to prune' };
      }
      const parts = [
        `${String(report.versionsDeleted)} versions`,
        `${String(report.blobsDeleted)} blobs`,
        `${formatBytes(report.bytesFreed)} freed`,
      ];
      if (report.failures.length > 0) {
        parts.push(`${String(report.failures.length)} failed`);
      }
      return { detail: parts.join(', ') };
    };
  }
}

/** Human-readable byte count for job summaries. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}
