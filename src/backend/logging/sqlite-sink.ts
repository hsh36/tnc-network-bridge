import { Writable } from 'node:stream';
import { type LogLevel, type LogSource } from '../../shared';
import { type Db } from '../config/db';

/**
 * The sink behind the UI log viewer.
 *
 * pino writes NDJSON; this parses each line and stores it as a queryable row. The
 * viewer needs filtering by level, source, time range and free text, which a file
 * tail cannot provide — and the operator using it is on a shop-floor panel, not an
 * SSH session.
 *
 * A malformed or oversized line is counted and dropped. Logging must never be able
 * to fail the operation that produced the log line.
 */

const PINO_LEVELS: Record<number, LogLevel> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

const KNOWN_SOURCES = new Set<string>([
  'app',
  'sync',
  'smb',
  'lock',
  'auth',
  'audit',
  'update',
  'system',
]);

/** Fields pino adds or that are promoted to their own column. */
const RESERVED_FIELDS = new Set([
  'level',
  'time',
  'msg',
  'pid',
  'hostname',
  'source',
  'requestId',
  'shareId',
]);

/** Serialised context is truncated rather than allowed to bloat the database. */
const MAX_CONTEXT_BYTES = 8192;
const MAX_MESSAGE_CHARS = 4000;

export interface SqliteSinkOptions {
  readonly db: Db;
  /** Entries below this level are not persisted. Defaults to storing everything pino emits. */
  readonly minLevel?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export class SqliteLogSink extends Writable {
  private readonly db: Db;
  private readonly minLevelValue: number;
  private droppedCount = 0;
  private writtenCount = 0;

  constructor(options: SqliteSinkOptions) {
    super({ decodeStrings: false });
    this.db = options.db;
    this.minLevelValue = options.minLevel === undefined ? 0 : LEVEL_ORDER[options.minLevel];
  }

  /** Lines dropped as unparseable. Surfaced as a metric so silent loss is visible. */
  get dropped(): number {
    return this.droppedCount;
  }

  get written(): number {
    return this.writtenCount;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() !== '') {
        this.ingest(line);
      }
    }
    callback();
  }

  private ingest(line: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        this.droppedCount += 1;
        return;
      }
      record = parsed as Record<string, unknown>;
    } catch {
      this.droppedCount += 1;
      return;
    }

    const levelNumber = typeof record.level === 'number' ? record.level : 30;
    const level = PINO_LEVELS[levelNumber] ?? 'info';
    if (LEVEL_ORDER[level] < this.minLevelValue) {
      return;
    }

    const rawSource = typeof record.source === 'string' ? record.source : 'app';
    const source: LogSource = (KNOWN_SOURCES.has(rawSource) ? rawSource : 'app') as LogSource;

    const context: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!RESERVED_FIELDS.has(key)) {
        context[key] = value;
      }
    }
    let contextJson: string | null = null;
    if (Object.keys(context).length > 0) {
      const serialised = safeStringify(context);
      contextJson =
        serialised.length > MAX_CONTEXT_BYTES ? serialised.slice(0, MAX_CONTEXT_BYTES) : serialised;
    }

    try {
      this.db.run(
        `INSERT INTO log_entries (ts, level, source, message, request_id, share_id, context)
         VALUES (@ts, @level, @source, @message, @requestId, @shareId, @context)`,
        {
          ts: typeof record.time === 'number' ? record.time : Date.now(),
          level,
          source,
          message: coerceMessage(record.msg).slice(0, MAX_MESSAGE_CHARS),
          requestId: typeof record.requestId === 'string' ? record.requestId : null,
          shareId: typeof record.shareId === 'number' ? record.shareId : null,
          context: contextJson,
        },
      );
      this.writtenCount += 1;
    } catch {
      // The database may be closing during shutdown, or locked. Losing a log row is
      // always preferable to propagating the failure into the caller.
      this.droppedCount += 1;
    }
  }
}

/**
 * Deletes entries older than the retention window. Run nightly (T41).
 * Returns the number of rows removed.
 */
export function pruneLogEntries(db: Db, retainDays: number): number {
  const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
  return db.run('DELETE FROM log_entries WHERE ts < @cutoff', { cutoff }).changes;
}

/**
 * `msg` is normally a string, but a caller can pass anything. Stringifying an object
 * with the default conversion would store the useless `[object Object]`.
 */
function coerceMessage(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    // Circular structures reach here; record that rather than dropping the entry.
    return '{"_error":"context could not be serialised"}';
  }
}
