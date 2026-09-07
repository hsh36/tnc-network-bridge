import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { PRODUCT_NAME } from '../shared/constants';

import { ConfigManager } from './config/config-manager';
import { Db } from './config/db';
import { runMigrations } from './config/migrations/runner';
import { DEFAULT_SECRET_KEY_PATH, loadSecretKey } from './config/secrets';
import { createLogging, type LoggingSystem } from './logging/logger';
import { DrainRegistry } from './lifecycle/drain';
import { Lifecycle, type LifecycleLogger, silentLogger } from './lifecycle/lifecycle';
import {
  createNotifier,
  type Notifier,
  Watchdog,
  watchdogIntervalFromEnv,
} from './lifecycle/watchdog';

/**
 * Service entrypoint.
 *
 * The order below is a dependency order, not a preference:
 *
 *  1. **Secret key** — before anything that might need to decrypt a stored credential.
 *  2. **Database** — everything else persists through it.
 *  3. **Migrations** — the schema must match the code before any subsystem reads a row.
 *  4. **Logging** — the SQLite sink needs an open database, so logging cannot come first.
 *     Startup before this point logs through a bootstrap logger writing to stderr only.
 *  5. **Config** — reads defaults into the database and becomes the source of truth.
 *  6. **Watchdog** — last, because pinging systemd before the service can actually serve
 *     would tell it we are ready when we are not.
 *
 * Shutdown is the exact reverse, with a drain in front of it: stop accepting work, let
 * in-flight transfers finish, then tear down. Phase 1 subsystems (sync, SMB, locking,
 * the HTTPS server) register themselves as stages between config and the watchdog.
 */

export const DEFAULT_DB_PATH = '/var/lib/tnc-bridge/tnc-bridge.db';
export const DEFAULT_LOG_DIR = '/var/log/tnc-bridge';

/** systemd's default `TimeoutStopSec` is 90 s; finish well inside it. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 20_000;

export interface BootstrapOptions {
  readonly dbPath?: string;
  readonly logDir?: string;
  readonly secretKeyPath?: string;
  readonly drainTimeoutMs?: number;
  readonly notifier?: Notifier;
  readonly env?: NodeJS.ProcessEnv;
  /** Suppress stdout logging. Set by `--check` and by tests. */
  readonly quiet?: boolean;
}

export interface Service {
  readonly lifecycle: Lifecycle;
  readonly drain: DrainRegistry;
  readonly logging: LoggingSystem;
  readonly db: Db;
  readonly config: ConfigManager;
  readonly watchdog: Watchdog | undefined;
  readonly notifier: Notifier;
  /** Drain, then stop every started stage in reverse order. Idempotent. */
  shutdown(reason?: string): Promise<void>;
}

/** Writes to stderr only — used before the logging subsystem exists. */
export function bootstrapLogger(quiet: boolean): LifecycleLogger {
  if (quiet) {
    return silentLogger;
  }
  const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
    const suffix = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
    process.stderr.write(`[${level}] ${message}${suffix}\n`);
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/**
 * Wires and starts every subsystem.
 *
 * Returns only once everything is up. If any stage fails, the ones already started are
 * stopped before the error propagates, so a caller never receives a half-built service.
 */
export async function bootstrap(options: BootstrapOptions = {}): Promise<Service> {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const logDir = options.logDir ?? DEFAULT_LOG_DIR;
  const quiet = options.quiet ?? false;
  const notifier = options.notifier ?? createNotifier(env);
  const boot = bootstrapLogger(quiet);

  const lifecycle = new Lifecycle({ logger: boot });
  const drain = new DrainRegistry({ logger: boot });

  // Assigned by the stages below. Not readonly, because a stage's whole job is to bring
  // one of these into existence in the right order.
  let secretKey: Buffer | undefined;
  let db: Db | undefined;
  let logging: LoggingSystem | undefined;
  let config: ConfigManager | undefined;
  let watchdog: Watchdog | undefined;

  lifecycle.register({
    name: 'secret-key',
    start: () => {
      secretKey = loadSecretKey(options.secretKeyPath ?? DEFAULT_SECRET_KEY_PATH);
    },
  });

  lifecycle.register({
    name: 'database',
    start: () => {
      if (dbPath !== ':memory:') {
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o750 });
      }
      db = Db.open({ path: dbPath });
    },
    stop: () => {
      // Checkpoint before closing: an un-checkpointed WAL leaves the last writes only in
      // `-wal`, which recovers fine but makes a cold backup of the `.db` file silently
      // stale — and backups of this database are taken by copying the file.
      db?.checkpoint('TRUNCATE');
      db?.close();
    },
  });

  lifecycle.register({
    name: 'migrations',
    start: () => {
      runMigrations(assertPresent(db, 'database'));
    },
  });

  lifecycle.register({
    name: 'logging',
    start: () => {
      mkdirSync(logDir, { recursive: true, mode: 0o750 });
      logging = createLogging({ logDir, db: assertPresent(db, 'database'), stdout: !quiet });
    },
    stop: () => {
      logging?.close();
    },
  });

  lifecycle.register({
    name: 'config',
    start: () => {
      config = ConfigManager.create({
        db: assertPresent(db, 'database'),
        secretKey: assertPresent(secretKey, 'secret-key'),
      });
    },
  });

  lifecycle.register({
    name: 'watchdog',
    start: () => {
      const intervalMs = watchdogIntervalFromEnv(env);
      if (intervalMs === undefined) {
        // No WATCHDOG_USEC means the unit has no WatchdogSec, or we are not under
        // systemd at all. Running a pointless timer would only add wakeups on a Pi.
        return;
      }
      watchdog = new Watchdog({
        notifier,
        intervalMs,
        logger: { warn: (message, fields) => boot.warn(message, fields) },
      });
      watchdog.start();
    },
    stop: () => {
      watchdog?.stop();
    },
  });

  await lifecycle.start();

  notifier.ready();
  notifier.status(`${PRODUCT_NAME} running`);

  const service: Service = {
    lifecycle,
    drain,
    logging: assertPresent(logging, 'logging'),
    db: assertPresent(db, 'database'),
    config: assertPresent(config, 'config'),
    watchdog,
    notifier,
    shutdown: async (reason = 'shutdown') => {
      notifier.stopping();
      notifier.status('draining in-flight operations');
      // Stop the watchdog before draining: a long but legitimate drain must not be
      // mistaken by systemd for a hang and turned into a SIGKILL mid-transfer.
      watchdog?.stop();
      const result = await drain.drain(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
      if (!result.drained) {
        boot.warn('shutting down with operations still running', { remaining: result.remaining });
      }
      await lifecycle.stop(reason);
    },
  };

  return service;
}

function assertPresent<T>(value: T | undefined, stage: string): T {
  if (value === undefined) {
    throw new Error(`internal error: stage "${stage}" did not produce a value`);
  }
  return value;
}

export type SignalName = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
export const SHUTDOWN_SIGNALS: readonly SignalName[] = ['SIGTERM', 'SIGINT'];

export interface SignalTarget {
  on(signal: string, handler: () => void): unknown;
  off?(signal: string, handler: () => void): unknown;
}

/**
 * Installs shutdown handlers and returns a function that removes them.
 *
 * A second signal is ignored rather than escalated. An impatient operator pressing
 * Ctrl+C twice would otherwise abort a drain that was seconds from finishing, producing
 * exactly the orphaned temp file the drain exists to avoid. systemd's `TimeoutStopSec`
 * remains the real escape hatch.
 */
export function installSignalHandlers(
  service: Pick<Service, 'shutdown'>,
  options: {
    readonly signals?: readonly SignalName[];
    readonly target?: SignalTarget;
    readonly onComplete?: (signal: SignalName) => void;
    readonly logger?: LifecycleLogger;
  } = {},
): () => void {
  const target = options.target ?? process;
  const signals = options.signals ?? SHUTDOWN_SIGNALS;
  const logger = options.logger ?? silentLogger;
  let shuttingDown = false;

  const handlers = signals.map((signal) => {
    const handler = (): void => {
      if (shuttingDown) {
        logger.info('shutdown already in progress; ignoring repeat signal', { signal });
        return;
      }
      shuttingDown = true;
      void service
        .shutdown(signal)
        .catch((error: unknown) => {
          logger.error('shutdown failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => options.onComplete?.(signal));
    };
    target.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) {
      target.off?.(signal, handler);
    }
  };
}

export interface CheckResult {
  readonly ok: boolean;
  readonly checks: readonly { name: string; ok: boolean; detail: string }[];
}

/**
 * `--check`: start everything, verify it, shut it down, report.
 *
 * This exists so an installer or an operator can find out that the secret key is
 * unreadable or the schema is behind *before* systemd starts flapping the unit. It runs
 * the real startup path rather than a simulation of it, because a self-test that checks
 * different things from the ones startup does is a self-test that passes while the
 * service will not start.
 */
export async function selfCheck(options: BootstrapOptions = {}): Promise<CheckResult> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let service: Service | undefined;

  try {
    service = await bootstrap({ ...options, quiet: true });
    checks.push({ name: 'startup', ok: true, detail: 'all subsystems started' });

    const integrity = service.db.integrityCheck();
    checks.push({
      name: 'database',
      ok: integrity.ok,
      detail: integrity.ok ? 'integrity check passed' : integrity.problems.join('; '),
    });

    const schema = service.db.get<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    checks.push({
      name: 'schema',
      ok: (schema?.version ?? 0) > 0,
      detail: `schema version ${schema?.version ?? 0}`,
    });

    checks.push({
      name: 'config',
      ok: true,
      detail: `${Object.keys(service.config.getAll()).length} setting groups loaded`,
    });
  } catch (error) {
    checks.push({
      name: 'startup',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await service?.shutdown('self-check');
  }

  return { ok: checks.every((check) => check.ok), checks };
}

/* c8 ignore start -- process bootstrap; exercised by running the service. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--check')) {
    const result = await selfCheck();
    for (const check of result.checks) {
      process.stdout.write(
        `${result.ok && check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`,
      );
    }
    return result.ok ? 0 : 1;
  }

  const service = await bootstrap();
  installSignalHandlers(service, {
    logger: bootstrapLogger(false),
    onComplete: () => {
      process.exitCode = 0;
    },
  });
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => {
      if (code !== 0) {
        process.exitCode = code;
      }
    },
    (error: unknown) => {
      process.stderr.write(`${PRODUCT_NAME} failed to start: ${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
/* c8 ignore stop */
