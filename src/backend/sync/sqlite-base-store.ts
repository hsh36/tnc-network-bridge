import { type Db } from '../config/db';

import { type BaseStore, type FileRecord } from './orchestrator';
import { type Side } from './diff-engine';

/**
 * The durable `file_index` behind {@link BaseStore}.
 *
 * The orchestrator was running against {@link MemoryBaseStore} in production, because
 * the supervisor never passed a store and the memory one is the default. Sync worked —
 * files moved in both directions — but nothing was ever written to `file_index`. Two
 * visible consequences, both reported as separate bugs: every share read "0 indexed, 0
 * pending" no matter how much it had synced, and the file browser had nothing to list
 * because it reads that table.
 *
 * The third consequence was invisible and worse. `base` is the last state both sides
 * agreed on, and it is what makes a one-sided change distinguishable from a conflict.
 * Held only in memory, it was lost on every restart, so the first scan after a reboot
 * had to treat every path as ambiguous.
 *
 * Synchronous throughout, matching the interface: better-sqlite3 is synchronous, and an
 * async facade would model concurrency that does not exist.
 */

interface IndexRow {
  rel_path: string;
  base_size: number | null;
  base_mtime: number | null;
  base_hash: string | null;
  state: string;
  retry_count: number;
  next_retry_at: number | null;
  last_error: string | null;
}

const STATES = new Set([
  'new',
  'synced',
  'pending_push',
  'pending_pull',
  'conflict',
  'deferred_locked',
  'error',
  'excluded',
]);

function toRecord(row: IndexRow): FileRecord {
  // A row is only a usable base when all three columns are present. A half-written
  // base is worse than none: it would let the diff engine believe it knows a prior
  // state it cannot actually compare against.
  const base: Side =
    row.base_size === null || row.base_mtime === null
      ? null
      : { size: row.base_size, mtime: row.base_mtime, hash: row.base_hash };

  return {
    base,
    state: (STATES.has(row.state) ? row.state : 'error') as FileRecord['state'],
    retryCount: row.retry_count,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
  };
}

export class SqliteBaseStore implements BaseStore {
  constructor(
    private readonly db: Db,
    private readonly shareId: number,
  ) {}

  get(relPath: string): FileRecord | null {
    const row = this.db.get<IndexRow>(
      `SELECT rel_path, base_size, base_mtime, base_hash, state,
              retry_count, next_retry_at, last_error
         FROM file_index
        WHERE share_id = @shareId AND rel_path_ci = @ci`,
      { shareId: this.shareId, ci: relPath.toLowerCase() },
    );
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Upsert by the case-insensitive path, which is the table's unique key.
   *
   * Matching on `rel_path_ci` rather than `rel_path` is what makes a case rename an
   * update of the existing row instead of a constraint violation — SMB treats
   * `PART1.H` and `part1.h` as one file, ext4 does not, and the index has to agree
   * with the protocol rather than with the filesystem.
   */
  set(relPath: string, record: FileRecord): void {
    this.db.run(
      `INSERT INTO file_index (
         share_id, rel_path, rel_path_ci, base_size, base_mtime, base_hash,
         state, retry_count, next_retry_at, last_error
       ) VALUES (
         @shareId, @relPath, @ci, @baseSize, @baseMtime, @baseHash,
         @state, @retryCount, @nextRetryAt, @lastError
       )
       ON CONFLICT (share_id, rel_path_ci) DO UPDATE SET
         rel_path      = excluded.rel_path,
         base_size     = excluded.base_size,
         base_mtime    = excluded.base_mtime,
         base_hash     = excluded.base_hash,
         state         = excluded.state,
         retry_count   = excluded.retry_count,
         next_retry_at = excluded.next_retry_at,
         last_error    = excluded.last_error`,
      {
        shareId: this.shareId,
        relPath,
        ci: relPath.toLowerCase(),
        baseSize: record.base?.size ?? null,
        baseMtime: record.base?.mtime ?? null,
        baseHash: record.base?.hash ?? null,
        state: record.state,
        retryCount: record.retryCount,
        nextRetryAt: record.nextRetryAt,
        lastError: record.lastError,
      },
    );
  }

  delete(relPath: string): void {
    this.db.run('DELETE FROM file_index WHERE share_id = @shareId AND rel_path_ci = @ci', {
      shareId: this.shareId,
      ci: relPath.toLowerCase(),
    });
  }

  paths(): readonly string[] {
    return this.db
      .all<{ rel_path: string }>(
        'SELECT rel_path FROM file_index WHERE share_id = @shareId ORDER BY rel_path',
        { shareId: this.shareId },
      )
      .map((row) => row.rel_path);
  }
}
