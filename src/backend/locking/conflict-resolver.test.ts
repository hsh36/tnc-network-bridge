import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';
import { ConflictResolver, decideWinner, type FileFingerprint } from './conflict-resolver';

let db: Db;
let resolver: ConflictResolver;
let clockSeconds: number;

function insertShare(): number {
  const now = clockSeconds;
  const result = db.run(
    `INSERT INTO shares (name, server_unc, mount_point, cache_path, created_at, updated_at)
     VALUES ('programs', '//fileserver/cnc$/programs', '/mnt/tnc-server/programs', '/srv/tnc/programs', @now, @now)`,
    { now },
  );
  return Number(result.lastInsertRowid);
}

const fp = (hash: string, size: number, mtime: number): FileFingerprint => ({ hash, size, mtime });

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  clockSeconds = 1_700_000_000;
  resolver = new ConflictResolver(db, undefined, () => clockSeconds);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('decideWinner', () => {
  const local = fp('a'.repeat(64), 10, 100);
  const remote = fp('b'.repeat(64), 20, 200);

  it('tnc_wins always picks local', () => {
    expect(decideWinner('tnc_wins', local, remote)).toBe('local');
  });

  it('server_wins always picks remote', () => {
    expect(decideWinner('server_wins', local, remote)).toBe('remote');
  });

  it('last_write_wins picks the newer mtime', () => {
    expect(decideWinner('last_write_wins', fp('x', 1, 300), fp('y', 1, 200))).toBe('local');
    expect(decideWinner('last_write_wins', fp('x', 1, 100), fp('y', 1, 200))).toBe('remote');
  });

  it('last_write_wins breaks an exact tie in favour of the server', () => {
    expect(decideWinner('last_write_wins', fp('x', 1, 150), fp('y', 1, 150))).toBe('remote');
  });

  it('picks whichever side exists when the other is absent, regardless of mode', () => {
    expect(decideWinner('tnc_wins', null, remote)).toBe('remote');
    expect(decideWinner('server_wins', local, null)).toBe('local');
  });
});

describe('captureVersion', () => {
  it('inserts pure metadata with no filesystem access', () => {
    const shareId = insertShare();
    const version = resolver.captureVersion({
      shareId,
      relPath: 'PART1.H',
      hash: 'c'.repeat(64),
      size: 42,
      mtime: 123,
      origin: 'conflict_loser',
      reason: 'test capture',
    });

    expect(version.id).toBeGreaterThan(0);
    expect(version.pinned).toBe(false);
    expect(version.createdAt).toBe(clockSeconds);

    const row = db.get<{ hash: string }>('SELECT hash FROM file_versions WHERE id = @id', {
      id: version.id,
    });
    expect(row?.hash).toBe('c'.repeat(64));
  });
});

describe('resolve', () => {
  it('logs the conflict and captures the losing side as a version', () => {
    const shareId = insertShare();
    const local = fp('a'.repeat(64), 10, 300);
    const remote = fp('b'.repeat(64), 20, 100);

    const conflict = resolver.resolve({
      shareId,
      relPath: 'PART1.H',
      mode: 'last_write_wins',
      local,
      remote,
      detail: 'both sides changed since base',
    });

    expect(conflict.winner).toBe('local');
    expect(conflict.modeApplied).toBe('last_write_wins');
    expect(conflict.winnerHash).toBe(local.hash);
    expect(conflict.loserHash).toBe(remote.hash);
    expect(conflict.loserVersionId).not.toBeNull();
    expect(conflict.acknowledged).toBe(false);

    const version = db.get<{ origin: string; hash: string }>(
      'SELECT origin, hash FROM file_versions WHERE id = @id',
      { id: conflict.loserVersionId },
    );
    expect(version).toEqual({ origin: 'conflict_loser', hash: remote.hash });
  });

  it('does not fabricate a version when the losing side does not exist', () => {
    const shareId = insertShare();
    const conflict = resolver.resolve({
      shareId,
      relPath: 'PART1.H',
      mode: 'tnc_wins',
      local: fp('a'.repeat(64), 10, 300),
      remote: null,
    });
    expect(conflict.winner).toBe('local');
    expect(conflict.loserVersionId).toBeNull();
  });

  it('applies the configured mode even when it contradicts the newer mtime', () => {
    const shareId = insertShare();
    const conflict = resolver.resolve({
      shareId,
      relPath: 'PART1.H',
      mode: 'server_wins',
      local: fp('a'.repeat(64), 10, 999),
      remote: fp('b'.repeat(64), 20, 1),
    });
    expect(conflict.winner).toBe('remote');
  });
});

describe('acknowledge', () => {
  it('marks a conflict as reviewed', () => {
    const shareId = insertShare();
    const conflict = resolver.resolve({
      shareId,
      relPath: 'PART1.H',
      mode: 'tnc_wins',
      local: fp('a'.repeat(64), 1, 1),
      remote: fp('b'.repeat(64), 1, 1),
    });
    expect(conflict.acknowledged).toBe(false);

    const acknowledged = resolver.acknowledge(conflict.id);
    expect(acknowledged.acknowledged).toBe(true);
  });

  it('throws for an unknown id', () => {
    expect(() => resolver.acknowledge(999)).toThrow();
  });
});
