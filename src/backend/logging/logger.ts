import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger, type StreamEntry } from 'pino';
import { type LogLevel, type LogSource } from '../../shared';
import { redactSecrets } from '../config/config-manager';
import { type Db } from '../config/db';
import { AuthLogWriter } from './auth-log';
import { RotatingFileSink } from './rotating-file-sink';
import { SqliteLogSink } from './sqlite-sink';

/**
 * The logging system (T6).
 *
 * Four sinks, each with a distinct consumer:
 *
 * - **stdout** — captured by journald, so `journalctl -u tnc-bridge` works the way an
 *   administrator expects without the service knowing anything about journald.
 * - **app.log** — the full rotating JSON record, for after-the-fact analysis and for
 *   attaching to a support ticket.
 * - **sync.log** — the sync subsystem only, because that is the stream an operator
 *   actually reads when a program did not arrive at a machine, and it should not be
 *   buried under HTTP and metrics noise.
 * - **SQLite** — queryable by the UI log viewer.
 *
 * `auth.log` is deliberately *not* one of these. It is plaintext for Fail2Ban rather
 * than JSON for us, so it is written by {@link AuthLogWriter} instead of being a pino
 * stream. Authentication events are also logged normally, through the `auth` child.
 */

interface CorrelationContext {
  readonly requestId: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/**
 * Runs `fn` with a correlation id attached to every log line it produces, however
 * deep the call stack or how many awaits it crosses. This is what makes a single
 * failing API request traceable through the sync engine and back.
 */
export function withCorrelationId<T>(requestId: string, fn: () => T): T {
  return correlationStorage.run({ requestId }, fn);
}

export function currentRequestId(): string | undefined {
  return correlationStorage.getStore()?.requestId;
}

export function newRequestId(): string {
  return randomUUID();
}

/** Forwards only the NDJSON lines whose `source` matches. */
class SourceFilterStream extends Writable {
  constructor(
    private readonly target: Writable,
    private readonly sources: ReadonlySet<string>,
  ) {
    super({ decodeStrings: false });
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { source?: unknown };
        if (typeof parsed.source === 'string' && this.sources.has(parsed.source)) {
          this.target.write(`${line}\n`);
        }
      } catch {
        // Not our JSON; ignore rather than forwarding noise into a filtered stream.
      }
    }
    callback();
  }
}

export interface LoggingOptions {
  readonly level?: LogLevel;
  /** Directory for app.log, sync.log and auth.log. */
  readonly logDir: string;
  /** Enables the SQLite sink behind the UI log viewer. */
  readonly db?: Db;
  /** Write to stdout for journald. Disabled in tests to keep output readable. */
  readonly stdout?: boolean;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Overrides the default `<logDir>/auth.log`. */
  readonly authLogPath?: string;
}

export interface LoggingSystem {
  /** Root logger. Prefer a subsystem child over logging through this directly. */
  readonly logger: Logger;
  /** A logger tagged with its subsystem, which is also what routes sync.log. */
  child(source: LogSource, bindings?: Record<string, unknown>): Logger;
  readonly authLog: AuthLogWriter;
  setLevel(level: LogLevel): void;
  /** Forces rotation. Used by tests and by the nightly maintenance job. */
  rotate(): void;
  close(): void;
  readonly sinks: {
    readonly app: RotatingFileSink;
    readonly sync: RotatingFileSink;
    readonly sqlite: SqliteLogSink | undefined;
  };
}

export function createLogging(options: LoggingOptions): LoggingSystem {
  const level: LogLevel = options.level ?? 'info';

  const appSink = new RotatingFileSink({
    path: join(options.logDir, 'app.log'),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
  const syncSink = new RotatingFileSink({
    path: join(options.logDir, 'sync.log'),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });

  const sqliteSink = options.db === undefined ? undefined : new SqliteLogSink({ db: options.db });

  const streams: StreamEntry[] = [
    { level, stream: appSink },
    { level, stream: new SourceFilterStream(syncSink, new Set(['sync'])) },
  ];
  if (options.stdout !== false) {
    streams.push({ level, stream: process.stdout });
  }
  if (sqliteSink !== undefined) {
    streams.push({ level, stream: sqliteSink });
  }

  const logger = pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.epochTime,
      /**
       * Path-based redaction for the well-known carriers of credentials. This is the
       * fast path; `formatters.log` below is the backstop for anything nested where
       * we did not anticipate it.
       */
      redact: {
        paths: [
          'password',
          '*.password',
          'credentials',
          '*.credentials',
          'secret',
          '*.secret',
          'token',
          '*.token',
          'apiKey',
          '*.apiKey',
          'authorization',
          'req.headers.authorization',
          'req.headers.cookie',
          'headers.authorization',
          'headers.cookie',
        ],
        censor: '********',
      },
      formatters: {
        /**
         * Deep redaction of every logged object.
         *
         * pino's `redact` only covers the paths it is given. A credential nested
         * somewhere unanticipated — inside a mount options object, an error's
         * captured context — would otherwise reach four sinks at once, one of which
         * is a file that gets attached to support tickets. The walk costs a little
         * per call; at this system's log volume that is not a trade worth agonising over.
         */
        log: (object) => redactSecrets(object),
      },
      /** Attaches the ambient correlation id, if the call is inside a request scope. */
      mixin: () => {
        const requestId = currentRequestId();
        return requestId === undefined ? {} : { requestId };
      },
    },
    pino.multistream(streams, { levels: pino.levels.values }),
  );

  const authLog = new AuthLogWriter(options.authLogPath ?? join(options.logDir, 'auth.log'));

  return {
    logger,
    child: (source, bindings) => logger.child({ source, ...bindings }),
    authLog,
    setLevel: (newLevel) => {
      logger.level = newLevel;
    },
    rotate: () => {
      appSink.rotate();
      syncSink.rotate();
    },
    close: () => {
      appSink.closeSink();
      syncSink.closeSink();
    },
    sinks: { app: appSink, sync: syncSink, sqlite: sqliteSink },
  };
}
