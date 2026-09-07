import BetterSqlite3, { type Database as RawDatabase, type Statement } from 'better-sqlite3';

/**
 * The database layer: a thin, typed wrapper over better-sqlite3.
 *
 * Deliberately not an ORM (decision D7). The schema is small, the queries are
 * hand-written and reviewable, and better-sqlite3's synchronous API removes a whole
 * class of interleaving bugs — every statement either completes or throws before the
 * next line runs.
 *
 * The one thing that *is* asynchronous is other processes: `smbd` and a second bridge
 * connection can touch the same file. WAL plus a busy timeout is what makes that safe,
 * so both are configured here rather than left to callers.
 */

/** Values SQLite can store natively. Everything else must be serialised by the caller. */
export type SqlValue = string | number | bigint | Buffer | null;

/** Positional or named bindings. Named bindings are strongly preferred in new code. */
export type SqlParams = readonly SqlValue[] | Record<string, SqlValue>;

export interface DbLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

const NOOP_LOGGER: DbLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface DbOptions {
  /** Filesystem path, or `:memory:` for a private in-memory database. */
  readonly path: string;
  /** Open without write access. Migrations are refused on a read-only handle. */
  readonly readonly?: boolean;
  /**
   * How long a statement waits for a competing writer before throwing SQLITE_BUSY.
   * The default matches the plan; tests lower it so a contention case fails fast.
   */
  readonly busyTimeoutMs?: number;
  readonly logger?: DbLogger;
}

/** SQLite result codes this system reacts to by name rather than by message text. */
export const SQLITE_BUSY_CODES = ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'] as const;

export class DatabaseError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseError';
  }
}

const errorCodeOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
    ? err.code
    : undefined;

/** True when the failure is contention rather than a defect — i.e. worth retrying. */
export const isBusyError = (err: unknown): boolean => {
  const code = errorCodeOf(err);
  return code !== undefined && SQLITE_BUSY_CODES.some((c) => code.startsWith(c));
};

/** True when a CHECK, UNIQUE, NOT NULL or FOREIGN KEY constraint rejected the write. */
export const isConstraintError = (err: unknown): boolean =>
  errorCodeOf(err)?.startsWith('SQLITE_CONSTRAINT') ?? false;

export interface IntegrityCheckResult {
  readonly ok: boolean;
  /** Empty when `ok`. SQLite reports the single row `ok` on a healthy database. */
  readonly problems: readonly string[];
  readonly durationMs: number;
}

export class Db {
  private readonly statementCache = new Map<string, Statement>();
  private closed = false;

  private constructor(
    private readonly raw: RawDatabase,
    private readonly logger: DbLogger,
  ) {}

  /**
   * Opens a connection and applies the pragmas from IMPLEMENTATION_PLAN §2.
   *
   * WAL is what lets the scanner read while a transfer commits, so it is applied on
   * every connection rather than assumed to be sticky. `foreign_keys` genuinely is
   * per-connection — SQLite defaults it off, and a connection that forgot it would
   * silently orphan rows on share deletion.
   */
  static open(options: DbOptions): Db {
    const logger = options.logger ?? NOOP_LOGGER;
    const raw = new BetterSqlite3(
      options.path,
      options.readonly === true ? { readonly: true } : {},
    );
    const db = new Db(raw, logger);

    const inMemory = options.path === ':memory:' || options.path === '';
    if (!inMemory) {
      // WAL is a persistent property of the file, but setting it is idempotent and
      // guarantees we never run against a database someone left in journal mode.
      const mode = raw.pragma('journal_mode = WAL', { simple: true });
      if (mode !== 'wal' && options.readonly !== true) {
        throw new DatabaseError(`Could not enable WAL journal mode (got "${String(mode)}")`);
      }
    }

    // NORMAL is the right trade for WAL: durable across process crashes, and only at
    // risk from an OS-level crash — which on this hardware means a power cut, where a
    // half-synced file index is the least of the operator's problems.
    raw.pragma('synchronous = NORMAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);

    logger.debug({ path: options.path, readonly: options.readonly === true }, 'database opened');
    return db;
  }

  /** Escape hatch for the few places that need better-sqlite3 directly (backup, pragma). */
  get connection(): RawDatabase {
    return this.raw;
  }

  get isOpen(): boolean {
    return !this.closed && this.raw.open;
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  /**
   * Prepares a statement, reusing the compiled plan across calls.
   *
   * Preparation dominates the cost of the small, hot queries this system runs — the
   * file index is touched once per file per scan — so the cache is not premature.
   * Statements are never handed out with `pluck`/`raw` set, because those flags are
   * sticky and would corrupt an unrelated caller sharing the cached statement.
   */
  private cached(sql: string): Statement {
    this.assertOpen();
    let stmt = this.statementCache.get(sql);
    if (stmt === undefined) {
      try {
        stmt = this.raw.prepare(sql);
      } catch (err) {
        throw new DatabaseError(`Failed to prepare statement: ${sql}`, err);
      }
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DatabaseError('Database handle is closed');
    }
  }

  /**
   * Returns the first matching row, or `undefined`.
   *
   * The caller declares the row type. That is an assertion, not a proof: SQLite is
   * dynamically typed and a schema change can invalidate it silently, which is why
   * every row shape that crosses a subsystem boundary is re-validated with Zod.
   */
  get<Row>(sql: string, params?: SqlParams): Row | undefined {
    const stmt = this.cached(sql);
    return (params === undefined ? stmt.get() : stmt.get(params)) as Row | undefined;
  }

  all<Row>(sql: string, params?: SqlParams): Row[] {
    const stmt = this.cached(sql);
    return (params === undefined ? stmt.all() : stmt.all(params)) as Row[];
  }

  /** Streams rows without materialising the whole result — used by the scanner (T15). */
  *iterate<Row>(sql: string, params?: SqlParams): IterableIterator<Row> {
    const stmt = this.cached(sql);
    const iterator = params === undefined ? stmt.iterate() : stmt.iterate(params);
    for (const row of iterator) {
      yield row as Row;
    }
  }

  run(sql: string, params?: SqlParams): BetterSqlite3.RunResult {
    const stmt = this.cached(sql);
    return params === undefined ? stmt.run() : stmt.run(params);
  }

  /** Reads a single scalar. Uses an uncached statement so `pluck` cannot leak. */
  pluck<T>(sql: string, params?: SqlParams): T | undefined {
    this.assertOpen();
    const stmt = this.raw.prepare(sql).pluck(true);
    return (params === undefined ? stmt.get() : stmt.get(params)) as T | undefined;
  }

  /** Executes raw SQL, possibly several statements. Not parameterised — never pass input. */
  exec(sql: string): void {
    this.assertOpen();
    this.raw.exec(sql);
  }

  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on throw.
   *
   * Nested calls join the outer transaction via a savepoint, which is better-sqlite3's
   * behaviour and the one we want: a helper that needs atomicity should not care
   * whether its caller already opened a transaction.
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen();
    return this.raw.transaction(fn)();
  }

  /**
   * Transaction that takes the write lock immediately rather than on first write.
   *
   * Use where a read informs a later write in the same transaction — the read-then-
   * upgrade path is what produces SQLITE_BUSY_SNAPSHOT under concurrency, and the
   * lock manager's check-then-insert (T24) is exactly that shape.
   */
  immediateTransaction<T>(fn: () => T): T {
    this.assertOpen();
    return this.raw.transaction(fn).immediate();
  }

  /** Current schema version. The migration runner's only state (T3). */
  get userVersion(): number {
    return Number(this.raw.pragma('user_version', { simple: true }));
  }

  set userVersion(version: number) {
    if (!Number.isInteger(version) || version < 0) {
      throw new DatabaseError(`Invalid schema version: ${String(version)}`);
    }
    // Interpolated, not bound: SQLite does not accept parameters in a PRAGMA.
    // Safe because the value is proven to be a non-negative integer above.
    this.raw.pragma(`user_version = ${version}`);
  }

  /**
   * Full structural verification. Runs nightly (T41) — it reads every page, so it is
   * far too expensive for a startup path or a request.
   */
  integrityCheck(): IntegrityCheckResult {
    this.assertOpen();
    const startedAt = Date.now();
    const rows = this.raw.pragma('integrity_check') as { integrity_check: string }[];
    const problems = rows
      .map((r) => r.integrity_check)
      .filter((value) => value.toLowerCase() !== 'ok');
    const result: IntegrityCheckResult = {
      ok: problems.length === 0,
      problems,
      durationMs: Date.now() - startedAt,
    };
    if (!result.ok) {
      this.logger.error({ problems: result.problems }, 'database integrity check failed');
    }
    return result;
  }

  /** Verifies that no row violates a foreign key. Complements `integrityCheck`. */
  foreignKeyCheck(): readonly string[] {
    this.assertOpen();
    const rows = this.raw.pragma('foreign_key_check') as Record<string, unknown>[];
    return rows.map((r) => JSON.stringify(r));
  }

  /**
   * Folds the WAL back into the main database file.
   *
   * Called on graceful shutdown (T8). Without it the WAL can be left holding recent
   * writes, which is safe but means a restart replays them — and on an SD card the
   * unbounded growth of an un-checkpointed WAL is a real failure mode.
   */
  checkpoint(mode: 'PASSIVE' | 'FULL' | 'TRUNCATE' = 'TRUNCATE'): void {
    this.assertOpen();
    this.raw.pragma(`wal_checkpoint(${mode})`);
  }

  /** Reclaims free pages. Nightly, alongside the integrity check. */
  optimize(): void {
    this.assertOpen();
    this.raw.pragma('optimize');
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.statementCache.clear();
    try {
      if (this.raw.open) {
        // Checkpoint before closing so the next start does not have to replay the WAL.
        if (!this.raw.readonly) {
          this.raw.pragma('wal_checkpoint(TRUNCATE)');
        }
        this.raw.close();
      }
    } catch (err) {
      this.logger.warn({ err }, 'error while closing the database');
    }
  }
}
