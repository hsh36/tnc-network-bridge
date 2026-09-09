import { cleanupTmpDbs, tmpDb } from '../../../../tests/support/tmp-db';
import { type Db, isConstraintError } from '../db';
import { runMigrations } from './runner';

/**
 * Schema v1 verified against the real `001_init.sql`.
 *
 * These tests exist because the constraints are the schema's actual value. An index
 * that does not enforce what we think it enforces is worse than no index — it makes
 * the application skip a check it believes the database is doing.
 */

let db: Db;

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
});

afterEach(() => {
  cleanupTmpDbs();
});

const now = Math.floor(Date.now() / 1000);

function insertShare(overrides: Record<string, string | number | null> = {}): number {
  const values = {
    name: 'programs',
    server_unc: '//fileserver/cnc$/programs',
    mount_point: '/mnt/tnc-server/programs',
    cache_path: '/srv/tnc/programs',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  const columns = Object.keys(values);
  const result = db.run(
    `INSERT INTO shares (${columns.join(', ')})
     VALUES (${columns.map((c) => `@${c}`).join(', ')})`,
    values,
  );
  return Number(result.lastInsertRowid);
}

const expectConstraintViolation = (fn: () => unknown): void => {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  expect(isConstraintError(thrown)).toBe(true);
};

describe('migration application', () => {
  it('reaches schema version 4', () => {
    // 001_init, 002_network_config, 003_dhcp, 004_network_per_side.
    expect(db.userVersion).toBe(4);
  });

  it('creates all fourteen tables from §2, plus the log sink and the ledger', () => {
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((r) => r.name);

    const planTables = [
      'api_tokens',
      'audit_log',
      'config',
      'conflicts',
      'file_index',
      'file_versions',
      'locks',
      'metrics_samples',
      'schedules',
      'sessions',
      'shares',
      'sync_events',
      'tnc_clients',
      'update_history',
    ];
    expect(planTables).toHaveLength(14);
    for (const table of planTables) {
      expect(tables).toContain(table);
    }
    expect(tables).toContain('log_entries');
    expect(tables).toContain('schema_migrations');
  });

  it('creates the indexes the sync engine depends on', () => {
    const indexes = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
      )
      .map((r) => r.name);
    for (const index of [
      'idx_fi_state',
      'idx_fi_retry',
      'idx_locks_active',
      'idx_ver_path',
      'idx_ver_hash',
      'idx_ev_ts',
    ]) {
      expect(indexes).toContain(index);
    }
  });

  it('passes an integrity and foreign key check straight after migration', () => {
    expect(db.integrityCheck().ok).toBe(true);
    expect(db.foreignKeyCheck()).toEqual([]);
  });

  it('seeds the install-scoped config rows', () => {
    expect(
      db.get<{ value: string }>("SELECT value FROM config WHERE key='setup.completed'"),
    ).toEqual({ value: 'false' });
    expect(db.pluck<number>("SELECT count(*) FROM config WHERE key='install.created_at'")).toBe(1);
  });
});

describe('shares constraints', () => {
  it('accepts a well-formed share', () => {
    expect(insertShare()).toBeGreaterThan(0);
  });

  it.each([
    ['a space', 'a space'],
    ['a semicolon', 'semi;colon'],
    ['a traversal attempt', '../escape'],
    ['a slash', 'a/b'],
    ['an empty name', ''],
    ['an over-long name', 'a'.repeat(33)],
  ])('rejects %s in the share name', (_label, name) => {
    expectConstraintViolation(() => insertShare({ name }));
  });

  it('rejects a duplicate share name', () => {
    insertShare();
    expectConstraintViolation(() =>
      insertShare({ mount_point: '/mnt/tnc-server/other', cache_path: '/srv/tnc/other' }),
    );
  });

  it('rejects two shares sharing a cache path', () => {
    // Two shares syncing into one directory would interleave silently.
    insertShare();
    expectConstraintViolation(() =>
      insertShare({ name: 'other', mount_point: '/mnt/tnc-server/other' }),
    );
  });

  it('rejects an unknown conflict mode', () => {
    expectConstraintViolation(() => insertShare({ conflict_mode: 'tnc_always_wins' }));
  });

  it.each(['tnc_wins', 'server_wins', 'last_write_wins'])('accepts conflict mode %s', (mode) => {
    expect(insertShare({ conflict_mode: mode })).toBeGreaterThan(0);
  });

  it('rejects an unknown status', () => {
    expectConstraintViolation(() => insertShare({ status: 'confused' }));
  });

  it('rejects a non-boolean flag', () => {
    expectConstraintViolation(() => insertShare({ enabled: 2 }));
  });

  it('defaults to the documented values', () => {
    const id = insertShare();
    const row = db.get<{
      conflict_mode: string;
      smb_version: string;
      max_file_size_mb: number;
      status: string;
      enabled: number;
    }>(
      'SELECT conflict_mode, smb_version, max_file_size_mb, status, enabled FROM shares WHERE id=?',
      [id],
    );
    expect(row).toEqual({
      conflict_mode: 'last_write_wins',
      smb_version: '3.1.1',
      max_file_size_mb: 512,
      status: 'idle',
      enabled: 1,
    });
  });
});

describe('locks — one active lock per path', () => {
  let shareId: number;

  beforeEach(() => {
    shareId = insertShare();
  });

  const acquire = (relPath: string, origin = 'tnc'): number =>
    Number(
      db.run(
        `INSERT INTO locks (share_id, rel_path, origin, acquired_at)
         VALUES (@shareId, @relPath, @origin, @acquiredAt)`,
        { shareId, relPath, origin, acquiredAt: now },
      ).lastInsertRowid,
    );

  it('rejects a second active lock on the same path (R15)', () => {
    acquire('programs/part1.h');
    expectConstraintViolation(() => acquire('programs/part1.h', 'manual'));
  });

  it('allows locks on different paths in the same share', () => {
    acquire('programs/part1.h');
    expect(acquire('programs/part2.h')).toBeGreaterThan(0);
  });

  it('allows the same path to be locked in a different share', () => {
    const other = insertShare({
      name: 'other',
      mount_point: '/mnt/tnc-server/other',
      cache_path: '/srv/tnc/other',
    });
    acquire('programs/part1.h');
    expect(
      Number(
        db.run(
          `INSERT INTO locks (share_id, rel_path, origin, acquired_at)
           VALUES (@shareId, @relPath, 'tnc', @acquiredAt)`,
          { shareId: other, relPath: 'programs/part1.h', acquiredAt: now },
        ).lastInsertRowid,
      ),
    ).toBeGreaterThan(0);
  });

  it('allows a re-lock once the previous lock is released', () => {
    const id = acquire('programs/part1.h');
    db.run('UPDATE locks SET released_at = @ts WHERE id = @id', { ts: now, id });
    expect(acquire('programs/part1.h')).toBeGreaterThan(0);
  });

  it('keeps the full history — released locks are not deleted', () => {
    const id = acquire('programs/part1.h');
    db.run('UPDATE locks SET released_at = @ts WHERE id = @id', { ts: now, id });
    acquire('programs/part1.h');
    expect(db.pluck<number>('SELECT count(*) FROM locks')).toBe(2);
  });

  it('rejects an unknown lock origin', () => {
    expectConstraintViolation(() => acquire('programs/part1.h', 'gremlin'));
  });

  it('rejects an unknown server lock kind', () => {
    expectConstraintViolation(() =>
      db.run(
        `INSERT INTO locks (share_id, rel_path, origin, acquired_at, server_lock_kind)
         VALUES (@shareId, 'a.h', 'tnc', @ts, 'telepathy')`,
        { shareId, ts: now },
      ),
    );
  });
});

describe('file_index constraints', () => {
  let shareId: number;

  beforeEach(() => {
    shareId = insertShare();
  });

  const index = (relPath: string, relPathCi = relPath.toLowerCase()): number =>
    Number(
      db.run(
        `INSERT INTO file_index (share_id, rel_path, rel_path_ci)
         VALUES (@shareId, @relPath, @relPathCi)`,
        { shareId, relPath, relPathCi },
      ).lastInsertRowid,
    );

  it('detects a case collision that ext4 would allow but SMB would not', () => {
    index('programs/PART1.H');
    expectConstraintViolation(() => index('programs/part1.h'));
  });

  it('rejects an unknown reconciliation state', () => {
    expectConstraintViolation(() =>
      db.run(
        `INSERT INTO file_index (share_id, rel_path, rel_path_ci, state)
         VALUES (@shareId, 'a.h', 'a.h', 'probably_fine')`,
        { shareId },
      ),
    );
  });

  it('rejects a negative retry count', () => {
    expectConstraintViolation(() =>
      db.run(
        `INSERT INTO file_index (share_id, rel_path, rel_path_ci, retry_count)
         VALUES (@shareId, 'a.h', 'a.h', -1)`,
        { shareId },
      ),
    );
  });

  it('allows all three sides to be null — an entry may be known but unmeasured', () => {
    expect(index('a.h')).toBeGreaterThan(0);
    const row = db.get<{ loc_size: number | null; base_hash: string | null }>(
      'SELECT loc_size, base_hash FROM file_index WHERE rel_path = ?',
      ['a.h'],
    );
    expect(row).toEqual({ loc_size: null, base_hash: null });
  });
});

describe('cascading deletes', () => {
  it('removes every dependent row when a share is deleted', () => {
    const shareId = insertShare();
    db.run(
      "INSERT INTO file_index (share_id, rel_path, rel_path_ci) VALUES (@shareId, 'a.h', 'a.h')",
      { shareId },
    );
    db.run(
      "INSERT INTO locks (share_id, rel_path, origin, acquired_at) VALUES (@shareId, 'a.h', 'tnc', @ts)",
      { shareId, ts: now },
    );
    db.run(
      `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at)
       VALUES (@shareId, 'a.h', 'abc', 1, @ts, 'server', @ts)`,
      { shareId, ts: now },
    );
    db.run(
      `INSERT INTO conflicts (ts, share_id, rel_path, mode_applied, winner)
       VALUES (@ts, @shareId, 'a.h', 'last_write_wins', 'local')`,
      { shareId, ts: now },
    );

    db.run('DELETE FROM shares WHERE id = ?', [shareId]);

    expect(db.pluck<number>('SELECT count(*) FROM file_index')).toBe(0);
    expect(db.pluck<number>('SELECT count(*) FROM locks')).toBe(0);
    expect(db.pluck<number>('SELECT count(*) FROM file_versions')).toBe(0);
    expect(db.pluck<number>('SELECT count(*) FROM conflicts')).toBe(0);
  });

  it('keeps a conflict record when its captured version is pruned', () => {
    // Retention pruning a version must never erase the evidence that a conflict
    // happened — otherwise the conflict log silently loses entries over time.
    const shareId = insertShare();
    const versionId = Number(
      db.run(
        `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at)
         VALUES (@shareId, 'a.h', 'abc', 1, @ts, 'conflict_loser', @ts)`,
        { shareId, ts: now },
      ).lastInsertRowid,
    );
    db.run(
      `INSERT INTO conflicts (ts, share_id, rel_path, mode_applied, winner, loser_version_id)
       VALUES (@ts, @shareId, 'a.h', 'last_write_wins', 'local', @versionId)`,
      { shareId, ts: now, versionId },
    );

    db.run('DELETE FROM file_versions WHERE id = ?', [versionId]);

    const row = db.get<{ loser_version_id: number | null }>(
      'SELECT loser_version_id FROM conflicts',
    );
    expect(row).toEqual({ loser_version_id: null });
  });
});

describe('metrics_samples', () => {
  it('accepts a host-wide sample using the sentinel share id', () => {
    // The plan's nullable share_id cannot work in a WITHOUT ROWID primary key —
    // SQLite makes those columns implicitly NOT NULL. 0 means "not share-scoped".
    db.run('INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, @m, 0, @v)', {
      ts: now,
      m: 'cpu.temp',
      v: 52.4,
    });
    expect(db.pluck<number>('SELECT count(*) FROM metrics_samples')).toBe(1);
  });

  it('rejects a null share id rather than accepting it silently', () => {
    expectConstraintViolation(() =>
      db.run(
        'INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, @m, NULL, @v)',
        { ts: now, m: 'cpu.temp', v: 1 },
      ),
    );
  });

  it('rejects a duplicate sample for the same instant, metric and share', () => {
    const params = { ts: now, m: 'queue.depth', v: 3 };
    db.run(
      'INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, @m, 0, @v)',
      params,
    );
    expectConstraintViolation(() =>
      db.run(
        'INSERT INTO metrics_samples (ts, metric, share_id, value) VALUES (@ts, @m, 0, @v)',
        params,
      ),
    );
  });
});

describe('other enumerations', () => {
  it('rejects an unknown sync event result', () => {
    expectConstraintViolation(() =>
      db.run("INSERT INTO sync_events (ts, action, result) VALUES (@ts, 'copy', 'maybe')", {
        ts: now,
      }),
    );
  });

  it('rejects an unknown version origin', () => {
    const shareId = insertShare();
    expectConstraintViolation(() =>
      db.run(
        `INSERT INTO file_versions (share_id, rel_path, hash, size, mtime, origin, created_at)
         VALUES (@shareId, 'a.h', 'abc', 1, @ts, 'vibes', @ts)`,
        { shareId, ts: now },
      ),
    );
  });

  it('rejects an unknown schedule kind', () => {
    expectConstraintViolation(() =>
      db.run("INSERT INTO schedules (name, kind, cron) VALUES ('x', 'dance', '0 3 * * 0')"),
    );
  });

  it('rejects an unknown update result', () => {
    expectConstraintViolation(() =>
      db.run("INSERT INTO update_history (ts, result) VALUES (@ts, 'sideways')", { ts: now }),
    );
  });

  it('rejects an unknown TNC model but allows null', () => {
    expectConstraintViolation(() => db.run("INSERT INTO tnc_clients (model) VALUES ('TNC999')"));
    expect(() => db.run('INSERT INTO tnc_clients (model) VALUES (NULL)')).not.toThrow();
  });

  it('rejects an unknown log level and source', () => {
    expectConstraintViolation(() =>
      db.run(
        "INSERT INTO log_entries (ts, level, source, message) VALUES (@ts, 'shout', 'app', 'x')",
        {
          ts: now,
        },
      ),
    );
    expectConstraintViolation(() =>
      db.run(
        "INSERT INTO log_entries (ts, level, source, message) VALUES (@ts, 'info', 'nowhere', 'x')",
        {
          ts: now,
        },
      ),
    );
  });

  it('enforces a unique token hash', () => {
    db.run("INSERT INTO api_tokens (name, token_hash, created_at) VALUES ('a', 'deadbeef', @ts)", {
      ts: now,
    });
    expectConstraintViolation(() =>
      db.run(
        "INSERT INTO api_tokens (name, token_hash, created_at) VALUES ('b', 'deadbeef', @ts)",
        {
          ts: now,
        },
      ),
    );
  });
});
