import { join } from 'node:path';
import { PRODUCT_NAME } from '../shared/constants';
import { bootstrap, bootstrapLogger, installSignalHandlers, type Service } from './index';
import { createApp } from './web/app';
import { type AppContext } from './web/context';
import { AuthManager } from './web/auth';
import { EventBus } from './web/event-bus';
import { ensureCertificate, HttpsServerManager } from './web/https-setup';
import { ConflictResolver } from './locking/conflict-resolver';
import { LockManager } from './locking/lock-manager';
import { createShareCacheRootResolver } from './config/share-paths';
import { createBridgeMetrics } from './monitoring/registry';
import { JobRegistry } from './scheduling/jobs';
import { Scheduler } from './scheduling/scheduler';
import { AuditLog, installAuditGuards } from './security/audit-log';
import { BlobStore } from './versioning/blob-store';
import { VersionCleanup } from './versioning/cleanup';
import { VersionStore } from './versioning/version-store';

/**
 * Development/standalone entrypoint.
 *
 * `bootstrap()`/`index.ts` (T8) is deliberately left untouched by this file — every
 * default path it uses (`/var/lib/tnc-bridge`, `/var/log/tnc-bridge`, …) is a
 * production/systemd path, and its test suite proves the lifecycle contract against
 * those exact defaults. Wiring the still-in-progress HTTPS server (T27) into that
 * shared function would mean every one of those tests now also has to stand up a real
 * TLS listener on a real port, for no benefit to what they are actually proving.
 *
 * This file instead does the same bootstrap with dev-friendly local paths, adds the
 * managers `AppContext` needs, and serves `createApp()` over HTTPS on the port the
 * Vite dev proxy expects (`vite.config.ts` → `https://127.0.0.1:8443`). It is the
 * `npm run dev:backend` target — not something `index.ts`'s consumers (systemd, tests)
 * ever import.
 */

const DEV_ROOT = join(process.cwd(), '.dev-data');
const DEV_HTTPS_PORT = Number(process.env.TNC_DEV_PORT ?? 8443);

async function main(): Promise<void> {
  const boot = bootstrapLogger(false);

  const service: Service = await bootstrap({
    dbPath: join(DEV_ROOT, 'tnc-bridge.db'),
    logDir: join(DEV_ROOT, 'log'),
    secretKeyPath: join(DEV_ROOT, 'secret.key'),
  });

  const auth = new AuthManager({
    db: service.db,
    config: service.config,
    logger: service.logging.logger,
  });
  const locks = new LockManager({
    db: service.db,
    config: service.config,
    logger: service.logging.logger,
  });
  const conflicts = new ConflictResolver(service.db, service.logging.logger);
  const events = new EventBus();

  locks.onLockEvent(({ action, lock }) => {
    events.publish({ type: 'lock', ts: Date.now(), action, lock });
  });

  const certDir = join(DEV_ROOT, 'tls');
  const material = ensureCertificate(certDir);

  installAuditGuards(service.db);
  const audit = new AuditLog(service.db, service.logging.logger);
  const versions = new VersionStore({
    db: service.db,
    blobs: new BlobStore({ root: join(DEV_ROOT, 'versions') }),
    logger: service.logging.logger,
  });

  const cleanup = new VersionCleanup({
    versions,
    policy: () => service.config.get('versioning'),
    logger: service.logging.logger,
    audit,
  });

  // The scheduler knows *when*; the registry supplies *what*. A kind with no handler
  // registered is recorded as skipped rather than failing, so this list can grow
  // incrementally without the scheduler needing to know.
  const jobs = new JobRegistry().register('prune', cleanup.asJobHandler());

  const schedules = new Scheduler({
    db: service.db,
    jobs,
    logger: service.logging.logger,
    audit,
  });

  const ctx: AppContext = {
    db: service.db,
    config: service.config,
    auth,
    locks,
    conflicts,
    events,
    versions,
    schedules,
    metrics: createBridgeMetrics(),
    audit,
    shareCacheRoot: createShareCacheRootResolver(service.db),
    logger: service.logging.logger,
    certDir,
    version: process.env.npm_package_version ?? '0.0.0-dev',
    startedAt: Date.now(),
    now: () => Date.now(),
  };

  const app = createApp(ctx);
  const https = HttpsServerManager.create(app, {
    material,
    tlsMin: service.config.get('security').tlsMin,
  });
  ctx.httpsManager = https;

  const heartbeat = setInterval(() => {
    events.publish({ type: 'heartbeat', ts: Date.now() });
  }, 20_000);

  await https.listen(DEV_HTTPS_PORT);
  boot.info(`${PRODUCT_NAME} dev server listening`, {
    url: `https://127.0.0.1:${DEV_HTTPS_PORT}`,
    dataDir: DEV_ROOT,
  });

  installSignalHandlers(
    {
      shutdown: async (reason) => {
        clearInterval(heartbeat);
        await https.close();
        await service.shutdown(reason);
      },
    },
    { logger: boot, onComplete: () => process.exit(0) },
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${PRODUCT_NAME} dev server failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
