import { stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { type FileVersion, type VersionOrigin } from '../../shared';
import { type Db, type DbLogger } from '../config/db';
import { type BlobStore, type StoredBlob } from './blob-store';

/**
 * The version store (T34): `file_versions` metadata joined to the content-addressed
 * {@link BlobStore}.
 *
 * T24 already writes `file_versions` rows for conflict losers, but those rows are pure
 * metadata — a hash with no bytes behind it. This class is what makes a version
 * *restorable*: it captures the content first and inserts the row second, in that order,
 * so a row can never advertise content the store does not hold. The reverse ordering
 * would produce version history that looks complete in the UI and fails at restore time,
 * which is the failure mode versioning exists to prevent.
 *
 * ## Why capture is idempotent
 *
 * Capturing the same file twice writes one blob and two rows. That is intended: the rows
 * record *when the content was current*, which is genuine history, while the bytes are
 * shared. Ten saves of an unchanged program cost ten small rows and one blob.
 *
 * ## Restore
 *
 * A restore is deliberately *not* a special sync path. It writes the blob into the local
 * cache as an ordinary local modification and lets the normal engine propagate it, which
 * means restores inherit locking, conflict handling and echo suppression for free rather
 * than reimplementing them subtly differently. The pre-restore content is captured first,
 * so a restore is itself reversible.
 */

export interface VersionStoreOptions {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly logger?: DbLogger;
  /** Unix seconds. Injected for testability. */
  readonly now?: () => number;
}

export interface CaptureInput {
  readonly shareId: number;
  readonly relPath: string;
  /** Absolute path to the content being captured. */
  readonly sourcePath: string;
  readonly origin: VersionOrigin;
  readonly reason?: string;
}

export interface CaptureResult {
  readonly version: FileVersion;
  readonly blob: StoredBlob;
  /** True when the bytes were already in the store — the dedup hit. */
  readonly deduplicated: boolean;
}

export interface ListVersionsOptions {
  readonly shareId?: number;
  readonly relPath?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface VersionPage {
  readonly items: readonly FileVersion[];
  readonly total: number;
}

interface VersionRow {
  id: number;
  share_id: number;
  rel_path: string;
  hash: string;
  size: number;
  mtime: number;
  origin: string;
  reason: string | null;
  created_at: number;
  pinned: number;
}

export function rowToVersion(row: VersionRow): FileVersion {
  return {
    id: row.id,
    shareId: row.share_id,
    relPath: row.rel_path,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    origin: row.origin as VersionOrigin,
    reason: row.reason,
    createdAt: row.created_at,
    pinned: row.pinned === 1,
  };
}

export class VersionNotFoundError extends Error {
  constructor(readonly id: number) {
    super(`No version with id ${id}`);
    this.name = 'VersionNotFoundError';
  }
}

export class PathTraversalError extends Error {
  constructor(readonly relPath: string) {
    super(`Refusing a path that escapes the share root: ${relPath}`);
    this.name = 'PathTraversalError';
  }
}

/**
 * Resolves a share-relative path inside its root, refusing anything that escapes.
 *
 * This is the single chokepoint for turning API-supplied text into a filesystem path in
 * the versioning subsystem (T43's path-traversal requirement). It rejects absolute paths
 * and verifies the *resolved* result is still under the root — checking for `..` textually
 * is not enough, because `a/../../b` normalises to an escape without containing a leading
 * `..`, and symlink-free normalisation is exactly what `resolve` does.
 */
export function resolveWithinRoot(root: string, relPath: string): string {
  if (isAbsolute(relPath) || relPath.includes('\0')) {
    throw new PathTraversalError(relPath);
  }
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, normalize(relPath));
  if (candidate !== absoluteRoot && !candidate.startsWith(absoluteRoot + sep)) {
    throw new PathTraversalError(relPath);
  }
  return candidate;
}

export class VersionStore {
  private readonly db: Db;
  private readonly blobs: BlobStore;
  private readonly logger: DbLogger | undefined;
  private readonly now: () => number;

  constructor(options: VersionStoreOptions) {
    this.db = options.db;
    this.blobs = options.blobs;
    this.logger = options.logger;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Captures the current content of a file as a new version.
   *
   * Blob first, row second. If the blob write fails, no row is written and the caller
   * sees the failure; if the process dies between the two, the store holds an orphan
   * blob, which the T39 sweep reclaims. Both outcomes are recoverable. A row without a
   * blob is not.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    const info = await stat(input.sourcePath);
    const blob = await this.blobs.putFile(input.sourcePath);

    const result = this.db.run(
      `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, reason, created_at, pinned)
       VALUES (@shareId, @relPath, @hash, @size, @mtime, @origin, @reason, @createdAt, 0)`,
      {
        shareId: input.shareId,
        relPath: input.relPath,
        hash: blob.hash,
        size: blob.size,
        mtime: Math.round(info.mtimeMs),
        origin: input.origin,
        reason: input.reason ?? null,
        createdAt: this.now(),
      },
    );

    const version = this.requireRow(Number(result.lastInsertRowid));
    this.logger?.debug(
      {
        shareId: input.shareId,
        relPath: input.relPath,
        hash: blob.hash,
        deduplicated: !blob.created,
      },
      'version captured',
    );
    return { version, blob, deduplicated: !blob.created };
  }

  /** Captures content held in memory — used for the pre-image of a restore. */
  async captureBuffer(
    input: Omit<CaptureInput, 'sourcePath'> & { content: Uint8Array; mtime: number },
  ): Promise<CaptureResult> {
    const blob = await this.blobs.putBuffer(input.content);
    const result = this.db.run(
      `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, reason, created_at, pinned)
       VALUES (@shareId, @relPath, @hash, @size, @mtime, @origin, @reason, @createdAt, 0)`,
      {
        shareId: input.shareId,
        relPath: input.relPath,
        hash: blob.hash,
        size: blob.size,
        mtime: input.mtime,
        origin: input.origin,
        reason: input.reason ?? null,
        createdAt: this.now(),
      },
    );
    const version = this.requireRow(Number(result.lastInsertRowid));
    return { version, blob, deduplicated: !blob.created };
  }

  get(id: number): FileVersion | undefined {
    const row = this.db.get<VersionRow>('SELECT * FROM file_versions WHERE id = @id', { id });
    return row === undefined ? undefined : rowToVersion(row);
  }

  require(id: number): FileVersion {
    const version = this.get(id);
    if (version === undefined) {
      throw new VersionNotFoundError(id);
    }
    return version;
  }

  /**
   * Version history, newest first.
   *
   * `idx_ver_path` is `(share_id, rel_path, created_at DESC)`, so the common query —
   * "history of this one file" — is an index range scan with no sort step. That is the
   * <100 ms lookup requirement, and it holds at any store size because the index prefix
   * pins both filter columns.
   */
  list(options: ListVersionsOptions = {}): VersionPage {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (options.shareId !== undefined) {
      where.push('share_id = @shareId');
      params.shareId = options.shareId;
    }
    if (options.relPath !== undefined) {
      where.push('rel_path = @relPath');
      params.relPath = options.relPath;
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total =
      this.db.pluck<number>(`SELECT count(*) FROM file_versions ${clause}`, params) ?? 0;

    const rows = this.db.all<VersionRow>(
      `SELECT * FROM file_versions ${clause}
       ORDER BY created_at DESC, id DESC
       LIMIT @limit OFFSET @offset`,
      { ...params, limit: options.limit ?? 50, offset: options.offset ?? 0 },
    );

    return { items: rows.map(rowToVersion), total };
  }

  /** Pins or unpins a version, exempting it from retention pruning. */
  setPinned(id: number, pinned: boolean): FileVersion {
    this.db.run('UPDATE file_versions SET pinned = @pinned WHERE id = @id', {
      id,
      pinned: pinned ? 1 : 0,
    });
    return this.require(id);
  }

  /** Opens the bytes behind a version, for the download endpoint. */
  async openContent(id: number): Promise<NodeJS.ReadableStream> {
    const version = this.require(id);
    return this.blobs.openRead(version.hash);
  }

  /**
   * Restores a version into the local cache.
   *
   * The pre-restore content is captured first — that is what makes an accidental restore
   * undoable — and only then is the blob written over the target. Writing goes through
   * {@link BlobStore.extractTo}, which verifies the digest as it writes, so a corrupt
   * blob fails loudly instead of quietly replacing a good program with garbage.
   */
  async restore(
    id: number,
    options: { cacheRoot: string; targetPath?: string },
  ): Promise<{ restoredTo: string; preRestoreVersionId: number }> {
    const version = this.require(id);
    const relTarget = options.targetPath ?? version.relPath;
    const absoluteTarget = resolveWithinRoot(options.cacheRoot, relTarget);

    // Capture what is about to be overwritten. A missing target is not an error — the
    // file may have been deleted, which is one of the reasons to restore in the first
    // place — there is simply no pre-image to keep.
    let preRestoreVersionId = 0;
    const existing = await statOrNull(absoluteTarget);
    if (existing !== null) {
      const pre = await this.capture({
        shareId: version.shareId,
        relPath: relTarget,
        sourcePath: absoluteTarget,
        origin: 'restore',
        reason: `pre-restore image, replaced by version ${String(id)}`,
      });
      preRestoreVersionId = pre.version.id;
    }

    await this.blobs.extractTo(version.hash, absoluteTarget);

    this.logger?.info(
      { versionId: id, shareId: version.shareId, relPath: relTarget, preRestoreVersionId },
      'version restored',
    );

    return { restoredTo: relTarget, preRestoreVersionId };
  }

  /**
   * Deletes a version row, and its blob if no other row still references the digest.
   *
   * The reference check and the row delete happen in one transaction so a concurrent
   * capture of the same content cannot slip between them and lose its blob. The blob
   * unlink happens after the transaction commits: deleting a file is not transactional,
   * and doing it inside would risk removing bytes for a transaction that then rolls back.
   */
  async delete(id: number): Promise<{ blobDeleted: boolean }> {
    const version = this.require(id);

    const blobIsOrphaned = this.db.immediateTransaction(() => {
      this.db.run('DELETE FROM file_versions WHERE id = @id', { id });
      const remaining =
        this.db.pluck<number>('SELECT count(*) FROM file_versions WHERE hash = @hash', {
          hash: version.hash,
        }) ?? 0;
      return remaining === 0;
    });

    if (!blobIsOrphaned) {
      return { blobDeleted: false };
    }
    const deleted = await this.blobs.delete(version.hash);
    return { blobDeleted: deleted };
  }

  /** Version ids cited by a conflict row — never eligible for pruning (T39). */
  referencedVersionIds(): Set<number> {
    const rows = this.db.all<{ loser_version_id: number }>(
      'SELECT DISTINCT loser_version_id FROM conflicts WHERE loser_version_id IS NOT NULL',
    );
    return new Set(rows.map((row) => row.loser_version_id));
  }

  /** All versions for a share, for the retention planner. */
  allForShare(shareId?: number): FileVersion[] {
    const rows =
      shareId === undefined
        ? this.db.all<VersionRow>('SELECT * FROM file_versions')
        : this.db.all<VersionRow>('SELECT * FROM file_versions WHERE share_id = @shareId', {
            shareId,
          });
    return rows.map(rowToVersion);
  }

  /** Distinct digests referenced by any row — the live set for the orphan sweep. */
  liveHashes(): Set<string> {
    const rows = this.db.all<{ hash: string }>('SELECT DISTINCT hash FROM file_versions');
    return new Set(rows.map((row) => row.hash));
  }

  get blobStore(): BlobStore {
    return this.blobs;
  }

  private requireRow(id: number): FileVersion {
    const row = this.db.get<VersionRow>('SELECT * FROM file_versions WHERE id = @id', { id });
    if (row === undefined) {
      throw new Error('Version row disappeared immediately after insert');
    }
    return rowToVersion(row);
  }
}

async function statOrNull(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Default on-disk location of the blob store, per the deployment layout. */
export const DEFAULT_VERSION_ROOT = join(sep, 'var', 'lib', 'tnc-bridge', 'versions');
