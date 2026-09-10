import { cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { type Db } from '../config/db';
import { runMigrations } from '../config/migrations/runner';

import { type FileRecord } from './orchestrator';
import { SqliteBaseStore } from './sqlite-base-store';

/**
 * The defect this closes: the supervisor built every orchestrator without a store, so
 * the in-memory default was used in production. Files synced, `file_index` stayed
 * empty, and two things broke visibly — every share reported "0 indexed, 0 pending",
 * and the file browser had nothing to list.
 *
 * The invisible breakage was worse. `base` is the last state both sides agreed on, and
 * it is what tells a one-sided change apart from a conflict. In memory it did not
 * survive a restart, so the first scan after every reboot had to treat every path as
 * ambiguous.
 */

let db: Db;
let store: SqliteBaseStore;

const record = (overrides: Partial<FileRecord> = {}): FileRecord => ({
  base: { size: 1024, mtime: 1_757_000_000_000, hash: 'abcdef0123456789' },
  state: 'synced',
  retryCount: 0,
  nextRetryAt: null,
  lastError: null,
  ...overrides,
});

function countRows(): number {
  return db.pluck<number>('SELECT COUNT(*) FROM file_index') ?? 0;
}

beforeEach(() => {
  db = tmpDb();
  runMigrations(db);
  db.run(
    `INSERT INTO shares (id, name, enabled, server_unc, mount_point, cache_path,
                         smb_version, smb_seal, conflict_mode, exclude_patterns,
                         scan_interval_ms, bandwidth_limit_kbps, max_file_size_mb,
                         tnc_guest_ok, created_at, updated_at)
     VALUES (1, 'werkstatt', 1, '//server/cnc', '/mnt/tnc-server/werkstatt',
             '/srv/tnc/werkstatt', '3.1.1', 1, 'last_write_wins', '[]',
             5000, NULL, 100, 0, 0, 0)`,
  );
  store = new SqliteBaseStore(db, 1);
});

afterEach(() => {
  cleanupTmpDbs();
});

describe('get', () => {
  it('returns null for a path never seen', () => {
    expect(store.get('PARTS/part1.h')).toBeNull();
  });

  it('reads back what was written', () => {
    store.set('PARTS/part1.h', record());

    expect(store.get('PARTS/part1.h')).toEqual(record());
  });

  it('finds a path whose case differs, because SMB does not distinguish them', () => {
    // ext4 does; SMB does not. The index has to agree with the protocol, or a client
    // renaming PART1.H to part1.h looks like a second unrelated file.
    store.set('PARTS/part1.h', record());

    expect(store.get('parts/PART1.H')).not.toBeNull();
  });

  it('reports no base when the stored one is incomplete', () => {
    // A half-written base is worse than none: it would let the diff engine believe it
    // knows a prior state it cannot compare against.
    store.set('PARTS/part1.h', record());
    db.run('UPDATE file_index SET base_mtime = NULL');

    expect(store.get('PARTS/part1.h')?.base).toBeNull();
  });

  it('keeps a base with no hash, which is what an unhashed side looks like', () => {
    store.set('PARTS/part1.h', record({ base: { size: 10, mtime: 5, hash: null } }));

    expect(store.get('PARTS/part1.h')?.base).toEqual({ size: 10, mtime: 5, hash: null });
  });
});

describe('set', () => {
  it('writes a row the share counters can see', () => {
    store.set('PARTS/part1.h', record({ state: 'pending_push' }));

    expect(countRows()).toBe(1);
    expect(
      db.pluck<number>(
        "SELECT COUNT(*) FROM file_index WHERE state IN ('pending_push', 'pending_pull')",
      ),
    ).toBe(1);
  });

  it('updates in place rather than inserting a duplicate', () => {
    store.set('PARTS/part1.h', record({ state: 'pending_push' }));
    store.set('PARTS/part1.h', record({ state: 'synced' }));

    expect(countRows()).toBe(1);
    expect(store.get('PARTS/part1.h')?.state).toBe('synced');
  });

  it('treats a case rename as the same file', () => {
    store.set('PARTS/part1.h', record());
    store.set('PARTS/PART1.H', record());

    expect(countRows()).toBe(1);
  });

  it('keeps the newest spelling of a case rename', () => {
    // The file browser shows this string, so it has to be what the filesystem now
    // holds rather than whatever was written first.
    store.set('PARTS/part1.h', record());
    store.set('PARTS/PART1.H', record());

    expect(store.paths()).toEqual(['PARTS/PART1.H']);
  });

  it('carries retry state across, so backoff survives a restart', () => {
    store.set('PARTS/part1.h', record({ state: 'error', retryCount: 3, nextRetryAt: 999 }));

    expect(store.get('PARTS/part1.h')).toMatchObject({
      state: 'error',
      retryCount: 3,
      nextRetryAt: 999,
    });
  });

  it('keeps the error text, which is the only account of why a path failed', () => {
    store.set('PARTS/part1.h', record({ state: 'error', lastError: 'permission denied' }));

    expect(store.get('PARTS/part1.h')?.lastError).toBe('permission denied');
  });
});

describe('delete', () => {
  it('removes the row', () => {
    store.set('PARTS/part1.h', record());
    store.delete('PARTS/part1.h');

    expect(store.get('PARTS/part1.h')).toBeNull();
    expect(countRows()).toBe(0);
  });

  it('removes a row named with different case', () => {
    store.set('PARTS/part1.h', record());
    store.delete('parts/PART1.H');

    expect(countRows()).toBe(0);
  });

  it('is silent about a path that was never there', () => {
    expect(() => store.delete('nothing.h')).not.toThrow();
  });
});

describe('paths', () => {
  it('is empty on a fresh share', () => {
    expect(store.paths()).toEqual([]);
  });

  it('lists what has been written, in a stable order', () => {
    store.set('b.h', record());
    store.set('a.h', record());

    expect(store.paths()).toEqual(['a.h', 'b.h']);
  });

  it('does not leak paths from another share', () => {
    db.run(
      `INSERT INTO shares (id, name, enabled, server_unc, mount_point, cache_path,
                           smb_version, smb_seal, conflict_mode, exclude_patterns,
                           scan_interval_ms, bandwidth_limit_kbps, max_file_size_mb,
                           tnc_guest_ok, created_at, updated_at)
       VALUES (2, 'buero', 1, '//server/buero', '/mnt/tnc-server/buero',
               '/srv/tnc/buero', '3.1.1', 1, 'last_write_wins', '[]',
               5000, NULL, 100, 0, 0, 0)`,
    );
    store.set('werkstatt.h', record());
    new SqliteBaseStore(db, 2).set('buero.h', record());

    expect(store.paths()).toEqual(['werkstatt.h']);
    expect(new SqliteBaseStore(db, 2).paths()).toEqual(['buero.h']);
  });
});

describe('durability', () => {
  it('survives being reopened, which is the whole reason it exists', () => {
    store.set('PARTS/part1.h', record({ state: 'pending_pull' }));

    const afterRestart = new SqliteBaseStore(db, 1);
    expect(afterRestart.get('PARTS/part1.h')).toMatchObject({
      state: 'pending_pull',
      base: { size: 1024 },
    });
  });
});
