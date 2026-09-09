import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_DB_PATH, DEFAULT_LOG_DIR, bootstrap, type Service } from './index';
import { DEFAULT_SECRET_KEY_PATH } from './config/secrets';
import { createShareCacheRootResolver } from './config/share-paths';
import { ConflictResolver } from './locking/conflict-resolver';
import { LockManager } from './locking/lock-manager';
import { ScheduleLockWindowManager } from './locking/schedule-windows';
import { MetricsCollector } from './monitoring/collector';
import { createBridgeMetrics } from './monitoring/registry';
import { JobRegistry } from './scheduling/jobs';
import { Scheduler } from './scheduling/scheduler';
import { AuditLog, installAuditGuards } from './security/audit-log';
import { FirewallService } from './security/firewall-service';
import { BlobStore } from './versioning/blob-store';
import { VersionCleanup } from './versioning/cleanup';
import { VersionStore } from './versioning/version-store';
import { VersioningEngine } from './versioning/versioning-engine';
import { createApp } from './web/app';
import { AuthManager } from './web/auth';
import { type AppContext } from './web/context';
import { EventBus } from './web/event-bus';
import { DEFAULT_TLS_DIR, HttpsServerManager, ensureCertificate } from './web/https-setup';

/**
 * The composition root shared by the systemd service and the dev server.
 *
 * `bootstrap()` in `index.ts` deliberately stops at the subsystems that own no port and
 * no socket — database, logging, config — because its test suite proves the lifecycle
 * contract against exactly those, and standing up a real TLS listener inside each of
 * those tests would buy nothing. Everything above that line lives here instead: the
 * managers `AppContext` needs, the Express app, and the HTTPS server.
 *
 * Both entrypoints call this one function, so a bug fixed while developing is a bug
 * fixed in production. They differ only in the paths and the port they pass in, which is
 * the whole of the difference between the two environments.
 */

export interface ServerPaths {
  readonly dbPath: string;
  readonly logDir: string;
  readonly secretKeyPath: string;
  /** Holds `cert.pem`/`key.pem`/`chain.pem`; a self-signed pair is generated if absent. */
  readonly certDir: string;
  readonly blobRoot: string;
  /** Parent of every share's `cache_path` (`/srv/tnc/<name>`, see `001_init.sql`). */
  readonly cacheRoot: string;
}

/** Where the service keeps its state when systemd starts it. */
export const PRODUCTION_PATHS: ServerPaths = {
  dbPath: DEFAULT_DB_PATH,
  logDir: DEFAULT_LOG_DIR,
  secretKeyPath: DEFAULT_SECRET_KEY_PATH,
  certDir: DEFAULT_TLS_DIR,
  blobRoot: '/var/lib/tnc-bridge/versions',
  cacheRoot: '/srv/tnc',
};

/**
 * 443, because operators reach this appliance by typing a bare hostname into a browser.
 * Overridable through `TNC_HTTPS_PORT` for an instance that must not need
 * `CAP_NET_BIND_SERVICE`.
 */
export const DEFAULT_HTTPS_PORT = 443;

/** Built browser bundle, as `npm run build` lays it out (`dist/backend` → `dist/frontend`). */
export const STATIC_DIR = join(__dirname, '..', 'frontend');

/**
 * Reads the listen port from the environment.
 *
 * A bad value is a hard failure rather than a silent fall back to 443: an operator who
 * set `TNC_HTTPS_PORT=8443` and got 443 anyway would be told the service is healthy while
 * it sits on a port they deliberately avoided.
 */
export function portFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TNC_HTTPS_PORT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_HTTPS_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TNC_HTTPS_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

/** How often the metrics collector samples. */
const DEFAULT_METRICS_INTERVAL_MS = 10_000;

/**
 * Heartbeat on the SSE stream. Long enough not to matter on a Pi, short enough that a
 * proxy in between does not decide an idle connection is dead.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/** Metrics samples older than this are rolled up into hourly buckets. */
const METRICS_ROLLUP_AGE_S = 7 * 24 * 60 * 60;

export interface StartServerOptions {
  readonly paths?: Partial<ServerPaths>;
  readonly port?: number;
  readonly host?: string;
  /**
   * Directory holding the built browser bundle. Omitted by the dev server, where Vite
   * serves the frontend itself and proxies the API here.
   */
  readonly staticDir?: string;
  readonly quiet?: boolean;
  readonly metricsIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
}

export interface RunningServer {
  readonly service: Service;
  readonly context: AppContext;
  readonly https: HttpsServerManager;
  readonly port: number;
  /** Close the listener, drain, then tear every subsystem down in reverse order. */
  shutdown(reason?: string): Promise<void>;
}

/**
 * Reads the shipped version.
 *
 * `npm_package_version` exists only when npm is the parent process — true under
 * `npm run dev`, never under systemd. Falling back to the `package.json` beside `dist/`
 * is what keeps `/api/v1/status` from reporting a dev placeholder on a real appliance.
 */
export function readPackageVersion(root: string = join(__dirname, '..', '..')): string {
  const fromEnv = process.env.npm_package_version;
  if (fromEnv !== undefined && fromEnv !== '') {
    return fromEnv;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // An unreadable package.json must not stop the service from serving.
  }
  return '0.0.0-unknown';
}

/** Wires every subsystem, starts the HTTPS listener, and returns the running server. */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const paths: ServerPaths = { ...PRODUCTION_PATHS, ...options.paths };
  const port = options.port ?? DEFAULT_HTTPS_PORT;
  const startedAt = Date.now();

  const service = await bootstrap({
    dbPath: paths.dbPath,
    logDir: paths.logDir,
    secretKeyPath: paths.secretKeyPath,
    quiet: options.quiet ?? false,
  });

  // `bootstrap()` unwinds its own stages if one of them fails, but everything below is
  // outside its scope: a missing UI bundle or an unbindable port would otherwise leave
  // the database open and the log files held, and systemd's restart would then hit a
  // locked database rather than the original error.
  try {
    return await wire(service, { paths, port, startedAt, options });
  } catch (error) {
    await service.shutdown('failed-start');
    throw error;
  }
}

interface WireArgs {
  readonly paths: ServerPaths;
  readonly port: number;
  readonly startedAt: number;
  readonly options: StartServerOptions;
}

async function wire(service: Service, args: WireArgs): Promise<RunningServer> {
  const { paths, port, startedAt, options } = args;
  const logger = service.logging.logger;

  // Audit guards go on before any subsystem can write an audited row, so that startup
  // itself cannot slip a change past the append-only trigger.
  installAuditGuards(service.db);
  const audit = new AuditLog(service.db, logger);

  const auth = new AuthManager({ db: service.db, config: service.config, logger });
  const locks = new LockManager({ db: service.db, config: service.config, logger });
  const conflicts = new ConflictResolver(service.db, logger);
  const events = new EventBus();

  locks.onLockEvent(({ action, lock }) => {
    events.publish({ type: 'lock', ts: Date.now(), action, lock });
  });

  const versions = new VersionStore({
    db: service.db,
    blobs: new BlobStore({ root: paths.blobRoot }),
    logger,
  });

  // Constructed for its side effects; nothing else holds a reference to it.
  void new VersioningEngine({ store: versions, blobRoot: paths.blobRoot, logger });

  const cleanup = new VersionCleanup({
    versions,
    policy: () => service.config.get('versioning'),
    logger,
    audit,
  });

  // The scheduler knows *when*; the registry supplies *what*. A kind with no handler
  // registered is recorded as skipped rather than failing, so this list can grow
  // incrementally without the scheduler needing to know.
  const jobs = new JobRegistry().register('prune', cleanup.asJobHandler());
  const schedules = new Scheduler({ db: service.db, jobs, logger, audit });

  new ScheduleLockWindowManager({ db: service.db, locks, scheduler: schedules, logger });

  const metrics = createBridgeMetrics();
  const collector = new MetricsCollector({
    db: service.db,
    metrics,
    cachePath: paths.cacheRoot,
    logger,
    startedAt,
  });
  collector.start(options.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS);

  jobs.register('prune', () => {
    const result = collector.rollUp(METRICS_ROLLUP_AGE_S);
    return {
      detail: `rolled up ${result.rolledUp} samples, deleted ${result.deleted} old samples`,
    };
  });

  // Everything from here can fail — an unreadable certificate, a missing UI bundle, a
  // port already taken — and the collector's timer is already running. Cleanup is
  // collected in one list so that a step added later cannot be forgotten by a `catch`
  // three screens further down.
  const started: (() => void)[] = [() => collector.stop()];
  const undoStarted = (): void => {
    while (started.length > 0) {
      started.pop()?.();
    }
  };

  try {
    // Before the listener opens: the management interface must never be reachable from
    // the machine segment, not even for the seconds between binding and the first
    // config save. See security/firewall.ts for why this is enforced twice.
    const firewall = new FirewallService({ logger });
    firewall.apply(service.config.get('network').tnc.interface);
    // The rule names an interface, so moving the TNC side to another NIC has to reload
    // it — otherwise the drop points at a NIC nothing arrives on, and the admin UI is
    // quietly reachable from the machine segment again.
    service.config.onSectionChange('network', () => {
      firewall.apply(service.config.get('network').tnc.interface);
    });

    const material = ensureCertificate(paths.certDir);

    const context: AppContext = {
      db: service.db,
      config: service.config,
      auth,
      locks,
      conflicts,
      events,
      versions,
      schedules,
      metrics,
      audit,
      shareCacheRoot: createShareCacheRootResolver(service.db),
      logger,
      certDir: paths.certDir,
      version: readPackageVersion(),
      startedAt,
      now: () => Date.now(),
    };

    const app = createApp(
      context,
      options.staticDir === undefined ? {} : { staticDir: options.staticDir },
    );
    const https = HttpsServerManager.create(app, {
      material,
      tlsMin: service.config.get('security').tlsMin,
    });
    context.httpsManager = https;

    const heartbeat = setInterval(() => {
      events.publish({ type: 'heartbeat', ts: Date.now() });
    }, options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
    // The listener is what keeps the process alive; a heartbeat timer must never be the
    // reason a shut-down server refuses to exit.
    heartbeat.unref();
    started.push(() => clearInterval(heartbeat));

    await https.listen(port, options.host);

    let stopped = false;
    return {
      service,
      context,
      https,
      port,
      shutdown: async (reason = 'shutdown') => {
        if (stopped) {
          return;
        }
        stopped = true;
        undoStarted();
        // Close the listener before draining: draining while still accepting new work is
        // a drain that never finishes on a busy bridge.
        await https.close();
        await service.shutdown(reason);
      },
    };
  } catch (error) {
    undoStarted();
    throw error;
  }
}
