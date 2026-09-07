import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db, type DbOptions } from '../../src/backend/config/db';

/**
 * Scratch databases for tests.
 *
 * Several behaviours under test — WAL concurrency, checkpointing, busy timeouts —
 * only exist for on-disk databases, so tests that care must not use `:memory:`.
 * Every handle and directory created here is tracked and torn down by
 * {@link cleanupTmpDbs}, which fails loudly rather than leaking temp files.
 */

const directories: string[] = [];
const handles: Db[] = [];

export function tmpDir(prefix = 'tnc-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

/** An on-disk database in a fresh temp directory. */
export function tmpDb(options: Partial<DbOptions> = {}): Db {
  const path = join(tmpDir(), 'bridge.db');
  return openTmpDb({ ...options, path });
}

/** A second (or third) connection to an existing database file. */
export function openTmpDb(options: DbOptions): Db {
  const db = Db.open(options);
  handles.push(db);
  return db;
}

export function cleanupTmpDbs(): void {
  while (handles.length > 0) {
    handles.pop()?.close();
  }
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
