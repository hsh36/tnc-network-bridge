import {
  type Conflict,
  type ConflictMode,
  type ConflictWinner,
  type FileVersion,
  type VersionOrigin,
} from '../../shared';
import { type Db, type DbLogger } from '../config/db';

/**
 * Conflict resolution and the version store that backs it (T24).
 *
 * The diff engine (T18, Opus track) is what *detects* that both sides of a file
 * changed since the last common base; this module is where that detection turns into
 * a decision plus a durable record. The two responsibilities are kept together
 * deliberately: a conflict must never be logged without first capturing the content it
 * is about to discard; making {@link ConflictResolver.resolve} the only path to a
 * `conflicts` row is what makes that ordering structural rather than a convention the
 * caller has to remember.
 *
 * `file_versions` here is metadata only — hash, size, mtime, origin. The actual bytes
 * behind a hash live in the content-addressed blob store the sync engine writes to
 * before calling this; recording a version here never touches the filesystem.
 */

export interface FileFingerprint {
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
}

export interface ResolveConflictInput {
  readonly shareId: number;
  readonly relPath: string;
  readonly mode: ConflictMode;
  /** `null` means the side does not currently exist (e.g. deleted on that side). */
  readonly local: FileFingerprint | null;
  readonly remote: FileFingerprint | null;
  readonly detail?: string;
}

export interface CaptureVersionInput {
  readonly shareId: number;
  readonly relPath: string;
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
  readonly origin: VersionOrigin;
  readonly reason?: string;
}

interface ConflictRow {
  id: number;
  ts: number;
  share_id: number;
  rel_path: string;
  mode_applied: string;
  winner: string;
  loser_version_id: number | null;
  winner_hash: string | null;
  loser_hash: string | null;
  local_mtime: number | null;
  remote_mtime: number | null;
  acknowledged: number;
  detail: string | null;
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

function toConflict(row: ConflictRow): Conflict {
  return {
    id: row.id,
    ts: row.ts,
    shareId: row.share_id,
    relPath: row.rel_path,
    modeApplied: row.mode_applied as ConflictMode,
    winner: row.winner as ConflictWinner,
    loserVersionId: row.loser_version_id,
    winnerHash: row.winner_hash,
    loserHash: row.loser_hash,
    localMtime: row.local_mtime,
    remoteMtime: row.remote_mtime,
    acknowledged: row.acknowledged === 1,
    detail: row.detail,
  };
}

function toVersion(row: VersionRow): FileVersion {
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

/**
 * Decides which side wins under a given mode.
 *
 * `last_write_wins` breaks ties in favour of the server: on a genuine tie the local
 * (TNC-side) change is, in practice, almost always the one that was just re-saved by
 * the same program that produced it moments earlier over the network, so treating a
 * dead heat as "the network copy is the one to trust" is the safer default of the two.
 */
export function decideWinner(
  mode: ConflictMode,
  local: FileFingerprint | null,
  remote: FileFingerprint | null,
): ConflictWinner {
  if (local === null) {
    return 'remote';
  }
  if (remote === null) {
    return 'local';
  }
  switch (mode) {
    case 'tnc_wins':
      return 'local';
    case 'server_wins':
      return 'remote';
    case 'last_write_wins':
      return local.mtime > remote.mtime ? 'local' : 'remote';
  }
}

export class ConflictResolver {
  constructor(
    private readonly db: Db,
    private readonly logger?: DbLogger,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Inserts a `file_versions` row. Pure metadata — no bytes are read or written. */
  captureVersion(input: CaptureVersionInput): FileVersion {
    const result = this.db.run(
      `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, reason, created_at, pinned)
       VALUES (@shareId, @relPath, @hash, @size, @mtime, @origin, @reason, @createdAt, 0)`,
      {
        shareId: input.shareId,
        relPath: input.relPath,
        hash: input.hash,
        size: input.size,
        mtime: input.mtime,
        origin: input.origin,
        reason: input.reason ?? null,
        createdAt: this.now(),
      },
    );
    const row = this.db.get<VersionRow>('SELECT * FROM file_versions WHERE id = @id', {
      id: Number(result.lastInsertRowid),
    });
    if (row === undefined) {
      throw new Error('Version row disappeared immediately after insert');
    }
    return toVersion(row);
  }

  /**
   * Decides a winner, captures the loser's content as a version, and logs the
   * conflict — atomically, so a crash between steps can never leave a conflict row
   * pointing at a version that was never written.
   */
  resolve(input: ResolveConflictInput): Conflict {
    return this.db.transaction(() => {
      const winner = decideWinner(input.mode, input.local, input.remote);
      const loserSide = winner === 'local' ? input.remote : input.local;
      const winnerSide = winner === 'local' ? input.local : input.remote;

      let loserVersionId: number | null = null;
      if (loserSide !== null) {
        const version = this.captureVersion({
          shareId: input.shareId,
          relPath: input.relPath,
          hash: loserSide.hash,
          size: loserSide.size,
          mtime: loserSide.mtime,
          origin: 'conflict_loser',
          reason: `superseded by ${winner} under ${input.mode}`,
        });
        loserVersionId = version.id;
      }

      const result = this.db.run(
        `INSERT INTO conflicts (
           ts, share_id, rel_path, mode_applied, winner, loser_version_id,
           winner_hash, loser_hash, local_mtime, remote_mtime, acknowledged, detail
         ) VALUES (
           @ts, @shareId, @relPath, @mode, @winner, @loserVersionId,
           @winnerHash, @loserHash, @localMtime, @remoteMtime, 0, @detail
         )`,
        {
          ts: this.now(),
          shareId: input.shareId,
          relPath: input.relPath,
          mode: input.mode,
          winner,
          loserVersionId,
          winnerHash: winnerSide?.hash ?? null,
          loserHash: loserSide?.hash ?? null,
          localMtime: input.local?.mtime ?? null,
          remoteMtime: input.remote?.mtime ?? null,
          detail: input.detail ?? null,
        },
      );
      const row = this.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = @id', {
        id: Number(result.lastInsertRowid),
      });
      if (row === undefined) {
        throw new Error('Conflict row disappeared immediately after insert');
      }
      this.logger?.info(
        { shareId: input.shareId, relPath: input.relPath, mode: input.mode, winner },
        'conflict resolved',
      );
      return toConflict(row);
    });
  }

  acknowledge(id: number): Conflict {
    this.db.run('UPDATE conflicts SET acknowledged = 1 WHERE id = @id', { id });
    const row = this.db.get<ConflictRow>('SELECT * FROM conflicts WHERE id = @id', { id });
    if (row === undefined) {
      throw new Error(`No conflict with id ${id}`);
    }
    return toConflict(row);
  }
}
