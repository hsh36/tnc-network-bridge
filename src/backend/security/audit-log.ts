import { type Db, type DbLogger } from '../config/db';

/**
 * The audit log (T43): who changed what, when, and whether it worked.
 *
 * Distinct from the application log on purpose. The application log is diagnostic — it
 * is verbose, it is rotated aggressively, and its level is operator-tunable, which means
 * it can be turned down to the point of saying nothing. The audit log answers a
 * different question ("who force-released that lock at 03:00?") and must therefore be
 * unaffected by log level, unaffected by rotation, and never silently disabled.
 *
 * ## Append-only
 *
 * There is no update and no delete on this class, by construction. Enforcement is at the
 * schema level too — {@link installAuditGuards} adds triggers that raise on any UPDATE or
 * DELETE against `audit_log`, so even a direct `sqlite3` session or a future code path
 * that forgets the rule is refused. An audit trail an application can rewrite is not an
 * audit trail.
 *
 * Retention is deliberately *not* implemented here as a delete. Trimming is done by
 * {@link AuditLog.export} plus an operator archiving the result; the only automated
 * removal path is the explicit, audited {@link AuditLog.truncateBefore}, which records
 * its own execution before it removes anything.
 *
 * ## Never throws into the caller
 *
 * A failed audit write must not fail the action it describes — an operator locked out of
 * their own bridge because the audit table is full is a worse outcome than a missing
 * line. Failures are reported to the application log and swallowed.
 */

export const AUDIT_RESULTS = ['ok', 'denied', 'error'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];

export interface AuditEntry {
  /** `admin`, `token:<name>`, `system`, or `schedule:<id>`. */
  readonly actor: string;
  /** Dotted verb: `config.update`, `version.restore`, `lock.release`. */
  readonly action: string;
  readonly target?: string;
  readonly ip?: string;
  readonly result?: AuditResult;
  readonly detail?: string;
}

export interface AuditRecord extends AuditEntry {
  readonly id: number;
  readonly ts: number;
}

export interface AuditQuery {
  readonly action?: string;
  readonly actor?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  readonly offset?: number;
}

interface AuditRow {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  ip: string | null;
  result: string | null;
  detail: string | null;
}

function toRecord(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor,
    action: row.action,
    ...(row.target !== null ? { target: row.target } : {}),
    ...(row.ip !== null ? { ip: row.ip } : {}),
    ...(row.result !== null ? { result: row.result as AuditResult } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
  };
}

/**
 * Installs triggers making `audit_log` append-only at the database level.
 *
 * Idempotent, so it is safe to call on every start. It is called from the service
 * bootstrap rather than from a migration because it must be re-asserted if anyone ever
 * drops the triggers — a migration runs once and would not notice.
 */
export function installAuditGuards(db: Db): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `);
}

/** Temporarily lifts the delete guard. The only sanctioned path is {@link AuditLog.truncateBefore}. */
function withDeleteAllowed<T>(db: Db, fn: () => T): T {
  db.exec('DROP TRIGGER IF EXISTS audit_log_no_delete');
  try {
    return fn();
  } finally {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
        BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `);
  }
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly logger?: DbLogger,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * Appends one entry. Never throws — see the class note on why an audit failure must
   * not take down the operation it was describing.
   */
  record(entry: AuditEntry): void {
    try {
      this.db.run(
        `INSERT INTO audit_log (ts, actor, action, target, ip, result, detail)
         VALUES (@ts, @actor, @action, @target, @ip, @result, @detail)`,
        {
          ts: this.now(),
          actor: entry.actor,
          action: entry.action,
          target: entry.target ?? null,
          ip: entry.ip ?? null,
          result: entry.result ?? 'ok',
          detail: entry.detail ?? null,
        },
      );
    } catch (err) {
      this.logger?.error({ err, action: entry.action }, 'failed to write an audit entry');
    }
  }

  /** Records a denied attempt. Separate method so the call sites read as intent. */
  recordDenied(entry: Omit<AuditEntry, 'result'>): void {
    this.record({ ...entry, result: 'denied' });
  }

  query(options: AuditQuery = {}): { items: AuditRecord[]; total: number } {
    const where: string[] = [];
    const params: Record<string, string | number> = {};

    if (options.action !== undefined) {
      // Prefix match, so `config` finds `config.update` and `config.testSmb`.
      where.push('(action = @action OR action LIKE @actionPrefix)');
      params.action = options.action;
      params.actionPrefix = `${options.action}.%`;
    }
    if (options.actor !== undefined) {
      where.push('actor = @actor');
      params.actor = options.actor;
    }
    if (options.since !== undefined) {
      where.push('ts >= @since');
      params.since = options.since;
    }
    if (options.until !== undefined) {
      where.push('ts <= @until');
      params.until = options.until;
    }

    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.pluck<number>(`SELECT count(*) FROM audit_log ${clause}`, params) ?? 0;
    const rows = this.db.all<AuditRow>(
      `SELECT * FROM audit_log ${clause} ORDER BY ts DESC, id DESC LIMIT @limit OFFSET @offset`,
      { ...params, limit: options.limit ?? 100, offset: options.offset ?? 0 },
    );

    return { items: rows.map(toRecord), total };
  }

  /** Streams matching entries without materialising them — for a large CSV/JSON export. */
  *stream(options: AuditQuery = {}): IterableIterator<AuditRecord> {
    const { items } = this.query({ ...options, limit: 1000, offset: options.offset ?? 0 });
    let page = items;
    let offset = options.offset ?? 0;
    while (page.length > 0) {
      for (const record of page) {
        yield record;
      }
      if (page.length < 1000) {
        return;
      }
      offset += page.length;
      page = this.query({ ...options, limit: 1000, offset }).items;
    }
  }

  /**
   * Removes entries older than `cutoff`, recording that it did so *first*.
   *
   * The ordering is the point: the record of the truncation is written before, and
   * therefore survives, the truncation itself. An operator reading the log always sees
   * that history was trimmed, and by whom.
   */
  truncateBefore(cutoff: number, actor: string): number {
    const doomed =
      this.db.pluck<number>('SELECT count(*) FROM audit_log WHERE ts < @cutoff', {
        cutoff,
      }) ?? 0;
    if (doomed === 0) {
      return 0;
    }

    this.record({
      actor,
      action: 'audit.truncate',
      result: 'ok',
      detail: `removing ${String(doomed)} entries older than ${String(cutoff)}`,
    });

    return withDeleteAllowed(this.db, () => {
      const result = this.db.run('DELETE FROM audit_log WHERE ts < @cutoff', { cutoff });
      return result.changes;
    });
  }
}
