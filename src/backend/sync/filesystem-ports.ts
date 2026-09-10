import { readdir, rm, stat } from 'node:fs/promises';
import { posix, join, relative, sep } from 'node:path';

import picomatch from 'picomatch';

import { TEMP_FILE_PREFIX } from '../../shared';
import { type DbLogger } from '../config/db';
import { type LockManager } from '../locking/lock-manager';
import { type VersioningEngine } from '../versioning/versioning-engine';

import { type Side, type VersionCapture } from './diff-engine';
import { type SyncPorts } from './orchestrator';
import { transferFile } from './transfer';

/**
 * {@link SyncPorts} over two real directories: the local cache the TNC side serves, and
 * the mounted server export.
 *
 * The orchestrator is written against this interface precisely so it can be reasoned
 * about without a filesystem. Everything filesystem-shaped therefore lives here, and the
 * two rules worth stating are both about *not* lying to the engine above:
 *
 *  - A path that cannot be stat'ed reads as `null`, meaning "absent on this side". That
 *    is a real input to the diff, not an error — a file the operator deleted and a file
 *    on an unreachable mount look identical from one stat call, which is why
 *    `isServerOnline` is asked separately before a deletion is ever believed.
 *  - Hashes are computed lazily. The diff falls back to (size, mtime) when a hash is
 *    absent, and hashing every file on every cycle would read the whole share from the
 *    network each time.
 */

export interface FilesystemPortsOptions {
  readonly shareId: number;
  /** Local cache root; also what Samba exports to the machines. */
  readonly cachePath: string;
  /** Where the server export is mounted. */
  readonly mountPoint: string;
  readonly excludePatterns: readonly string[];
  readonly maxFileSizeMb: number;
  readonly locks?: LockManager;
  readonly versioning?: VersioningEngine;
  readonly logger?: DbLogger | undefined;
  /** Answers "is the server reachable"; the mount manager knows, this class does not. */
  readonly serverOnline: () => boolean;
}

export class FilesystemSyncPorts implements SyncPorts {
  private readonly options: FilesystemPortsOptions;
  private readonly isExcludedPath: (relPath: string) => boolean;

  constructor(options: FilesystemPortsOptions) {
    this.options = options;
    const matchers = options.excludePatterns.map((pattern) => picomatch(pattern, { dot: true }));
    this.isExcludedPath = (relPath) => matchers.some((match) => match(relPath));
  }

  async listPaths(): Promise<readonly string[]> {
    const [local, remote] = await Promise.all([
      walk(this.options.cachePath),
      // A missing or unreachable mount yields nothing rather than throwing. Treating it
      // as an empty share would be catastrophic — every file would look server-deleted —
      // which is why the orchestrator gates deletions on isServerOnline().
      walk(this.options.mountPoint),
    ]);
    return [...new Set([...local, ...remote])].filter((relPath) => !isTemp(relPath)).sort();
  }

  statLocal(relPath: string): Promise<Side> {
    return this.statSide(join(this.options.cachePath, toNative(relPath)));
  }

  statRemote(relPath: string): Promise<Side> {
    return this.statSide(join(this.options.mountPoint, toNative(relPath)));
  }

  async push(relPath: string): Promise<void> {
    await transferFile(
      join(this.options.cachePath, toNative(relPath)),
      join(this.options.mountPoint, toNative(relPath)),
    );
  }

  async pull(relPath: string): Promise<void> {
    await transferFile(
      join(this.options.mountPoint, toNative(relPath)),
      join(this.options.cachePath, toNative(relPath)),
    );
  }

  async deleteLocal(relPath: string): Promise<void> {
    await rm(join(this.options.cachePath, toNative(relPath)), { force: true });
  }

  async deleteRemote(relPath: string): Promise<void> {
    await rm(join(this.options.mountPoint, toNative(relPath)), { force: true });
  }

  captureVersion(relPath: string, capture: VersionCapture): Promise<void> {
    const root = capture.side === 'local' ? this.options.cachePath : this.options.mountPoint;
    this.options.versioning?.handleOrchestratorCapture(
      this.options.shareId,
      relPath,
      join(root, toNative(relPath)),
      capture,
    );
    return Promise.resolve();
  }

  isServerOnline(): Promise<boolean> {
    return Promise.resolve(this.options.serverOnline());
  }

  isLocked(relPath: string): boolean {
    if (this.options.locks === undefined) {
      return false;
    }
    return this.options.locks
      .list({ share: this.options.shareId, includeReleased: false, limit: 500, offset: 0 })
      .items.some((lock) => lock.relPath === relPath);
  }

  isExcluded(relPath: string): boolean {
    return this.isExcludedPath(relPath);
  }

  /**
   * Two indexed paths differing only by case.
   *
   * The TNC side is case-insensitive and the Linux cache is not, so `PART.H` and
   * `part.h` can both exist here and collapse into one file the moment a machine writes
   * to either. The engine refuses to sync such a pair rather than pick a winner.
   */
  hasCaseCollision(): boolean {
    // Answered by the scanner, which holds the index; without one there is nothing to
    // compare against and claiming a collision would stall every path.
    return false;
  }

  private async statSide(absolute: string): Promise<Side> {
    try {
      const stats = await stat(absolute);
      if (!stats.isFile()) {
        return null;
      }
      if (stats.size > this.options.maxFileSizeMb * 1024 * 1024) {
        // Over the ceiling counts as absent: syncing it is refused, and reporting it as
        // present would make the diff want to copy it on every single cycle.
        return null;
      }
      return { size: stats.size, mtime: Math.round(stats.mtimeMs), hash: null };
    } catch {
      return null;
    }
  }
}

/** `.tnc-tmp-*` is an in-flight transfer of ours, never a file to sync. */
function isTemp(relPath: string): boolean {
  return posix.basename(relPath).startsWith(TEMP_FILE_PREFIX);
}

/** Relative paths are POSIX on the wire and in the database; the filesystem may not be. */
function toNative(relPath: string): string {
  return sep === '/' ? relPath : relPath.split('/').join(sep);
}

/**
 * Every file below `root`, as POSIX-relative paths.
 *
 * Returns nothing for a root that cannot be read. See the class comment: an unreachable
 * mount must look like "nothing to say", not like an empty share.
 */
async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        found.push(relative(root, absolute).split(sep).join('/'));
      }
    }
  };
  await visit(root);
  return found;
}
