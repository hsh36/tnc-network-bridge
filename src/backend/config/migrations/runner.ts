import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Db, DatabaseError, type DbLogger } from '../db';

/**
 * Forward-only migration runner (decision D7).
 *
 * There are no down-migrations. On a device an operator cannot easily reach, a failed
 * down-migration is worse than no down-migration: the recovery path is to restore the
 * database file, not to run more SQL against a half-transformed schema. Rolling the
 * *application* back is handled by keeping the previous release (T43); the schema only
 * ever moves forward.
 *
 * `PRAGMA user_version` is the authoritative schema version. The `schema_migrations`
 * table alongside it is a ledger — it records what ran, when, and the checksum of the
 * file that ran, so an edited migration is caught rather than silently skipped.
 */

const FILENAME_PATTERN = /^(\d{3,})_([a-z0-9_-]+)\.sql$/;

/**
 * Marker that opts a migration out of the runner's transaction.
 * Needed only for the rare rebuild that must toggle `PRAGMA foreign_keys`, which
 * SQLite ignores inside a transaction.
 */
const NO_TRANSACTION_MARKER = '-- tnc-bridge: no-transaction';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
  readonly filename: string;
  readonly transactional: boolean;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly durationMs: number;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly AppliedMigration[];
}

export interface RunMigrationsOptions {
  /** Directory holding the numbered `.sql` files. Defaults to this module's own folder. */
  readonly directory?: string;
  readonly logger?: DbLogger;
  /**
   * What to do when the database's schema is newer than the code knows about — which
   * is exactly what a release rollback produces (T43). Defaults to `warn`, so a
   * rollback still boots; `throw` is available for tooling that must be certain.
   */
  readonly onSchemaAhead?: 'warn' | 'throw';
  /** What to do when an already-applied migration file's checksum no longer matches. */
  readonly onChecksumMismatch?: 'warn' | 'throw';
}

const sha256 = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export const DEFAULT_MIGRATIONS_DIR = __dirname;

/**
 * Reads and validates the migration set.
 *
 * Validation is strict on purpose. A duplicated number, a gap in the sequence or a
 * stray `COMMIT` inside a file all produce a database that is subtly wrong rather
 * than obviously broken, and all three are cheap to rule out here.
 */
export function loadMigrations(directory: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (err) {
    throw new DatabaseError(`Cannot read migrations directory: ${directory}`, err);
  }

  const migrations: Migration[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.sql')) {
      continue;
    }
    const match = FILENAME_PATTERN.exec(filename);
    if (match === null) {
      throw new DatabaseError(
        `Migration filename "${filename}" does not match NNN_lowercase_name.sql`,
      );
    }
    const version = Number(match[1]);
    const name = match[2] ?? '';
    if (version < 1) {
      throw new DatabaseError(`Migration "${filename}" must be numbered from 001 upwards`);
    }

    const sql = readFileSync(join(directory, filename), 'utf8');
    const transactional = !sql.includes(NO_TRANSACTION_MARKER);
    if (transactional && /^\s*(BEGIN|COMMIT|ROLLBACK|END)\b/im.test(sql)) {
      throw new DatabaseError(
        `Migration "${filename}" manages its own transaction. The runner wraps every ` +
          `migration in one; remove the BEGIN/COMMIT or opt out with "${NO_TRANSACTION_MARKER}".`,
      );
    }

    migrations.push({ version, name, sql, checksum: sha256(sql), filename, transactional });
  }

  migrations.sort((a, b) => a.version - b.version);

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      const previous = migrations[index - 1];
      throw new DatabaseError(
        previous?.version === migration.version
          ? `Duplicate migration number ${migration.version} (${previous.filename}, ${migration.filename})`
          : `Migration numbering has a gap: expected ${expected}, found ${migration.version} (${migration.filename})`,
      );
    }
  });

  return migrations;
}

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  checksum    TEXT    NOT NULL,
  applied_at  INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL
);`;

interface LedgerRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Brings the database up to the latest schema version.
 *
 * Idempotent: running it against an already-current database applies nothing and
 * returns an empty `applied` list, which is what makes it safe on every service start.
 */
export function runMigrations(db: Db, options: RunMigrationsOptions = {}): MigrationResult {
  const logger = options.logger;
  const migrations = loadMigrations(options.directory ?? DEFAULT_MIGRATIONS_DIR);
  const latest = migrations.at(-1)?.version ?? 0;
  const current = db.userVersion;

  db.exec(LEDGER_DDL);

  if (current > latest) {
    const message =
      `Database schema is at version ${current} but this build only knows ${latest}. ` +
      `This usually means the application was rolled back to an older release.`;
    if (options.onSchemaAhead === 'throw') {
      throw new DatabaseError(message);
    }
    logger?.warn({ current, latest }, message);
    return { fromVersion: current, toVersion: current, applied: [] };
  }

  verifyAppliedChecksums(db, migrations, current, options, logger);

  if (current === latest) {
    logger?.debug({ version: current }, 'schema is up to date');
    return { fromVersion: current, toVersion: current, applied: [] };
  }

  const pending = migrations.filter((m) => m.version > current);
  logger?.info(
    { from: current, to: latest, count: pending.length },
    'applying database migrations',
  );

  const applied: AppliedMigration[] = [];
  for (const migration of pending) {
    const startedAt = Date.now();
    try {
      // One transaction per file. A failure inside leaves the database exactly as it
      // was — including `user_version`, which is itself transactional in SQLite, so a
      // half-applied migration cannot be mistaken for a complete one.
      const apply = (): void => {
        db.exec(migration.sql);
        db.userVersion = migration.version;
        db.run(
          `INSERT OR REPLACE INTO schema_migrations
             (version, name, checksum, applied_at, duration_ms)
           VALUES (@version, @name, @checksum, @appliedAt, @durationMs)`,
          {
            version: migration.version,
            name: migration.name,
            checksum: migration.checksum,
            appliedAt: Math.floor(Date.now() / 1000),
            durationMs: Date.now() - startedAt,
          },
        );
      };

      if (migration.transactional) {
        db.transaction(apply);
      } else {
        apply();
      }
    } catch (err) {
      throw new DatabaseError(
        `Migration ${migration.filename} failed and was rolled back. ` +
          `The database remains at version ${db.userVersion}.`,
        err,
      );
    }

    const durationMs = Date.now() - startedAt;
    applied.push({ version: migration.version, name: migration.name, durationMs });
    logger?.info(
      { version: migration.version, name: migration.name, durationMs },
      'migration applied',
    );
  }

  return { fromVersion: current, toVersion: db.userVersion, applied };
}

/**
 * Compares the ledger against the files on disk.
 *
 * A mismatch means a migration that already ran has since been edited — so the
 * database does not contain what the repository says it contains. That is a
 * development-time mistake, and it is much cheaper to catch here than to debug later.
 */
function verifyAppliedChecksums(
  db: Db,
  migrations: readonly Migration[],
  current: number,
  options: RunMigrationsOptions,
  logger: DbLogger | undefined,
): void {
  if (current === 0) {
    return;
  }
  const ledger = new Map(
    db.all<LedgerRow>('SELECT version, name, checksum FROM schema_migrations').map((row) => [
      row.version,
      row,
    ]),
  );

  for (const migration of migrations) {
    if (migration.version > current) {
      break;
    }
    const row = ledger.get(migration.version);
    if (row === undefined) {
      // Applied before the ledger existed. Backfill rather than complain.
      db.run(
        `INSERT OR IGNORE INTO schema_migrations
           (version, name, checksum, applied_at, duration_ms)
         VALUES (@version, @name, @checksum, @appliedAt, 0)`,
        {
          version: migration.version,
          name: migration.name,
          checksum: migration.checksum,
          appliedAt: Math.floor(Date.now() / 1000),
        },
      );
      continue;
    }
    if (row.checksum !== migration.checksum) {
      const message =
        `Migration ${migration.filename} has changed since it was applied ` +
        `(recorded ${row.checksum.slice(0, 12)}, file ${migration.checksum.slice(0, 12)}). ` +
        `Applied migrations are immutable — add a new migration instead.`;
      if (options.onChecksumMismatch === 'throw') {
        throw new DatabaseError(message);
      }
      logger?.warn({ version: migration.version }, message);
    }
  }
}

/** The schema version this build expects, for the `--check` self-test and `/health`. */
export function latestSchemaVersion(directory: string = DEFAULT_MIGRATIONS_DIR): number {
  return loadMigrations(directory).at(-1)?.version ?? 0;
}
