import { type DbLogger } from '../config/db';
import { type VersionCapture } from '../sync/diff-engine';
import { type VersionStore } from './version-store';

/**
 * The versioning engine (T38) — a wrapper around the {@link VersionStore} that handles
 * non-blocking async capture coordination and integration with the sync orchestrator.
 *
 * The engine is responsible for:
 * - **Non-blocking captures**: Captures happen async and do not delay sync operations
 * - **Disk pressure awareness**: Skips captures when disk is nearly full
 * - **Orchestrator integration**: Implements the `SyncPorts.captureVersion()` contract
 * - **Four capture points**: pre-PULL, pre-PUSH, conflict-loser, initial sync
 *
 * ## Why captures are non-blocking
 *
 * A file overwrite happens in milliseconds; writing the blob to disk can take seconds on
 * a Pi with network storage. Blocking sync on the capture would turn a single delayed
 * file into a whole-share slowdown. The engine fires and forgets — if the capture fails,
 * it is logged but does not fail the sync. A version that failed to capture is still
 * better than no history at all, which a sync that never completes provides.
 *
 * ## Why disk pressure matters
 *
 * A filesystem filled to capacity is a filesystem that just crashed. If 10% of space
 * remains, the safest choice is to stop consuming it and wait for an operator to act.
 * The capture is skipped, not errored, so the sync continues even if a disk warning
 * is pending.
 */

export interface VersioningEngineOptions {
  readonly store: VersionStore;
  readonly logger?: DbLogger;
  /** Free disk space threshold, as a fraction (0-1). Captures skip if below this. */
  readonly diskPressureThreshold?: number;
  /** Path to check disk usage for (where blobs are stored). */
  readonly blobRoot: string;
}

export interface CaptureOptions {
  readonly shareId: number;
  readonly relPath: string;
  readonly sourcePath: string;
  readonly reason?: string;
}

/**
 * The kind of capture being triggered, as reported by the orchestrator's verdict.
 *
 * These are the four points where content is about to be lost, and are the only time
 * a version should be captured. The origin field in the database will be derived from
 * these.
 */
export type CaptureReason = 'server' | 'tnc' | 'conflict_loser' | 'initial';

export class VersioningEngine {
  private readonly store: VersionStore;
  private readonly logger: DbLogger | undefined;
  private readonly diskPressureThreshold: number;
  private readonly blobRoot: string;

  constructor(options: VersioningEngineOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.diskPressureThreshold = options.diskPressureThreshold ?? 0.1;
    this.blobRoot = options.blobRoot;
  }

  /**
   * Captures the content before the server overwrites a local file.
   *
   * Called pre-PULL: the local cache has content, the server is about to overwrite it.
   * Non-blocking; fires and forgets.
   */
  async captureBeforePull(shareId: number, relPath: string, sourcePath: string): Promise<void> {
    this.fireAndForget(
      async () => {
        if (!(await this.shouldCapture())) {
          return;
        }
        await this.store.capture({
          shareId,
          relPath,
          sourcePath,
          origin: 'server',
          reason: 'pre-PULL: local content about to be overwritten from server',
        });
      },
      'captureBeforePull',
      { shareId, relPath },
    );
  }

  /**
   * Captures the content before a local change is pushed to the server.
   *
   * Called pre-PUSH: a file was edited locally and is about to be sent to the server.
   * Non-blocking; fires and forgets.
   */
  async captureBeforePush(shareId: number, relPath: string, sourcePath: string): Promise<void> {
    this.fireAndForget(
      async () => {
        if (!(await this.shouldCapture())) {
          return;
        }
        await this.store.capture({
          shareId,
          relPath,
          sourcePath,
          origin: 'tnc',
          reason: 'pre-PUSH: local change about to be pushed to server',
        });
      },
      'captureBeforePush',
      { shareId, relPath },
    );
  }

  /**
   * Captures the version that lost a conflict.
   *
   * Called when a conflict is resolved: the losing side's content is captured before
   * the winning side overwrites it.
   * Non-blocking; fires and forgets.
   */
  async captureConflictLoser(
    shareId: number,
    relPath: string,
    sourcePath: string,
    conflictMode: string,
  ): Promise<void> {
    this.fireAndForget(
      async () => {
        if (!(await this.shouldCapture())) {
          return;
        }
        await this.store.capture({
          shareId,
          relPath,
          sourcePath,
          origin: 'conflict_loser',
          reason: `conflict resolved: losing side saved (mode: ${conflictMode})`,
        });
      },
      'captureConflictLoser',
      { shareId, relPath, conflictMode },
    );
  }

  /**
   * Captures the initial content on first sync.
   *
   * Called the first time a path is synchronized: the initial state of both sides is
   * captured, establishing a baseline for future change detection.
   * Non-blocking; fires and forgets.
   */
  async captureInitial(
    shareId: number,
    relPath: string,
    sourcePath: string,
    side: 'local' | 'remote',
  ): Promise<void> {
    this.fireAndForget(
      async () => {
        if (!(await this.shouldCapture())) {
          return;
        }
        await this.store.capture({
          shareId,
          relPath,
          sourcePath,
          origin: 'initial',
          reason: `first sync: baseline for ${side} side`,
        });
      },
      'captureInitial',
      { shareId, relPath, side },
    );
  }

  /**
   * Handles capture requests from the sync orchestrator.
   *
   * The orchestrator uses this method through its `SyncPorts.captureVersion()` contract.
   * The capture kind (server, tnc, conflict_loser) is encoded in the verdict it produces.
   */
  async handleOrchestratorCapture(
    shareId: number,
    relPath: string,
    sourcePath: string,
    capture: VersionCapture,
  ): Promise<void> {
    if (capture.side === 'local') {
      if (capture.reason === 'overwrite') {
        await this.captureBeforePush(shareId, relPath, sourcePath);
      } else if (capture.reason === 'delete') {
        await this.captureBeforePush(shareId, relPath, sourcePath);
      } else if (capture.reason === 'conflict_loser') {
        await this.captureConflictLoser(shareId, relPath, sourcePath, 'unknown');
      }
    } else if (capture.side === 'remote') {
      if (capture.reason === 'overwrite') {
        await this.captureBeforePull(shareId, relPath, sourcePath);
      } else if (capture.reason === 'delete') {
        await this.captureBeforePull(shareId, relPath, sourcePath);
      } else if (capture.reason === 'conflict_loser') {
        await this.captureConflictLoser(shareId, relPath, sourcePath, 'unknown');
      }
    }
  }

  /**
   * Check whether a capture should proceed, based on disk pressure.
   *
   * Returns false if disk is nearly full; captures are skipped without error.
   * This is not a hard constraint but a pressure relief valve: if disk is filling up,
   * the bridge keeps syncing and alerts the operator, rather than silently losing sync.
   */
  private async shouldCapture(): Promise<boolean> {
    try {
      const usage = await checkDiskUsage(this.blobRoot);
      if (usage.percentFree < this.diskPressureThreshold * 100) {
        this.logger?.warn(
          { percentFree: usage.percentFree, threshold: this.diskPressureThreshold * 100 },
          'disk space low, skipping version capture',
        );
        return false;
      }
      return true;
    } catch (err) {
      // If we cannot check disk usage, proceed with the capture. A read error is worse
      // than a paranoid skip.
      this.logger?.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'could not check disk usage, proceeding with capture',
      );
      return true;
    }
  }

  /**
   * Fires a capture async and catches errors so they do not stop sync.
   *
   * The error is logged but not propagated: sync must not be delayed or failed by a
   * version capture, even if it fails.
   */
  private fireAndForget(
    capture: () => Promise<void>,
    method: string,
    context: Record<string, unknown>,
  ): void {
    // Use setImmediate to yield to the event loop rather than blocking the caller.
    setImmediate(() => {
      capture().catch((err: unknown) => {
        this.logger?.warn(
          {
            ...context,
            error: err instanceof Error ? err.message : String(err),
          },
          `version capture failed in ${method}`,
        );
      });
    });
  }
}

/**
 * Disk usage information.
 *
 * Enough to decide "is this filesystem in danger?" — we do not need the full df output.
 */
export interface DiskUsage {
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly freeBytes: number;
  readonly percentFree: number;
}

/**
 * Check free disk space on the filesystem containing `path`.
 *
 * Uses `statvfs` semantics: available bytes, not just free. On a filesystem with
 * reserved-for-root space, the two can differ.
 *
 * Exported so the orchestrator integration can use it directly if needed.
 */
export async function checkDiskUsage(path: string): Promise<DiskUsage> {
  const { statfs } = await import('node:fs/promises');
  const stats = await statfs(path);

  const totalBytes = stats.blocks * stats.bsize;
  const freeBytes = stats.bavail * stats.bsize;
  const usedBytes = totalBytes - freeBytes;
  const percentFree = totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0;

  return { totalBytes, usedBytes, freeBytes, percentFree };
}
