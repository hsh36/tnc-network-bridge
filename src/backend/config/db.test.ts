import { openTmpDb, cleanupTmpDbs, tmpDb } from '../../../tests/support/tmp-db';
import { Db, DatabaseError, isBusyError, isConstraintError } from './db';

afterEach(() => {
  cleanupTmpDbs();
});

describe('Db.open', () => {
  it('enables WAL on an on-disk database', () => {
    const db = tmpDb();
    expect(db.connection.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('enables foreign key enforcement', () => {
    const db = tmpDb();
    expect(db.connection.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('actually rejects an orphaned row, not just sets the pragma', () => {
    const db = tmpDb();
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
    `);
    let thrown: unknown;
    try {
      db.run('INSERT INTO child (parent_id) VALUES (999)');
    } catch (err) {
      thrown = err;
    }
    expect(isConstraintError(thrown)).toBe(true);
  });

  it('cascades a delete to dependent rows', () => {
    const db = tmpDb();
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
                          parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
    `);
    db.run('INSERT INTO parent (id) VALUES (1)');
    db.run('INSERT INTO child (parent_id) VALUES (1)');
    db.run('DELETE FROM parent WHERE id = 1');
    expect(db.all('SELECT * FROM child')).toHaveLength(0);
  });

  it('applies the configured busy timeout', () => {
    const db = tmpDb({ busyTimeoutMs: 250 });
    expect(db.connection.pragma('busy_timeout', { simple: true })).toBe(250);
  });

  it('supports in-memory databases without attempting WAL', () => {
    const db = Db.open({ path: ':memory:' });
    expect(db.isOpen).toBe(true);
    db.exec('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t VALUES (1)');
    expect(db.get<{ a: number }>('SELECT a FROM t')).toEqual({ a: 1 });
    db.close();
  });
});

describe('typed query helpers', () => {
  const seed = (): Db => {
    const db = Db.open({ path: ':memory:' });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER)');
    db.run('INSERT INTO t (name, n) VALUES (@name, @n)', { name: 'alpha', n: 1 });
    db.run('INSERT INTO t (name, n) VALUES (@name, @n)', { name: 'beta', n: 2 });
    return db;
  };

  it('returns undefined rather than throwing when nothing matches', () => {
    const db = seed();
    expect(db.get('SELECT * FROM t WHERE id = 999')).toBeUndefined();
    db.close();
  });

  it('binds named parameters', () => {
    const db = seed();
    expect(db.get<{ name: string }>('SELECT name FROM t WHERE n = @n', { n: 2 })).toEqual({
      name: 'beta',
    });
    db.close();
  });

  it('binds positional parameters', () => {
    const db = seed();
    expect(db.get<{ name: string }>('SELECT name FROM t WHERE n = ?', [1])).toEqual({
      name: 'alpha',
    });
    db.close();
  });

  it('iterates without materialising the result', () => {
    const db = seed();
    const names = [...db.iterate<{ name: string }>('SELECT name FROM t ORDER BY n')].map(
      (r) => r.name,
    );
    expect(names).toEqual(['alpha', 'beta']);
    db.close();
  });

  it('reports rows changed and the inserted row id', () => {
    const db = seed();
    const result = db.run('INSERT INTO t (name, n) VALUES (@name, @n)', { name: 'gamma', n: 3 });
    expect(result.changes).toBe(1);
    expect(Number(result.lastInsertRowid)).toBe(3);
    db.close();
  });

  it('does not let pluck leak into a cached statement', () => {
    // pluck() is sticky on a better-sqlite3 statement. If the cache handed out the
    // same object, a later all() on the identical SQL would silently return scalars.
    const db = seed();
    const sql = 'SELECT name FROM t ORDER BY n';
    expect(db.all<{ name: string }>(sql)).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    expect(db.pluck<string>(sql)).toBe('alpha');
    expect(db.all<{ name: string }>(sql)).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    db.close();
  });

  it('reuses prepared statements across calls', () => {
    const db = seed();
    const spy = jest.spyOn(db.connection, 'prepare');
    const sql = 'SELECT name FROM t WHERE n = @n';
    db.get(sql, { n: 1 });
    db.get(sql, { n: 2 });
    db.get(sql, { n: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('wraps a malformed statement in a DatabaseError naming the SQL', () => {
    const db = Db.open({ path: ':memory:' });
    expect(() => db.get('SELECT * FROM nonexistent')).toThrow(DatabaseError);
    expect(() => db.get('SELECT * FROM nonexistent')).toThrow(/nonexistent/);
    db.close();
  });
});

describe('transactions', () => {
  const seed = (): Db => {
    const db = Db.open({ path: ':memory:' });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    return db;
  };

  it('commits on return', () => {
    const db = seed();
    db.transaction(() => {
      db.run('INSERT INTO t (n) VALUES (1)');
      db.run('INSERT INTO t (n) VALUES (2)');
    });
    expect(db.all('SELECT * FROM t')).toHaveLength(2);
    db.close();
  });

  it('rolls back every statement when the body throws', () => {
    const db = seed();
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (n) VALUES (1)');
        throw new Error('deliberate');
      }),
    ).toThrow('deliberate');
    expect(db.all('SELECT * FROM t')).toHaveLength(0);
    db.close();
  });

  it('returns the body result', () => {
    const db = seed();
    expect(db.transaction(() => 42)).toBe(42);
    db.close();
  });

  it('joins a nested transaction to the outer one via a savepoint', () => {
    const db = seed();
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t (n) VALUES (1)');
        db.transaction(() => {
          db.run('INSERT INTO t (n) VALUES (2)');
        });
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    // The inner transaction must not have committed independently.
    expect(db.all('SELECT * FROM t')).toHaveLength(0);
    db.close();
  });

  it('reports whether a transaction is open', () => {
    const db = seed();
    expect(db.inTransaction).toBe(false);
    db.transaction(() => {
      expect(db.inTransaction).toBe(true);
    });
    expect(db.inTransaction).toBe(false);
    db.close();
  });

  it('takes the write lock up front in an immediate transaction', () => {
    const db = tmpDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)');
    const other = openTmpDb({ path: db.connection.name, busyTimeoutMs: 50 });

    db.connection.exec('BEGIN IMMEDIATE');
    db.run('INSERT INTO t (n) VALUES (1)');
    let thrown: unknown;
    try {
      other.run('INSERT INTO t (n) VALUES (2)');
    } catch (err) {
      thrown = err;
    }
    db.connection.exec('COMMIT');

    expect(isBusyError(thrown)).toBe(true);
  });
});

describe('concurrency under WAL', () => {
  it('lets a reader proceed while a writer holds an open transaction', () => {
    // This is the property the whole design leans on: the periodic scanner reads the
    // file index on one connection while a transfer commits on another. Under the
    // default rollback journal the reader would block; under WAL it sees the
    // pre-transaction snapshot and never waits.
    const writer = tmpDb();
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    writer.run('INSERT INTO t (n) VALUES (1)');

    const reader = openTmpDb({ path: writer.connection.name, busyTimeoutMs: 100 });

    writer.connection.exec('BEGIN IMMEDIATE');
    writer.run('INSERT INTO t (n) VALUES (2)');

    // Mid-transaction: the reader sees the old snapshot, without blocking.
    expect(reader.all('SELECT * FROM t')).toHaveLength(1);

    writer.connection.exec('COMMIT');

    // After commit the reader sees the new row on its next statement.
    expect(reader.all('SELECT * FROM t')).toHaveLength(2);
  });

  it('serialises two writers rather than corrupting either', () => {
    const a = tmpDb();
    a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)');
    const b = openTmpDb({ path: a.connection.name });

    for (let i = 0; i < 50; i += 1) {
      (i % 2 === 0 ? a : b).run('INSERT INTO t (n) VALUES (@n)', { n: i });
    }

    expect(a.pluck<number>('SELECT count(*) FROM t')).toBe(50);
    expect(b.pluck<number>('SELECT count(*) FROM t')).toBe(50);
  });
});

describe('maintenance', () => {
  it('reports a healthy database as ok with no problems', () => {
    const db = tmpDb();
    db.exec('CREATE TABLE t (a INTEGER)');
    const result = db.integrityCheck();
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('finds no foreign key violations in a consistent database', () => {
    const db = tmpDb();
    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    `);
    db.run('INSERT INTO parent (id) VALUES (1)');
    db.run('INSERT INTO child (parent_id) VALUES (1)');
    expect(db.foreignKeyCheck()).toEqual([]);
  });

  it('checkpoints the WAL without error', () => {
    const db = tmpDb();
    db.exec('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t VALUES (1)');
    expect(() => db.checkpoint()).not.toThrow();
    expect(() => db.optimize()).not.toThrow();
  });
});

describe('schema version', () => {
  it('starts at zero', () => {
    const db = Db.open({ path: ':memory:' });
    expect(db.userVersion).toBe(0);
    db.close();
  });

  it('round-trips a version', () => {
    const db = Db.open({ path: ':memory:' });
    db.userVersion = 7;
    expect(db.userVersion).toBe(7);
    db.close();
  });

  it('rejects a non-integer or negative version', () => {
    const db = Db.open({ path: ':memory:' });
    expect(() => {
      db.userVersion = -1;
    }).toThrow(DatabaseError);
    expect(() => {
      db.userVersion = 1.5;
    }).toThrow(DatabaseError);
    db.close();
  });
});

describe('lifecycle', () => {
  it('is idempotent on close', () => {
    const db = tmpDb();
    db.close();
    expect(() => db.close()).not.toThrow();
    expect(db.isOpen).toBe(false);
  });

  it('refuses to run statements after close', () => {
    const db = tmpDb();
    db.close();
    expect(() => db.get('SELECT 1')).toThrow(/closed/);
  });
});

describe('error classification', () => {
  it('does not treat an arbitrary error as busy or constraint', () => {
    expect(isBusyError(new Error('nope'))).toBe(false);
    expect(isConstraintError(new Error('nope'))).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isConstraintError(null)).toBe(false);
  });
});
