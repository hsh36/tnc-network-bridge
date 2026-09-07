import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpDbs, tmpDir, tmpDb } from '../../../../tests/support/tmp-db';
import { Db, DatabaseError } from '../db';
import { latestSchemaVersion, loadMigrations, runMigrations } from './runner';

afterEach(() => {
  cleanupTmpDbs();
});

/** Builds a scratch migrations directory from `{ filename: sql }`. */
function migrationsDir(files: Record<string, string>): string {
  const dir = tmpDir('tnc-migrations-');
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql, 'utf8');
  }
  return dir;
}

const memoryDb = (): Db => Db.open({ path: ':memory:' });

describe('loadMigrations', () => {
  it('returns migrations in ascending version order regardless of directory order', () => {
    const dir = migrationsDir({
      '003_c.sql': 'CREATE TABLE c (x);',
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_b.sql': 'CREATE TABLE b (x);',
    });
    const loaded = loadMigrations(dir);
    expect(loaded.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(loaded.map((m) => m.name)).toEqual(['a', 'b', 'c']);
  });

  it('ignores non-SQL files', () => {
    const dir = migrationsDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      'README.md': '# notes',
      'runner.ts': 'export {};',
    });
    expect(loadMigrations(dir)).toHaveLength(1);
  });

  it('rejects a filename that does not match the convention', () => {
    const dir = migrationsDir({ 'init.sql': 'CREATE TABLE a (x);' });
    expect(() => loadMigrations(dir)).toThrow(/does not match/);
  });

  it('rejects a gap in the numbering', () => {
    const dir = migrationsDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '003_c.sql': 'CREATE TABLE c (x);',
    });
    expect(() => loadMigrations(dir)).toThrow(/gap/);
  });

  it('rejects a duplicated number', () => {
    const dir = migrationsDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '001_b.sql': 'CREATE TABLE b (x);',
    });
    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration number/);
  });

  it('rejects a migration that opens its own transaction', () => {
    const dir = migrationsDir({
      '001_a.sql': 'BEGIN;\nCREATE TABLE a (x);\nCOMMIT;',
    });
    expect(() => loadMigrations(dir)).toThrow(/manages its own transaction/);
  });

  it('allows an explicit opt-out of the runner transaction', () => {
    const dir = migrationsDir({
      '001_a.sql': '-- tnc-bridge: no-transaction\nPRAGMA foreign_keys=OFF;\nCREATE TABLE a (x);',
    });
    const [migration] = loadMigrations(dir);
    expect(migration?.transactional).toBe(false);
  });

  it('throws a clear error for a missing directory', () => {
    expect(() => loadMigrations(join(tmpDir(), 'nope'))).toThrow(DatabaseError);
  });

  it('reports the latest version', () => {
    const dir = migrationsDir({
      '001_a.sql': 'CREATE TABLE a (x);',
      '002_b.sql': 'CREATE TABLE b (x);',
    });
    expect(latestSchemaVersion(dir)).toBe(2);
  });
});

describe('runMigrations', () => {
  const twoMigrations = (): string =>
    migrationsDir({
      '001_init.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
      '002_more.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
    });

  it('applies every migration to an empty database', () => {
    const db = memoryDb();
    const dir = twoMigrations();
    const result = runMigrations(db, { directory: dir });

    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(2);
    expect(result.applied.map((a) => a.version)).toEqual([1, 2]);
    expect(db.userVersion).toBe(2);
    expect(
      db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b') ORDER BY name",
      ),
    ).toEqual([{ name: 'a' }, { name: 'b' }]);
    db.close();
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = memoryDb();
    const dir = twoMigrations();
    runMigrations(db, { directory: dir });
    const second = runMigrations(db, { directory: dir });

    expect(second.applied).toEqual([]);
    expect(second.fromVersion).toBe(2);
    expect(second.toVersion).toBe(2);
    db.close();
  });

  it('survives a restart — reopening and rerunning changes nothing', () => {
    const db = tmpDb();
    const path = db.connection.name;
    const dir = twoMigrations();
    runMigrations(db, { directory: dir });
    db.close();

    const reopened = Db.open({ path });
    const result = runMigrations(reopened, { directory: dir });
    expect(result.applied).toEqual([]);
    expect(reopened.userVersion).toBe(2);
    reopened.close();
  });

  it('applies only the migrations newer than the current version', () => {
    const db = memoryDb();
    const dir = migrationsDir({ '001_init.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);' });
    runMigrations(db, { directory: dir });

    writeFileSync(join(dir, '002_more.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);', 'utf8');
    const result = runMigrations(db, { directory: dir });

    expect(result.applied.map((a) => a.version)).toEqual([2]);
    expect(db.userVersion).toBe(2);
    db.close();
  });

  it('records every applied migration in the ledger', () => {
    const db = memoryDb();
    runMigrations(db, { directory: twoMigrations() });
    const rows = db.all<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.map((r) => r.name)).toEqual(['init', 'more']);
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    db.close();
  });

  describe('a failing migration', () => {
    const brokenSet = (): string =>
      migrationsDir({
        '001_init.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
        '002_broken.sql': `
          CREATE TABLE b (id INTEGER PRIMARY KEY);
          INSERT INTO b (id) VALUES (1);
          THIS IS NOT VALID SQL;
        `,
      });

    it('throws with the failing filename', () => {
      const db = memoryDb();
      expect(() => runMigrations(db, { directory: brokenSet() })).toThrow(/002_broken\.sql/);
      db.close();
    });

    it('rolls back cleanly — no partial schema, no version bump', () => {
      const db = memoryDb();
      expect(() => runMigrations(db, { directory: brokenSet() })).toThrow();

      // Migration 1 committed in its own transaction and stays.
      expect(db.userVersion).toBe(1);
      expect(
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='a'"),
      ).toBeDefined();
      // Everything migration 2 did — including the table it created before the bad
      // statement — must be gone.
      expect(
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='b'"),
      ).toBeUndefined();
      expect(db.inTransaction).toBe(false);
      db.close();
    });

    it('leaves the database usable, and retryable once the migration is fixed', () => {
      const db = memoryDb();
      const dir = brokenSet();
      expect(() => runMigrations(db, { directory: dir })).toThrow();

      writeFileSync(join(dir, '002_broken.sql'), 'CREATE TABLE b (id INTEGER PRIMARY KEY);', 'utf8');
      const result = runMigrations(db, { directory: dir });
      expect(result.applied.map((a) => a.version)).toEqual([2]);
      expect(db.userVersion).toBe(2);
      db.close();
    });
  });

  describe('forward-only guarantees', () => {
    it('warns and does nothing when the schema is ahead of the code', () => {
      const db = memoryDb();
      const dir = twoMigrations();
      runMigrations(db, { directory: dir });
      // Simulate a release rollback: the database was migrated by a newer build.
      db.userVersion = 5;

      const warn = jest.fn();
      const result = runMigrations(db, {
        directory: dir,
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
      });

      expect(result.applied).toEqual([]);
      expect(result.toVersion).toBe(5);
      expect(warn).toHaveBeenCalled();
      db.close();
    });

    it('can be told to refuse to run against a newer schema', () => {
      const db = memoryDb();
      const dir = twoMigrations();
      runMigrations(db, { directory: dir });
      db.userVersion = 5;

      expect(() => runMigrations(db, { directory: dir, onSchemaAhead: 'throw' })).toThrow(
        /rolled back to an older release/,
      );
      db.close();
    });

    it('detects a migration that was edited after it was applied', () => {
      const db = memoryDb();
      const dir = twoMigrations();
      runMigrations(db, { directory: dir });

      writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);');

      expect(() => runMigrations(db, { directory: dir, onChecksumMismatch: 'throw' })).toThrow(
        /has changed since it was applied/,
      );
      db.close();
    });

    it('warns rather than throwing about an edited migration by default', () => {
      const db = memoryDb();
      const dir = twoMigrations();
      runMigrations(db, { directory: dir });
      writeFileSync(join(dir, '001_init.sql'), 'CREATE TABLE a (id INTEGER PRIMARY KEY, x TEXT);');

      const warn = jest.fn();
      expect(() =>
        runMigrations(db, {
          directory: dir,
          logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
        }),
      ).not.toThrow();
      expect(warn).toHaveBeenCalled();
      db.close();
    });

    it('backfills the ledger for a database migrated before it existed', () => {
      const db = memoryDb();
      const dir = twoMigrations();
      runMigrations(db, { directory: dir });
      db.exec('DELETE FROM schema_migrations');

      runMigrations(db, { directory: dir });
      expect(db.pluck<number>('SELECT count(*) FROM schema_migrations')).toBe(2);
      db.close();
    });
  });
});
